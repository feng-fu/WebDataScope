import {
    adminPage,
    adminSummary,
    adminUsers,
    deleteAdminUser,
    requireAdmin,
    unauthorizedResponse,
} from './admin.js';
import { handleRegistration, jsonResponse } from './registration.js';
import { RequestValidationError } from './validation.js';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        try {
            if (url.pathname === '/robots.txt') {
                return new Response('User-agent: *\nDisallow: /\n', {
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Cache-Control': 'public, max-age=86400',
                        'X-Robots-Tag': 'noindex, nofollow, noarchive',
                    },
                });
            }

            if (url.pathname === '/v1/registrations') {
                if (request.method === 'OPTIONS') return registrationPreflight();
                if (request.method !== 'POST') {
                    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST, OPTIONS' });
                }
                return await handleRegistration(request, env);
            }

            if (url.pathname === '/admin' || url.pathname.startsWith('/api/admin/')) {
                if (!(await requireAdmin(request, env))) return unauthorizedResponse();
                if (url.pathname === '/admin' && request.method === 'GET') return adminPage();
                if (url.pathname === '/api/admin/summary' && request.method === 'GET') return await adminSummary(env);
                if (url.pathname === '/api/admin/users' && request.method === 'GET') return await adminUsers(url, env);
                if (url.pathname.startsWith('/api/admin/users') && request.method === 'DELETE') {
                    return await deleteAdminUser(request, url, env);
                }
                return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
            }

            return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                return jsonResponse({ ok: false, error: error.code, message: error.message }, error.status);
            }
            if (Number.isInteger(error?.status)) {
                return jsonResponse(
                    { ok: false, error: error.code || 'request_failed' },
                    error.status,
                    error.headers || {},
                );
            }
            // Intentionally do not log the exception: it may retain request-derived values.
            return jsonResponse({ ok: false, error: 'internal_error' }, 500);
        }
    },
};

function registrationPreflight() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
            'Cache-Control': 'public, max-age=86400',
        },
    });
}
