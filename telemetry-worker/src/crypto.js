const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function accountIndex(wqId, env, keyVersion = currentKeyVersion(env)) {
    const rawKey = decodeBase64(readVersionedSecret(env, 'WQ_ID_HMAC_KEY', keyVersion));
    const key = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(wqId));
    return bytesToHex(new Uint8Array(signature));
}

export async function encryptWqId(wqId, env, keyVersion = currentKeyVersion(env)) {
    const rawKey = decodeBase64(readVersionedSecret(env, 'WQ_ID_ENCRYPTION_KEY', keyVersion));
    if (rawKey.byteLength !== 32) {
        throw new Error('WQ ID encryption secret must decode to exactly 32 bytes.');
    }
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(wqId));
    return {
        ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        iv: encodeBase64(iv),
        keyVersion,
    };
}

export async function decryptWqId(ciphertext, iv, keyVersion, env) {
    const rawKey = decodeBase64(readVersionedSecret(env, 'WQ_ID_ENCRYPTION_KEY', keyVersion));
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decodeBase64(iv) },
        key,
        decodeBase64(ciphertext),
    );
    return decoder.decode(plaintext);
}

export async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
    return bytesToHex(new Uint8Array(digest));
}

export function constantTimeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const max = Math.max(left.length, right.length);
    let difference = left.length ^ right.length;
    for (let index = 0; index < max; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}

export function currentKeyVersion(env) {
    const version = Number(env.KEY_VERSION || 1);
    if (!Number.isInteger(version) || version < 1 || version > 999) {
        throw new Error('KEY_VERSION must be a positive integer.');
    }
    return version;
}

function readVersionedSecret(env, baseName, keyVersion) {
    const value = env[`${baseName}_V${keyVersion}`];
    if (!value) throw new Error(`Missing ${baseName}_V${keyVersion} secret.`);
    return value;
}

function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function encodeBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
}

function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
