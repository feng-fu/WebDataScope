const ALLOWED_KEYS = new Set([
    'schemaVersion',
    'installationId',
    'wqId',
    'country',
    'version',
    'previousVersion',
    'reason',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^\d{1,5}(?:\.\d{1,5}){1,3}$/;
const COUNTRY_PATTERN = /^(?:UNKNOWN|[A-Z][A-Z0-9_-]{1,15})$/;
const REASONS = new Set(['install', 'update', 'retry']);

export class RequestValidationError extends Error {
    constructor(message, status = 400, code = 'invalid_request') {
        super(message);
        this.name = 'RequestValidationError';
        this.status = status;
        this.code = code;
    }
}

export async function readRegistrationPayload(request) {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
        throw new RequestValidationError('Content-Type must be application/json.', 415, 'unsupported_media_type');
    }

    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > 2048) {
        throw new RequestValidationError('Request body exceeds 2 KiB.', 413, 'payload_too_large');
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 2048) {
        throw new RequestValidationError('Request body exceeds 2 KiB.', 413, 'payload_too_large');
    }

    let value;
    try {
        value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new RequestValidationError('Request body is not valid JSON.');
    }
    return validateRegistrationPayload(value);
}

export function validateRegistrationPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RequestValidationError('Request body must be a JSON object.');
    }

    for (const key of Object.keys(value)) {
        if (!ALLOWED_KEYS.has(key)) {
            throw new RequestValidationError(`Unknown field: ${key}.`);
        }
    }
    for (const key of ALLOWED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new RequestValidationError(`Missing field: ${key}.`);
        }
    }

    if (value.schemaVersion !== 1) {
        throw new RequestValidationError('Unsupported schemaVersion.');
    }

    const installationId = requireTrimmedString(value.installationId, 'installationId', 36);
    if (!UUID_PATTERN.test(installationId)) {
        throw new RequestValidationError('installationId must be an RFC 4122 UUID.');
    }

    const wqId = requireTrimmedString(value.wqId, 'wqId', 128);
    if (wqId.length < 1 || /[\u0000-\u001f\u007f]/.test(wqId)) {
        throw new RequestValidationError('wqId contains invalid characters.');
    }

    const countrySource = value.country == null || value.country === '' ? 'UNKNOWN' : value.country;
    const country = requireTrimmedString(countrySource, 'country', 16).toUpperCase();
    if (!COUNTRY_PATTERN.test(country)) {
        throw new RequestValidationError('country must be UNKNOWN or a 2-16 character uppercase region code.');
    }

    const version = validateVersion(value.version, 'version', false);
    const previousVersion = value.previousVersion == null || value.previousVersion === ''
        ? null
        : validateVersion(value.previousVersion, 'previousVersion', false);

    if (typeof value.reason !== 'string' || !REASONS.has(value.reason)) {
        throw new RequestValidationError('reason must be install, update or retry.');
    }

    return {
        schemaVersion: 1,
        installationId: installationId.toLowerCase(),
        wqId,
        country,
        version,
        previousVersion,
        reason: value.reason,
    };
}

export function versionRank(version) {
    return version
        .split('.')
        .map((part) => part.padStart(5, '0'))
        .concat(['00000', '00000', '00000', '00000'])
        .slice(0, 4)
        .join('.');
}

function validateVersion(value, field, allowNull) {
    if (allowNull && value == null) return null;
    const version = requireTrimmedString(value, field, 23);
    if (!VERSION_PATTERN.test(version)) {
        throw new RequestValidationError(`${field} must contain 2-4 numeric components.`);
    }
    if (version.split('.').some((part) => Number(part) > 65535)) {
        throw new RequestValidationError(`${field} contains a component above 65535.`);
    }
    return version;
}

function requireTrimmedString(value, field, maxLength) {
    if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > maxLength) {
        throw new RequestValidationError(`${field} must be a non-empty trimmed string up to ${maxLength} characters.`);
    }
    return value;
}
