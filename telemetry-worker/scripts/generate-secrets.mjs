import { createHash, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const secretsPath = resolve('.generated-secrets.json');
const credentialsPath = resolve('.admin-credentials.txt');
const devVarsPath = resolve('.dev.vars');

if (existsSync(secretsPath) || existsSync(credentialsPath) || existsSync(devVarsPath)) {
    throw new Error('Secret files already exist. Remove them manually only when intentionally rotating credentials.');
}

const username = 'admin';
const password = randomBytes(24).toString('base64url');
const authDigest = createHash('sha256').update(`${username}:${password}`, 'utf8').digest('hex');
const secrets = {
    WQ_ID_HMAC_KEY_V1: randomBytes(32).toString('base64'),
    WQ_ID_ENCRYPTION_KEY_V1: randomBytes(32).toString('base64'),
    ADMIN_AUTH_DIGEST: authDigest,
};

writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
writeFileSync(
    credentialsPath,
    `username=${username}\npassword=${password}\n`,
    { encoding: 'utf8', mode: 0o600 },
);
writeFileSync(
    devVarsPath,
    `${Object.entries(secrets).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    { encoding: 'utf8', mode: 0o600 },
);

console.log('Generated ignored secret bundle, local dev vars and admin credentials. Secret values were not printed.');
