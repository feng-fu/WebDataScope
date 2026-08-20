import assert from 'node:assert/strict';
import test from 'node:test';
import {
    TELEMETRY_CONSTANTS,
    backoffForAttempt,
    createTelemetryController,
    parseRetryAfter,
    parseSummaryIdentity,
} from '../src/background/services/telemetryService.js';

function createChromeMock(version = '1.3.0') {
    const memory = {};
    const alarms = [];
    const makeEvent = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); } });
    return {
        memory,
        alarms,
        runtime: {
            lastError: null,
            getManifest: () => ({ version }),
            onInstalled: makeEvent(),
            onStartup: makeEvent(),
        },
        tabs: { onUpdated: makeEvent() },
        alarms: {
            created: alarms,
            onAlarm: makeEvent(),
            create(name, details) { alarms.push({ name, ...details }); },
            clear(_name, callback) { callback(true); },
        },
        storage: {
            local: {
                get(key, callback) { callback({ [key]: memory[key] }); },
                set(values, callback) { Object.assign(memory, structuredClone(values)); callback(); },
            },
        },
    };
}

function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function summary(wqId = 'WQ-100', country = 'CN') {
    return jsonResponse({ leaderboard: { user: wqId, country } });
}

function confirmation(created = true) {
    return jsonResponse({ ok: true, created, schemaVersion: 1 }, created ? 201 : 200);
}

test('install registration sends only declared fields and never sends WQ cookies to Worker', async () => {
    const chromeApi = createChromeMock();
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1 ? summary('PRIVATE-WQ-100', 'cn') : confirmation(true);
    };
    const controller = createTelemetryController({ chromeApi, fetchImpl, now: () => 1_800_000_000_000 });
    const result = await controller.handleInstalled({ reason: 'install' });

    assert.deepEqual(result, { status: 'registered', created: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, TELEMETRY_CONSTANTS.SUMMARY_ENDPOINT);
    assert.equal(calls[0].options.credentials, 'include');
    assert.equal(calls[1].url, TELEMETRY_CONSTANTS.TELEMETRY_ENDPOINT);
    assert.equal(calls[1].options.credentials, 'omit');
    assert.equal(calls[1].options.referrerPolicy, 'no-referrer');

    const payload = JSON.parse(calls[1].options.body);
    assert.deepEqual(Object.keys(payload).sort(), [
        'country', 'installationId', 'previousVersion', 'reason', 'schemaVersion', 'version', 'wqId',
    ]);
    assert.equal(payload.reason, 'install');
    assert.equal(payload.previousVersion, null);
    assert.equal(payload.country, 'CN');
    assert.equal(JSON.stringify(chromeApi.memory).includes('PRIVATE-WQ-100'), false);
    assert.match(JSON.stringify(chromeApi.memory), /[0-9a-f]{64}/);
});

test('successful marker prevents duplicate upload and account switch creates a separate record', async () => {
    const chromeApi = createChromeMock();
    let activeWqId = 'WQ-A';
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return url === TELEMETRY_CONSTANTS.SUMMARY_ENDPOINT ? summary(activeWqId, 'US') : confirmation(true);
    };
    const controller = createTelemetryController({ chromeApi, fetchImpl, now: () => 1_800_000_000_000 });

    await controller.handleInstalled({ reason: 'update', previousVersion: '1.2.2' });
    assert.equal(calls.filter((call) => call.url === TELEMETRY_CONSTANTS.TELEMETRY_ENDPOINT).length, 1);
    const updatePayload = JSON.parse(calls.find((call) => call.url === TELEMETRY_CONSTANTS.TELEMETRY_ENDPOINT).options.body);
    assert.equal(updatePayload.reason, 'update');
    assert.equal(updatePayload.previousVersion, '1.2.2');

    await controller.handleStartup();
    assert.equal(calls.filter((call) => call.url === TELEMETRY_CONSTANTS.TELEMETRY_ENDPOINT).length, 1);

    activeWqId = 'WQ-B';
    await controller.handleStartup();
    assert.equal(calls.filter((call) => call.url === TELEMETRY_CONSTANTS.TELEMETRY_ENDPOINT).length, 2);
    const state = chromeApi.memory[TELEMETRY_CONSTANTS.STORAGE_KEY];
    assert.equal(Object.keys(state.reports).length, 2);
});

