const TELEMETRY_ENDPOINT = 'https://webdatascope-telemetry.zkhweb.workers.dev/v1/registrations';
const SUMMARY_ENDPOINT = 'https://api.worldquantbrain.com/users/self/consultant/summary';
const STORAGE_KEY = 'WQP_VersionRegistrationStateV1';
const RETRY_ALARM = 'WQP_VersionRegistrationRetry';
const STATE_SCHEMA_VERSION = 1;
const IDENTITY_CHECK_THROTTLE_MS = 30 * 1000;
const BACKOFF_MS = [15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const MAX_REPORT_MARKERS = 300;

let defaultController = null;

export function initTelemetryService() {
    if (defaultController) return defaultController;
    defaultController = createTelemetryController();
    defaultController.init();
    return defaultController;
}

export function createTelemetryController(dependencies = {}) {
    const chromeApi = dependencies.chromeApi || globalThis.chrome;
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch.bind(globalThis);
    const now = dependencies.now || (() => Date.now());
    const cryptoApi = dependencies.cryptoApi || globalThis.crypto;
    let activeAttempt = null;
    let lastTabAttemptAt = 0;
    let initialized = false;

    function init() {
        if (initialized) return;
        initialized = true;

        chromeApi.runtime.onInstalled.addListener((details) => {
            void handleInstalled(details);
        });
        chromeApi.runtime.onStartup.addListener(() => {
            void handleStartup();
        });
        chromeApi.alarms.onAlarm.addListener((alarm) => {
            if (alarm?.name === RETRY_ALARM) void attemptRegistration('alarm');
        });
        chromeApi.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
            if (changeInfo?.status !== 'complete' || !isPlatformUrl(tab?.url)) return;
            void handlePlatformReady();
        });

        void bootstrap();
    }

    async function bootstrap() {
        const state = await loadState();
        if (!state.pending) return;
        if (state.pending.nextRetryAt > now()) {
            await scheduleRetryAlarm(state.pending.nextRetryAt);
            return;
        }
        await attemptRegistration('bootstrap');
    }

    async function handleInstalled(details = {}) {
        const state = await loadState();
        const reason = details.reason === 'install' ? 'install' : 'update';
        state.pending = {
            originalReason: reason,
            previousVersion: normalizeVersion(details.previousVersion),
            retryCount: 0,
            nextRetryAt: 0,
            lastStatus: null,
            lastFailureStage: '',
        };
        state.lastManifestVersion = getCurrentVersion();
        state.terminalFailure = null;
        await saveState(state);
        return attemptRegistration('installed');
    }

    async function handleStartup() {
        return attemptRegistration('startup');
    }

    async function handlePlatformReady() {
        const timestamp = now();
        if (timestamp - lastTabAttemptAt < IDENTITY_CHECK_THROTTLE_MS) return null;
        lastTabAttemptAt = timestamp;

        const state = await loadState();
        if (!state.pending && timestamp - state.lastIdentityCheckAt < IDENTITY_CHECK_THROTTLE_MS) return null;
        return attemptRegistration('platform-ready');
    }

    async function attemptRegistration(trigger = 'retry') {
        if (activeAttempt) return activeAttempt;
        activeAttempt = performRegistration(trigger).finally(() => {
            activeAttempt = null;
        });
        return activeAttempt;
    }

    async function performRegistration(trigger) {
        const state = await loadState();
        const timestamp = now();
        const mayRetryAfterLogin = trigger === 'platform-ready'
            && (state.pending?.lastStatus === 401 || ['offline', 'summary_network'].includes(state.pending?.lastFailureStage));
        if (state.pending?.nextRetryAt > timestamp && trigger !== 'installed' && !mayRetryAfterLogin) {
            await scheduleRetryAlarm(state.pending.nextRetryAt);
            return { status: 'waiting' };
        }

        if (globalThis.navigator && globalThis.navigator.onLine === false) {
            await retainPendingAndSchedule(state, { stage: 'offline' });
            return { status: 'retry_scheduled', stage: 'offline' };
        }

        let summaryResponse;
        try {
            summaryResponse = await fetchImpl(SUMMARY_ENDPOINT, {
                method: 'GET',
                credentials: 'include',
                cache: 'no-store',
                headers: { Accept: 'application/json' },
            });
        } catch {
            await retainPendingAndSchedule(state, { stage: 'summary_network' });
            return { status: 'retry_scheduled', stage: 'summary_network' };
        }

        if (!summaryResponse.ok) {
            await retainPendingAndSchedule(state, {
                stage: 'summary_http',
                status: summaryResponse.status,
                retryAfterMs: summaryResponse.status === 429
                    ? parseRetryAfter(summaryResponse.headers.get('Retry-After'), timestamp)
                    : null,
            });
            return { status: 'retry_scheduled', stage: 'summary_http' };
        }

        let identity;
        try {
            identity = parseSummaryIdentity(await summaryResponse.json());
        } catch {
            await retainPendingAndSchedule(state, { stage: 'summary_payload' });
            return { status: 'retry_scheduled', stage: 'summary_payload' };
        }

        const accountFingerprint = await sha256Hex(identity.wqId, cryptoApi);
        const currentVersion = getCurrentVersion();
        const reportKey = makeReportKey(state.installationId, accountFingerprint, currentVersion);
        state.lastIdentityCheckAt = timestamp;
        state.lastAccountFingerprint = accountFingerprint;

        if (state.reports[reportKey]) {
            state.pending = null;
            state.terminalFailure = null;
            await saveState(state);
            await clearRetryAlarm();
            return { status: 'already_registered' };
        }

        const pending = state.pending || {
            originalReason: 'retry',
            previousVersion: null,
            retryCount: 0,
            nextRetryAt: 0,
            lastStatus: null,
            lastFailureStage: '',
        };
        const payload = buildRegistrationPayload({
            installationId: state.installationId,
            wqId: identity.wqId,
            country: identity.country,
            version: currentVersion,
            previousVersion: pending.previousVersion,
            reason: pending.retryCount > 0 ? 'retry' : pending.originalReason,
        });

        let registrationResponse;
        try {
            registrationResponse = await fetchImpl(TELEMETRY_ENDPOINT, {
                method: 'POST',
                credentials: 'omit',
                cache: 'no-store',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });
        } catch {
            state.pending = pending;
            await retainPendingAndSchedule(state, { stage: 'registration_network' });
            return { status: 'retry_scheduled', stage: 'registration_network' };
        }

        if (registrationResponse.ok) {
            let confirmation;
            try {
                confirmation = await registrationResponse.json();
            } catch {
                confirmation = null;
            }
            if (confirmation?.ok === true && confirmation.schemaVersion === 1) {
                state.reports[reportKey] = new Date(timestamp).toISOString();
                state.reports = trimReportMarkers(state.reports);
                state.pending = null;
                state.terminalFailure = null;
                state.lastManifestVersion = currentVersion;
                await saveState(state);
                await clearRetryAlarm();
                return { status: 'registered', created: confirmation.created === true };
            }
        }

        if (registrationResponse.status >= 400 && registrationResponse.status < 500 && registrationResponse.status !== 429) {
            state.pending = null;
            state.terminalFailure = {
                status: registrationResponse.status,
                at: new Date(timestamp).toISOString(),
            };
            await saveState(state);
            await clearRetryAlarm();
            return { status: 'terminal_failure', httpStatus: registrationResponse.status };
        }

        state.pending = pending;
        await retainPendingAndSchedule(state, {
            stage: 'registration_http',
            status: registrationResponse.status,
            retryAfterMs: registrationResponse.status === 429
                ? parseRetryAfter(registrationResponse.headers.get('Retry-After'), timestamp)
                : null,
        });
        return { status: 'retry_scheduled', stage: 'registration_http' };
    }

    async function retainPendingAndSchedule(state, failure = {}) {
        const currentVersion = getCurrentVersion();
        const pending = state.pending || {
            originalReason: state.lastManifestVersion && state.lastManifestVersion !== currentVersion ? 'update' : 'retry',
            previousVersion: state.lastManifestVersion && state.lastManifestVersion !== currentVersion
                ? state.lastManifestVersion
                : null,
            retryCount: 0,
            nextRetryAt: 0,
            lastStatus: null,
            lastFailureStage: '',
        };
        pending.retryCount = Math.max(0, Number(pending.retryCount) || 0) + 1;
        const fallbackDelay = backoffForAttempt(pending.retryCount);
        const retryDelay = Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs > 0
            ? Math.min(24 * 60 * 60 * 1000, Math.max(15 * 1000, failure.retryAfterMs))
            : fallbackDelay;
        pending.nextRetryAt = now() + retryDelay;
        pending.lastStatus = Number.isInteger(failure.status) ? failure.status : null;
        pending.lastFailureStage = String(failure.stage || 'unknown');
        state.pending = pending;
        state.lastManifestVersion = currentVersion;
        await saveState(state);
        await scheduleRetryAlarm(pending.nextRetryAt);
    }

    async function loadState() {
        const stored = await storageGet(STORAGE_KEY);
        const currentVersion = getCurrentVersion();
        const state = normalizeState(stored, currentVersion, cryptoApi);
        if (state !== stored) await saveState(state);
        return state;
    }

    function saveState(state) {
        return storageSet(STORAGE_KEY, state);
    }

    function storageGet(key) {
        return new Promise((resolve, reject) => {
            chromeApi.storage.local.get(key, (items) => {
                const error = chromeApi.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve(items?.[key]);
            });
        });
    }

    function storageSet(key, value) {
        return new Promise((resolve, reject) => {
            chromeApi.storage.local.set({ [key]: value }, () => {
                const error = chromeApi.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve();
            });
        });
    }

    async function scheduleRetryAlarm(when) {
        if (!chromeApi.alarms?.create) return;
        await clearRetryAlarm();
        chromeApi.alarms.create(RETRY_ALARM, { when: Math.max(now() + 1000, Number(when) || now() + 1000) });
    }

    function clearRetryAlarm() {
        if (!chromeApi.alarms?.clear) return Promise.resolve();
        return new Promise((resolve) => {
            chromeApi.alarms.clear(RETRY_ALARM, () => resolve());
        });
    }

    function getCurrentVersion() {
        return String(chromeApi.runtime.getManifest().version || '0.0.0');
    }

    return {
        init,
        bootstrap,
        handleInstalled,
        handleStartup,
        handlePlatformReady,
        attemptRegistration,
    };
}

