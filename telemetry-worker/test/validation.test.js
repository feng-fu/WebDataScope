import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { accountIndex, decryptWqId, encryptWqId } from '../src/crypto.js';
import { RequestValidationError, validateRegistrationPayload, versionRank } from '../src/validation.js';

const env = {
    KEY_VERSION: '1',
    WQ_ID_HMAC_KEY_V1: Buffer.alloc(32, 7).toString('base64'),
    WQ_ID_ENCRYPTION_KEY_V1: Buffer.alloc(32, 9).toString('base64'),
};

const validPayload = {
    schemaVersion: 1,
    installationId: '123e4567-e89b-42d3-a456-426614174000',
    wqId: 'WQ-USER-42',
    country: 'cn',
    version: '1.3.0',
    previousVersion: '1.2.2',
    reason: 'update',
};

test('strict registration validation normalizes only declared fields', () => {
    const result = validateRegistrationPayload(validPayload);
    assert.equal(result.country, 'CN');
    assert.equal(result.previousVersion, '1.2.2');
    assert.throws(
        () => validateRegistrationPayload({ ...validPayload, pageUrl: 'https://example.test/private' }),
        RequestValidationError,
    );
    assert.throws(
        () => validateRegistrationPayload({ ...validPayload, installationId: 'not-a-uuid' }),
        RequestValidationError,
    );
    assert.throws(
        () => validateRegistrationPayload({ ...validPayload, version: '1.3.0-beta' }),
        RequestValidationError,
    );
});

test('country fallback and sortable version rank are deterministic', () => {
    assert.equal(validateRegistrationPayload({ ...validPayload, country: '' }).country, 'UNKNOWN');
    assert.ok(versionRank('1.12.0') > versionRank('1.3.99'));
    assert.equal(versionRank('1.3'), '00001.00003.00000.00000');
});

test('HMAC index is stable while AES-GCM ciphertext is randomized and reversible', async () => {
    const firstIndex = await accountIndex(validPayload.wqId, env);
    const secondIndex = await accountIndex(validPayload.wqId, env);
    assert.equal(firstIndex, secondIndex);
    assert.equal(firstIndex.length, 64);
    assert.notEqual(firstIndex, validPayload.wqId);

    const first = await encryptWqId(validPayload.wqId, env);
    const second = await encryptWqId(validPayload.wqId, env);
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(await decryptWqId(first.ciphertext, first.iv, first.keyVersion, env), validPayload.wqId);
});

test('migration stores only account indexes and encrypted identifiers', async () => {
    const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
    assert.match(migration, /encrypted_wq_id TEXT NOT NULL/);
    assert.match(migration, /account_hash TEXT PRIMARY KEY/);
    assert.doesNotMatch(migration, /(?:^|\s)wq_id\s+TEXT/im);
    assert.match(migration, /PRIMARY KEY \(installation_id, account_hash, version\)/);
});
