(function () {
    'use strict';

    const COLUMN_ID = 'robustUniverseSharpe';
    const INSTALLED_KEY = '__WQS_ROBUST_UNIVERSE_SHARPE_INSTALLED__';
    const CUSTOM_COLUMN = Object.freeze({
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
    const CUSTOM_COLUMN_JSON = JSON.stringify(CUSTOM_COLUMN);
    const REQUIRED_COLUMN_MARKERS = ['"id":"failedNumRA"', '"id":"operatorCount"'];
    const TARGET_CHECK_NAMES = new Set([
        'LOW_ROBUST_UNIVERSE_SHARPE',
        'LOW_ROBUST_UNIVERSE_SHARPE.WITH_RATIO',
    ]);

    if (globalThis[INSTALLED_KEY]) {
        return;
    }
    globalThis[INSTALLED_KEY] = true;

    installColumnInjector();
    installAlphaResponseEnricher();

    function installColumnInjector() {
        if (typeof Node === 'undefined' || typeof Node.prototype?.appendChild !== 'function') {
            return;
        }

        const originalAppendChild = Node.prototype.appendChild;
        Node.prototype.appendChild = function (node) {
            if (node?.nodeName === 'SCRIPT' && !node.src && typeof node.textContent === 'string') {
                const patchedSource = injectCustomColumn(node.textContent);
                if (patchedSource !== node.textContent) {
                    node.textContent = patchedSource;
                    console.log('[WQS custom] Added robust-universe Sharpe column');
                }
            }
            return originalAppendChild.call(this, node);
        };
    }

    function installAlphaResponseEnricher() {
        if (typeof window.fetch !== 'function') {
            return;
        }

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
    }

    function injectCustomColumn(source) {
        if (
            typeof source !== 'string' ||
            source.includes(`"id":"${COLUMN_ID}"`) ||
            !REQUIRED_COLUMN_MARKERS.every((marker) => source.includes(marker))
        ) {
            return source;
        }

        const markerIndex = source.lastIndexOf('"id":"operatorCount"');
        const objectStart = source.lastIndexOf('{', markerIndex);
        const objectEnd = findObjectEnd(source, objectStart);
        if (objectStart < 0 || objectEnd < 0) {
            return source;
        }

        return `${source.slice(0, objectEnd + 1)},${CUSTOM_COLUMN_JSON}${source.slice(objectEnd + 1)}`;
    }

    function findObjectEnd(source, objectStart) {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = objectStart; index < source.length; index += 1) {
            const character = source[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === '"') {
                    inString = false;
                }
                continue;
            }

            if (character === '"') {
                inString = true;
            } else if (character === '{') {
                depth += 1;
            } else if (character === '}') {
                depth -= 1;
                if (depth === 0) {
                    return index;
                }
            }
        }

        return -1;
    }

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