export function parseSummaryIdentity(summary) {
    const rawWqId = summary?.leaderboard?.user;
    const wqId = rawWqId == null ? '' : String(rawWqId).trim();
    if (!wqId || wqId.length > 128) throw new Error('WorldQuant account ID is unavailable.');
    const rawCountry = summary?.leaderboard?.country;
    const candidateCountry = rawCountry == null ? '' : String(rawCountry).trim().toUpperCase();
    const country = /^(?:UNKNOWN|[A-Z][A-Z0-9_-]{1,15})$/.test(candidateCountry)
        ? candidateCountry
        : 'UNKNOWN';
    return { wqId, country };
}

export function buildRegistrationPayload(value) {
    return {
        schemaVersion: 1,
        installationId: String(value.installationId),
        wqId: String(value.wqId),
        country: value.country ? String(value.country) : 'UNKNOWN',
        version: String(value.version),
        previousVersion: normalizeVersion(value.previousVersion),
        reason: ['install', 'update', 'retry'].includes(value.reason) ? value.reason : 'retry',
    };
}

export function backoffForAttempt(attempt) {
    const index = Math.min(BACKOFF_MS.length - 1, Math.max(0, Number(attempt || 1) - 1));
    return BACKOFF_MS[index];
}

export function parseRetryAfter(value, timestamp = Date.now()) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - timestamp) : null;
}

