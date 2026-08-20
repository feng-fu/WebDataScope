import { accountIndex, currentKeyVersion, encryptWqId } from './crypto.js';
import { readRegistrationPayload, versionRank } from './validation.js';

export async function handleRegistration(request, env) {
    if (String(env.COLLECTION_ENABLED).toLowerCase() !== 'true') {
        return jsonResponse({ ok: false, error: 'collection_disabled' }, 503, { 'Retry-After': '3600' });
    }

    const payload = await readRegistrationPayload(request);
    await enforceRateLimits(request, env, payload.installationId);

    const keyVersion = currentKeyVersion(env);
    const [accountHash, encrypted] = await Promise.all([
        accountIndex(payload.wqId, env, keyVersion),
        encryptWqId(payload.wqId, env, keyVersion),
    ]);
    const timestamp = new Date().toISOString();

    const accountStatement = env.DB.prepare(`
        INSERT INTO accounts (
            account_hash, encrypted_wq_id, encryption_iv, key_version,
            country, latest_version, latest_version_rank, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_hash) DO UPDATE SET
            encrypted_wq_id = excluded.encrypted_wq_id,
            encryption_iv = excluded.encryption_iv,
            key_version = excluded.key_version,
            country = CASE
                WHEN excluded.country <> 'UNKNOWN' THEN excluded.country
                ELSE accounts.country
            END,
            latest_version = CASE
                WHEN excluded.latest_version_rank >= accounts.latest_version_rank
                    THEN excluded.latest_version
                ELSE accounts.latest_version
            END,
            latest_version_rank = MAX(accounts.latest_version_rank, excluded.latest_version_rank),
            last_seen_at = MAX(accounts.last_seen_at, excluded.last_seen_at)
    `).bind(
        accountHash,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.keyVersion,
        payload.country,
        payload.version,
        versionRank(payload.version),
        timestamp,
        timestamp,
    );

    const installationStatement = env.DB.prepare(`
        INSERT INTO installations (installation_id, account_hash, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(installation_id, account_hash) DO UPDATE SET
            last_seen_at = MAX(installations.last_seen_at, excluded.last_seen_at)
    `).bind(payload.installationId, accountHash, timestamp, timestamp);

    const registrationStatement = env.DB.prepare(`
        INSERT INTO version_registrations (
            installation_id, account_hash, version, previous_version,
            reason, country, first_reported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id, account_hash, version) DO NOTHING
    `).bind(
        payload.installationId,
        accountHash,
        payload.version,
        payload.previousVersion,
        payload.reason,
        payload.country,
        timestamp,
    );

    const results = await env.DB.batch([accountStatement, installationStatement, registrationStatement]);
    const created = Number(results?.[2]?.meta?.changes || 0) > 0;

    return jsonResponse({ ok: true, created, schemaVersion: 1 }, created ? 201 : 200);
}

async function enforceRateLimits(request, env, installationId) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const [installationResult, ipResult] = await Promise.all([
        env.INSTALL_RATE_LIMITER?.limit({ key: installationId }) ?? { success: true },
        env.IP_RATE_LIMITER?.limit({ key: ip }) ?? { success: true },
    ]);
    if (!installationResult.success || !ipResult.success) {
        const error = new Error('Rate limit exceeded.');
        error.status = 429;
        error.code = 'rate_limited';
        error.headers = { 'Retry-After': '60' };
        throw error;
    }
}

export function jsonResponse(value, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            ...extraHeaders,
        },
    });
}