test('reinstall generates a new installation ID', async () => {
    async function installOnce() {
        const chromeApi = createChromeMock();
        const controller = createTelemetryController({
            chromeApi,
            fetchImpl: async (url) => url === TELEMETRY_CONSTANTS.SUMMARY_ENDPOINT ? summary() : confirmation(),
        });
        await controller.handleInstalled({ reason: 'install' });
        return chromeApi.memory[TELEMETRY_CONSTANTS.STORAGE_KEY].installationId;
    }

    const first = await installOnce();
    const second = await installOnce();
    assert.notEqual(first, second);
});

test('401, 429 and 5xx retain pending work with the required retry schedule', async () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(backoffForAttempt), [
        15 * 60 * 1000,
        60 * 60 * 1000,
        6 * 60 * 60 * 1000,
        24 * 60 * 60 * 1000,
        24 * 60 * 60 * 1000,
    ]);

    let clock = 1_800_000_000_000;
    const unauthorizedChrome = createChromeMock();
    const unauthorized = createTelemetryController({
        chromeApi: unauthorizedChrome,
        now: () => clock,
        fetchImpl: async () => jsonResponse({}, 401),
    });
    await unauthorized.handleInstalled({ reason: 'install' });
    let state = unauthorizedChrome.memory[TELEMETRY_CONSTANTS.STORAGE_KEY];
    assert.equal(state.pending.retryCount, 1);
    assert.equal(state.pending.lastStatus, 401);
    assert.equal(state.pending.nextRetryAt, clock + 15 * 60 * 1000);

    const rateChrome = createChromeMock();
    let rateCalls = 0;
    const rateLimited = createTelemetryController({
        chromeApi: rateChrome,
        now: () => clock,
        fetchImpl: async (url) => {
            rateCalls += 1;
            return url === TELEMETRY_CONSTANTS.SUMMARY_ENDPOINT
                ? summary()
                : jsonResponse({}, 429, { 'Retry-After': '120' });
        },
    });
    await rateLimited.handleInstalled({ reason: 'install' });
    state = rateChrome.memory[TELEMETRY_CONSTANTS.STORAGE_KEY];
    assert.equal(rateCalls, 2);
    assert.equal(state.pending.nextRetryAt, clock + 120 * 1000);

    const serverChrome = createChromeMock();
    const serverFailure = createTelemetryController({
        chromeApi: serverChrome,
        now: () => clock,
        fetchImpl: async (url) => url === TELEMETRY_CONSTANTS.SUMMARY_ENDPOINT ? summary() : jsonResponse({}, 500),
    });
    await serverFailure.handleInstalled({ reason: 'update', previousVersion: '1.2.2' });
    state = serverChrome.memory[TELEMETRY_CONSTANTS.STORAGE_KEY];
    assert.equal(state.pending.nextRetryAt, clock + 15 * 60 * 1000);
    clock = state.pending.nextRetryAt;
    await serverFailure.handleStartup();
    state = serverChrome.memory[TELEMETRY_CONSTANTS.STORAGE_KEY];
    assert.equal(state.pending.retryCount, 2);
    assert.equal(state.pending.nextRetryAt, clock + 60 * 60 * 1000);
});

test('request-format 4xx stops retries without marking upload complete', async () => {
    const chromeApi = createChromeMock();
    const controller = createTelemetryController({
        chromeApi,
        fetchImpl: async (url) => url === TELEMETRY_CONSTANTS.SUMMARY_ENDPOINT ? summary() : jsonResponse({}, 400),
    });
    const result = await controller.handleInstalled({ reason: 'install' });
    const state = chromeApi.memory[TELEMETRY_CONSTANTS.STORAGE_KEY];
    assert.equal(result.status, 'terminal_failure');
    assert.equal(state.pending, null);
    assert.equal(state.terminalFailure.status, 400);
    assert.equal(Object.keys(state.reports).length, 0);
});

test('summary parsing and Retry-After handling are bounded and predictable', () => {
    assert.deepEqual(parseSummaryIdentity({ leaderboard: { user: 1234, country: null } }), {
        wqId: '1234',
        country: 'UNKNOWN',
    });
    assert.equal(parseSummaryIdentity({ leaderboard: { user: 'WQ', country: 'United States' } }).country, 'UNKNOWN');
    assert.throws(() => parseSummaryIdentity({ leaderboard: {} }));
    assert.equal(parseRetryAfter('120', 1_000), 120_000);
    assert.equal(parseRetryAfter(new Date(61_000).toUTCString(), 1_000), 60_000);
    assert.equal(parseRetryAfter('invalid', 1_000), null);
});