function normalizeState(value, currentVersion, cryptoApi) {
    if (value && typeof value === 'object' && value.schemaVersion === STATE_SCHEMA_VERSION && isUuid(value.installationId)) {
        return {
            schemaVersion: STATE_SCHEMA_VERSION,
            installationId: value.installationId,
            reports: value.reports && typeof value.reports === 'object' && !Array.isArray(value.reports) ? value.reports : {},
            pending: value.pending && typeof value.pending === 'object' ? value.pending : null,
            terminalFailure: value.terminalFailure && typeof value.terminalFailure === 'object' ? value.terminalFailure : null,
            lastManifestVersion: normalizeVersion(value.lastManifestVersion) || currentVersion,
            lastIdentityCheckAt: Number(value.lastIdentityCheckAt) || 0,
            lastAccountFingerprint: typeof value.lastAccountFingerprint === 'string' ? value.lastAccountFingerprint : '',
        };
    }
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        installationId: createInstallationId(cryptoApi),
        reports: {},
        pending: null,
        terminalFailure: null,
        lastManifestVersion: currentVersion,
        lastIdentityCheckAt: 0,
        lastAccountFingerprint: '',
    };
}

function createInstallationId(cryptoApi) {
    if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeReportKey(installationId, accountFingerprint, version) {
    return `${installationId}:${accountFingerprint}:${version}`;
}

function trimReportMarkers(reports) {
    const entries = Object.entries(reports);
    if (entries.length <= MAX_REPORT_MARKERS) return reports;
    return Object.fromEntries(entries
        .sort((left, right) => String(right[1]).localeCompare(String(left[1])))
        .slice(0, MAX_REPORT_MARKERS));
}

async function sha256Hex(value, cryptoApi) {
    const bytes = new TextEncoder().encode(value);
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeVersion(value) {
    if (value == null) return null;
    const version = String(value).trim();
    return /^\d{1,5}(?:\.\d{1,5}){1,3}$/.test(version) ? version : null;
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function isPlatformUrl(value) {
    try {
        return new URL(String(value || '')).hostname === 'platform.worldquantbrain.com';
    } catch {
        return false;
    }
}

export const TELEMETRY_CONSTANTS = Object.freeze({
    TELEMETRY_ENDPOINT,
    SUMMARY_ENDPOINT,
    STORAGE_KEY,
    RETRY_ALARM,
    BACKOFF_MS: [...BACKOFF_MS],
});
