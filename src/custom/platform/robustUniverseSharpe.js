(function () {
    'use strict';

    const COLUMN_ID = 'robustUniverseSharpe';
    const CUSTOM_COLUMNS_KEY = 'WQS_CUSTOM_COLUMNS';
    const INSTALLED_KEY = '__WQS_ROBUST_UNIVERSE_SHARPE_INSTALLED__';
    const TARGET_CHECK_NAMES = new Set([
        'LOW_ROBUST_UNIVERSE_SHARPE',
        'LOW_ROBUST_UNIVERSE_SHARPE.WITH_RATIO',
    ]);

    const customColumns = Array.isArray(globalThis[CUSTOM_COLUMNS_KEY])
        ? globalThis[CUSTOM_COLUMNS_KEY]
        : [];

    if (!customColumns.some((column) => column?.id === COLUMN_ID)) {
        customColumns.push({
            id: COLUMN_ID,
            parent: 'is',
            name: 'Robust U Sharpe',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'number',
            width: 110,
        });
    }
    globalThis[CUSTOM_COLUMNS_KEY] = customColumns;

    if (globalThis[INSTALLED_KEY] || typeof window.fetch !== 'function') {
        return;
    }
    globalThis[INSTALLED_KEY] = true;

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        const request = args[0];
        const url = typeof request === 'string' ? request : (request?.url || '');

        if (!isAlphaListUrl(url)) {
            return response;
        }

        try {
            const payload = await response.clone().json();
            if (!Array.isArray(payload?.results)) {
                return response;
            }

            payload.results.forEach(addRobustUniverseSharpe);
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');

            return new Response(JSON.stringify(payload), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        } catch (error) {
            console.warn('[WQS custom] Unable to enrich robust-universe Sharpe:', error);
            return response;
        }
    };

    function isAlphaListUrl(url) {
        return typeof url === 'string' && /\/users\/self\/alphas\?/.test(url);
    }

    function addRobustUniverseSharpe(item) {
        if (!item || typeof item !== 'object') {
            return;
        }

        item.is = item.is && typeof item.is === 'object' ? item.is : {};
        const checks = Array.isArray(item.is.checks) ? item.is.checks : [];
        const robustSharpeCheck = checks.find((check) => TARGET_CHECK_NAMES.has(check?.name));
        item.is[COLUMN_ID] = robustSharpeCheck?.value ?? null;
    }
})();
