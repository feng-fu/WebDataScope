import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { sha256Hex } from '../src/crypto.js';

const validPayload = {
    schemaVersion: 1,
    installationId: '123e4567-e89b-42d3-a456-426614174000',
    wqId: 'PRIVATE-WQ-ID-123',
    country: 'CN',
    version: '1.3.0',
    previousVersion: '1.2.2',
    reason: 'update',
};

class FakeStatement {
    constructor(sql) {
        this.sql = sql;
        this.params = [];
    }

    bind(...params) {
        this.params = params;
        return this;
    }
}

class FakeDatabase {
    constructor(registrationChanges = 1) {
        this.registrationChanges = registrationChanges;
        this.batches = [];
    }

    prepare(sql) {
        return new FakeStatement(sql);
    }

    async batch(statements) {
        this.batches.push(statements);
        return [
            { success: true, meta: { changes: 1 } },
            { success: true, meta: { changes: 1 } },
            { success: true, meta: { changes: this.registrationChanges } },
        ];
    }
}

function createEnv(registrationChanges = 1) {
    return {
        DB: new FakeDatabase(registrationChanges),
        COLLECTION_ENABLED: 'true',
        KEY_VERSION: '1',
        WQ_ID_HMAC_KEY_V1: Buffer.alloc(32, 3).toString('base64'),
        WQ_ID_ENCRYPTION_KEY_V1: Buffer.alloc(32, 4).toString('base64'),
        INSTALL_RATE_LIMITER: { limit: async () => ({ success: true }) },
        IP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
}

function registrationRequest(payload = validPayload, headers = {}) {
    return new Request('https://telemetry.example/v1/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
    });
}

test('registration writes no raw WQ ID and returns created only once', async () => {
    const firstEnv = createEnv(1);
    const first = await worker.fetch(registrationRequest(), firstEnv);
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { ok: true, created: true, schemaVersion: 1 });
    assert.equal(JSON.stringify(firstEnv.DB.batches).includes(validPayload.wqId), false);
    assert.equal(firstEnv.DB.batches[0].length, 3);

    const duplicate = await worker.fetch(registrationRequest(), createEnv(0));
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).created, false);
});

test('registration rejects undeclared fields, oversized bodies and rate limits', async () => {
    const unknown = await worker.fetch(registrationRequest({ ...validPayload, cookie: 'secret' }), createEnv());
    assert.equal(unknown.status, 400);

    const oversized = await worker.fetch(
        registrationRequest(validPayload, { 'Content-Length': '3000' }),
        createEnv(),
    );
    assert.equal(oversized.status, 413);

    const rateEnv = createEnv();
    rateEnv.INSTALL_RATE_LIMITER.limit = async () => ({ success: false });
    const limited = await worker.fetch(registrationRequest(), rateEnv);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
});

test('emergency stop prevents database writes', async () => {
    const env = createEnv();
    env.COLLECTION_ENABLED = 'false';
    const response = await worker.fetch(registrationRequest(), env);
    assert.equal(response.status, 503);
    assert.equal(env.DB.batches.length, 0);
});

test('admin routes require Basic Auth and never permit indexing', async () => {
    const env = createEnv();
    env.ADMIN_AUTH_DIGEST = await sha256Hex('admin:correct-horse');
    const denied = await worker.fetch(new Request('https://telemetry.example/admin'), env);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('WWW-Authenticate'), /^Basic /);

    const allowed = await worker.fetch(new Request('https://telemetry.example/admin', {
        headers: { Authorization: `Basic ${btoa('admin:correct-horse')}` },
    }), env);
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.match(allowed.headers.get('X-Robots-Tag'), /noindex/);
    const html = await allowed.text();
    assert.match(html, /textContent/);
    assert.doesNotMatch(html, /PRIVATE-WQ-ID-123/);
});

test('registration preflight allows JSON POST without credentials', async () => {
    const response = await worker.fetch(new Request('https://telemetry.example/v1/registrations', {
        method: 'OPTIONS',
    }), createEnv());
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
});
