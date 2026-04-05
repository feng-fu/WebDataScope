(function () {
    'use strict';

    if (window.__WQS_UNSUBMITTED_HOVER_INSTALLED__) {
        return;
    }
    window.__WQS_UNSUBMITTED_HOVER_INSTALLED__ = true;

    const ROUTE_PATH = '/alphas/unsubmitted';
    const TARGET_SELECTOR = '.alpha-list-table__container--add-to-compare';
    const PANEL_ID = 'wqs-unsubmitted-hover-panel';
    const STYLE_ID = 'wqs-unsubmitted-hover-style';

    const RA_CHECK_NAMES = new Set([
        'HIGH_TURNOVER', 'LOW_TURNOVER',
        'LOW_FITNESS', 'LOW_RETURNS', 'LOW_SHARPE',
        'LOW_GLB_AMER_SHARPE', 'LOW_GLB_APAC_SHARPE', 'LOW_GLB_EMEA_SHARPE', 'LOW_ASI_JPN_SHARPE',
        'IS_LADDER_SHARPE',
        'LOW_2Y_SHARPE', 'LOW_SUB_UNIVERSE_SHARPE', 'LOW_ROBUST_UNIVERSE_SHARPE',
        'LOW_AFTER_COST_ILLIQUID_UNIVERSE_SHARPE', 'LOW_INVESTABILITY_CONSTRAINED_SHARPE',
        'LOW_ROBUST_UNIVERSE_RETURNS',
        'CONCENTRATED_WEIGHT'
    ]);

    const PPA_CHECK_NAMES = new Set([
        'LOW_TURNOVER',
        'HIGH_TURNOVER',
        'LOW_SUB_UNIVERSE_SHARPE',
        'LOW_ROBUST_UNIVERSE_SHARPE',
        'LOW_ROBUST_UNIVERSE_SHARPE.WITH_RATIO',
        'LOW_ROBUST_UNIVERSE_RETURNS',
        'LOW_INVESTABILITY_CONSTRAINED_SHARPE'
    ]);

    const FAILURE_PRIORITY = new Map([
        ['LOW_SHARPE', 1],
        ['LOW_FITNESS', 2],
        ['LOW_RETURNS', 3],
        ['LOW_SUB_UNIVERSE_SHARPE', 4],
        ['LOW_ROBUST_UNIVERSE_SHARPE', 5],
        ['LOW_ROBUST_UNIVERSE_SHARPE.WITH_RATIO', 6],
        ['LOW_ROBUST_UNIVERSE_RETURNS', 7],
        ['LOW_INVESTABILITY_CONSTRAINED_SHARPE', 8],
        ['LOW_AFTER_COST_ILLIQUID_UNIVERSE_SHARPE', 9],
        ['CONCENTRATED_WEIGHT', 10],
        ['HIGH_TURNOVER', 11],
        ['LOW_TURNOVER', 12],
        ['LOW_2Y_SHARPE', 13],
        ['IS_LADDER_SHARPE', 14],
        ['LOW_GLB_AMER_SHARPE', 15],
        ['LOW_GLB_APAC_SHARPE', 16],
        ['LOW_GLB_EMEA_SHARPE', 17],
        ['LOW_ASI_JPN_SHARPE', 18]
    ]);

    const GROUP_STATE_KEY = 'wqs-unsubmitted-hover-group-state';
    const DEFAULT_GROUP_STATE = { fail: true, pass: true, warning: false };

    const alphaCache = new Map();
    let latestAlphaOrder = [];
    let panel = null;
    let hideTimer = 0;
    let activeAnchor = null;
    let activeAlphaId = null;
    let activeLookupToken = 0;
    let lastPathname = location.pathname;

    bootstrap();

    function bootstrap() {
        ensureStyles();
        ensurePanel();
        installNetworkObservers();
        installUiObservers();
        handleRouteChange();
    }

    function installNetworkObservers() {
        if (window.__WQS_UNSUBMITTED_HOVER_FETCH_WRAPPED__) {
            return;
        }
        window.__WQS_UNSUBMITTED_HOVER_FETCH_WRAPPED__ = true;

        const originalFetch = window.fetch;
        if (typeof originalFetch === 'function') {
            window.fetch = async function (...args) {
                const request = args[0];
                const url = typeof request === 'string' ? request : (request && request.url) || '';
                const response = await originalFetch.apply(this, args);
                captureAlphaListResponse(url, response);
                return response;
            };
        }

        if (window.XMLHttpRequest && !window.__WQS_UNSUBMITTED_HOVER_XHR_WRAPPED__) {
            window.__WQS_UNSUBMITTED_HOVER_XHR_WRAPPED__ = true;
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function (method, url) {
                this.__wqsAlphaListUrl = typeof url === 'string' ? url : '';
                return originalOpen.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function () {
                if (!this.__wqsAlphaListObserved) {
                    this.__wqsAlphaListObserved = true;
                    this.addEventListener('loadend', function () {
                        if (!matchesAlphaListUrl(this.__wqsAlphaListUrl)) {
                            return;
                        }
                        if (this.status < 200 || this.status >= 300) {
                            return;
                        }
                        try {
                            let payload = null;
                            if (!this.responseType || this.responseType === 'text') {
                                payload = JSON.parse(this.responseText);
                            } else if (this.responseType === 'json') {
                                payload = this.response;
                            }
                            consumeAlphaListPayload(payload);
                        } catch (_) {
                            // Ignore payload parsing failures.
                        }
                    });
                }
                return originalSend.apply(this, arguments);
            };
        }
    }

    function installUiObservers() {
        document.addEventListener('mouseover', handleMouseOver, true);
        document.addEventListener('mouseout', handleMouseOut, true);

        window.addEventListener('scroll', repositionActivePanel, true);
        window.addEventListener('resize', repositionActivePanel);
        window.addEventListener('hashchange', handleRouteChange);
        window.addEventListener('popstate', handleRouteChange);

        const observer = new MutationObserver(() => {
            if (activeAnchor && !document.contains(activeAnchor)) {
                hidePanel();
            }
            if (lastPathname !== location.pathname) {
                handleRouteChange();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    function handleRouteChange() {
        lastPathname = location.pathname;
        if (!isUnsubmittedRoute()) {
            alphaCache.clear();
            hidePanel();
        }
    }

    function isUnsubmittedRoute() {
        return location.pathname === ROUTE_PATH;
    }

    function matchesAlphaListUrl(url) {
        if (!url || typeof url !== 'string') {
            return false;
        }
        return /\/users\/self\/alphas\?/.test(url);
    }

    function captureAlphaListResponse(url, response) {
        if (!matchesAlphaListUrl(url) || !response || !response.ok || typeof response.clone !== 'function') {
            return;
        }

        response.clone().json().then(consumeAlphaListPayload).catch(() => {
            // Ignore payload parsing failures.
        });
    }

    function consumeAlphaListPayload(payload) {
        if (!payload || !Array.isArray(payload.results)) {
            return;
        }

        let updatedActive = false;
        const currentOrder = [];

        payload.results.forEach((item) => {
            const normalized = normalizeAlphaItem(item);
            if (!normalized) {
                return;
            }
            alphaCache.set(normalized.id, normalized);
            currentOrder.push(normalized.id);
            if (normalized.id === activeAlphaId) {
                updatedActive = true;
            }
        });

        if (currentOrder.length) {
            latestAlphaOrder = currentOrder;
        }

        if (updatedActive && activeAnchor && activeAlphaId) {
            const record = alphaCache.get(activeAlphaId);
            if (record) {
                renderAlpha(record);
                positionPanel(activeAnchor);
            }
        }
    }

    function normalizeAlphaItem(item) {
        const id = normalizeId(item && item.id);
        if (!id) {
            return null;
        }

        const alphaState = item && item.is && typeof item.is === 'object' ? item.is : item && typeof item === 'object' ? item : {};
        const checks = Array.isArray(alphaState.checks)
            ? alphaState.checks.map(normalizeCheck).filter(Boolean)
            : [];
        const regularCode = item && item.regular && typeof item.regular.code === 'string' ? item.regular.code : '';

        const failedChecks = checks
            .filter((check) => !isPassResult(check.result) && !isPendingResult(check.result))
            .sort(compareChecks);
        const passedChecks = checks.filter((check) => isPassResult(check.result));
        const pendingChecks = checks.filter((check) => isPendingResult(check.result));

        const computedFailedNumRA = checks.filter((check) => {
            return RA_CHECK_NAMES.has(check.name) && !isPassResult(check.result) && !isPendingResult(check.result);
        }).length;

        const computedFailedNumPPA = checks.filter((check) => {
            const isNamedPpaFailure = PPA_CHECK_NAMES.has(check.name) && !isPassResult(check.result) && !isPendingResult(check.result);
            const lowSharpeValue = toFiniteNumber(check.value);
            const isLowSharpePpaFailure = check.name === 'LOW_SHARPE' && lowSharpeValue != null && lowSharpeValue < 1;
            return isNamedPpaFailure || isLowSharpePpaFailure;
        }).length;

        return {
            id,
            regularCode,
            metrics: buildPerformanceMetrics(alphaState),
            investMetrics: buildPerformanceMetrics(alphaState.investabilityConstrained),
            riskMetrics: buildPerformanceMetrics(alphaState.riskNeutralized),
            operatorCount: countOperators(regularCode),
            fieldCount: countFields(regularCode),
            pyramid: getExplicitPyramid(alphaState) || getPyramidFromChecks(checks),
            checks,
            failedChecks,
            passedChecks,
            pendingChecks,
            failedNumRA: toOptionalNumber(alphaState.failedNumRA, computedFailedNumRA),
            failedNumPPA: toOptionalNumber(alphaState.failedNumPPA, computedFailedNumPPA),
            updatedAt: Date.now()
        };
    }

    function normalizeCheck(check) {
        if (!check || !check.name) {
            return null;
        }

        return {
            name: String(check.name),
            result: check.result == null ? 'UNKNOWN' : String(check.result),
            value: normalizeScalar(check.value),
            limit: normalizeScalar(check.limit),
            message: typeof check.message === 'string' && check.message.trim() ? check.message.trim() : '',
            description: typeof check.description === 'string' && check.description.trim() ? check.description.trim() : '',
            pyramids: Array.isArray(check.pyramids)
                ? check.pyramids.map((pyramid) => ({
                    name: pyramid && pyramid.name ? String(pyramid.name) : '',
                    multiplier: normalizeScalar(pyramid && pyramid.multiplier)
                })).filter((pyramid) => pyramid.name)
                : []
        };
    }

    function pickMetric(item, alphaState, keys) {
        for (const key of keys) {
            const stateValue = alphaState && alphaState[key];
            if (stateValue !== undefined && stateValue !== null && stateValue !== '') {
                return normalizeScalar(stateValue);
            }

            const rootValue = item && item[key];
            if (rootValue !== undefined && rootValue !== null && rootValue !== '') {
                return normalizeScalar(rootValue);
            }
        }
        return null;
    }

    function buildPerformanceMetrics(state) {
        if (!state || typeof state !== 'object') {
            return null;
        }
        const metrics = {
            sharpe: normalizeScalar(state.sharpe),
            fitness: normalizeScalar(state.fitness),
            turnover: normalizeScalar(state.turnover),
            returns: normalizeScalar(state.returns),
            margin: normalizeScalar(state.margin),
            drawdown: normalizeScalar(state.drawdown)
        };
        return hasAnyMetric(metrics) ? metrics : null;
    }

    function hasAnyMetric(metrics) {
        if (!metrics) {
            return false;
        }
        return Object.values(metrics).some((value) => value !== undefined && value !== null && value !== '');
    }

    function getExplicitPyramid(alphaState) {
        const pyramid = alphaState && alphaState.WQPPYS;
        return typeof pyramid === 'string' && pyramid.trim() ? pyramid.trim() : '';
    }

    function countOperators(code) {
        if (!code) {
            return null;
        }
        const matches = code.match(/[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || [];
        return matches.length || null;
    }

    function countFields(code) {
        if (!code) {
            return null;
        }
        const tokenRegex = /[A-Za-z_][A-Za-z0-9_]*/g;
        const excluded = new Set(['if', 'else', 'true', 'false', 'null', 'signed_power']);
        const fields = new Set();
        let match;

        while ((match = tokenRegex.exec(code))) {
            const token = match[0];
            if (excluded.has(token)) {
                continue;
            }
            const rest = code.slice(match.index + token.length).trimStart();
            if (rest[0] === '(') {
                continue;
            }
            if (/^[A-Z0-9_]+$/.test(token)) {
                continue;
            }
            fields.add(token);
        }

        return fields.size || null;
    }

    function getPyramidFromChecks(checks) {
        const match = checks.find((check) => check.name === 'MATCHES_PYRAMID' && check.pyramids.length);
        if (!match) {
            return '';
        }
        return formatPyramidNames(match.pyramids);
    }

    function formatPyramidNames(pyramids) {
        if (!Array.isArray(pyramids) || !pyramids.length) {
            return '';
        }
        return pyramids
            .map((pyramid) => pyramid && pyramid.name ? pyramid.name.split('/').pop() : '')
            .filter(Boolean)
            .map((name) => name.toLowerCase())
            .join(', ');
    }

    function handleMouseOver(event) {
        if (!isUnsubmittedRoute()) {
            return;
        }

        const target = getClosestTarget(event.target);
        if (target) {
            clearHideTimer();
            if (activeAnchor !== target) {
                showPanelForTarget(target);
            } else {
                positionPanel(target);
            }
            return;
        }

        if (panel && panel.contains(event.target)) {
            clearHideTimer();
        }
    }

    function handleMouseOut(event) {
        const target = getClosestTarget(event.target);
        if (!target || target !== activeAnchor) {
            return;
        }

        const relatedTarget = event.relatedTarget;
        if (relatedTarget && (
            target.contains(relatedTarget) ||
            (panel && panel.contains(relatedTarget)) ||
            getClosestTarget(relatedTarget)
        )) {
            return;
        }

        scheduleHide();
    }

    function getClosestTarget(node) {
        if (!node || typeof node.closest !== 'function') {
            return null;
        }
        return node.closest(TARGET_SELECTOR);
    }

    function showPanelForTarget(target) {
        activeAnchor = target;
        const alphaId = resolveAlphaId(target);
        activeAlphaId = alphaId;
        activeLookupToken += 1;
        const lookupToken = activeLookupToken;

        if (!alphaId) {
            renderUnavailable(null, 'Unable to resolve Alpha ID from this row.');
            positionPanel(target);
            return;
        }

        const cached = alphaCache.get(alphaId);
        if (cached) {
            renderAlpha(cached);
            positionPanel(target);
            return;
        }

        renderLoading(alphaId);
        positionPanel(target);

        window.setTimeout(() => {
            if (lookupToken !== activeLookupToken || activeAlphaId !== alphaId || !activeAnchor) {
                return;
            }
            const lateRecord = alphaCache.get(alphaId);
            if (lateRecord) {
                renderAlpha(lateRecord);
                positionPanel(activeAnchor);
                return;
            }
            renderUnavailable(alphaId, 'Alpha data not captured yet. Try again after the list finishes loading.');
            positionPanel(activeAnchor);
        }, 1200);
    }

    function resolveAlphaId(target) {
        const row = resolveRowElement(target);
        const candidates = collectCandidateNodes(target, row);

        for (const candidate of candidates) {
            const directId = extractIdFromDataset(candidate);
            if (directId) {
                return directId;
            }
        }

        const linkId = extractIdFromLinks(candidates);
        if (linkId) {
            return linkId;
        }

        const reactId = extractIdFromReactProps(candidates);
        if (reactId) {
            return reactId;
        }

        const indexId = resolveAlphaIdByVisualOrder(target, row);
        if (indexId) {
            return indexId;
        }

        return null;
    }

    function resolveRowElement(target) {
        const explicitRow = target.closest('[role="row"], tr, .alpha-list-table__row, [class*="alpha-list-table__row"]');
        if (explicitRow) {
            return explicitRow;
        }

        let node = target.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            const siblingTargetCount = node.querySelectorAll ? node.querySelectorAll(TARGET_SELECTOR).length : 0;
            if (siblingTargetCount === 1) {
                return node;
            }
            node = node.parentElement;
        }

        return target.parentElement;
    }

    function collectCandidateNodes(target, row) {
        const candidates = [];
        const seen = new Set();

        function push(node) {
            if (!node || seen.has(node)) {
                return;
            }
            seen.add(node);
            candidates.push(node);
        }

        push(target);
        push(row);

        let parent = row ? row.parentElement : target.parentElement;
        let depth = 0;
        while (parent && depth < 6) {
            push(parent);
            parent = parent.parentElement;
            depth += 1;
        }

        return candidates;
    }

    function extractIdFromLinks(candidates) {
        for (const candidate of candidates) {
            if (!candidate || typeof candidate.querySelectorAll !== 'function') {
                continue;
            }
            const links = candidate.querySelectorAll('a[href*="/alpha/"]');
            for (const link of links) {
                const hrefId = extractIdFromHref(link.getAttribute('href') || link.href || '');
                if (hrefId) {
                    return hrefId;
                }
            }
        }
        return null;
    }

    function extractIdFromReactProps(candidates) {
        for (const candidate of candidates) {
            const fiber = getReactFiberNode(candidate);
            if (!fiber) {
                continue;
            }

            const match = searchObjectForAlphaId(fiber.memoizedProps, 0, new Set())
                || searchObjectForAlphaId(fiber.pendingProps, 0, new Set())
                || searchObjectForAlphaId(fiber.memoizedState, 0, new Set());

            if (match) {
                return match;
            }
        }
        return null;
    }

    function getReactFiberNode(node) {
        if (!node) {
            return null;
        }

        for (const key in node) {
            if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
                return node[key];
            }
        }

        return null;
    }

    function searchObjectForAlphaId(value, depth, visited) {
        if (depth > 4 || value == null) {
            return null;
        }

        if (typeof value === 'string') {
            const normalized = normalizeIdCandidate(value);
            return normalized;
        }

        if (typeof value !== 'object') {
            return null;
        }

        if (visited.has(value)) {
            return null;
        }
        visited.add(value);

        const priorityKeys = ['alphaId', 'id', 'alpha', 'item', 'row', 'data', 'children'];
        for (const key of priorityKeys) {
            if (!(key in value)) {
                continue;
            }
            const match = searchObjectForAlphaId(value[key], depth + 1, visited);
            if (match) {
                return match;
            }
        }

        const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
        for (const entry of entries) {
            const key = Array.isArray(value) ? null : entry[0];
            const child = Array.isArray(value) ? entry[1] : entry[1];
            if (key && !looksRelevantKey(key)) {
                continue;
            }
            const match = searchObjectForAlphaId(child, depth + 1, visited);
            if (match) {
                return match;
            }
        }

        return null;
    }

    function looksRelevantKey(key) {
        return /alpha|id|item|row|data|node|props|children/i.test(String(key));
    }

    function normalizeIdCandidate(value) {
        const direct = normalizeId(value);
        if (direct && /\d/.test(direct)) {
            return direct;
        }

        const hrefId = extractIdFromHref(value);
        if (hrefId) {
            return hrefId;
        }

        return null;
    }

    function resolveAlphaIdByVisualOrder(target, row) {
        if (!latestAlphaOrder.length) {
            return null;
        }

        const container = findCompareContainer(target, row);
        if (!container) {
            return null;
        }

        const buttons = Array.from(container.querySelectorAll(TARGET_SELECTOR));
        const index = buttons.indexOf(target);
        if (index < 0 || index >= latestAlphaOrder.length) {
            return null;
        }

        return latestAlphaOrder[index] || null;
    }

    function findCompareContainer(target, row) {
        const startNode = row || target;
        let node = startNode;
        while (node && node !== document.body && node !== document.documentElement) {
            if (typeof node.querySelectorAll === 'function') {
                const buttons = node.querySelectorAll(TARGET_SELECTOR);
                if (buttons.length > 1 && buttons[0].closest) {
                    return node;
                }
            }
            node = node.parentElement;
        }
        return document;
    }

    function extractIdFromDataset(node) {
        if (!node || !node.dataset) {
            return null;
        }

        const candidateKeys = ['alphaId', 'id', 'alphaid'];
        for (const key of candidateKeys) {
            const value = node.dataset[key];
            const normalized = normalizeId(value);
            if (normalized) {
                return normalized;
            }
        }

        const attrKeys = ['data-alpha-id', 'data-id', 'alpha-id'];
        for (const key of attrKeys) {
            const value = typeof node.getAttribute === 'function' ? node.getAttribute(key) : null;
            const normalized = normalizeId(value);
            if (normalized) {
                return normalized;
            }
        }

        return null;
    }

    function extractIdFromHref(href) {
        if (!href) {
            return null;
        }
        try {
            const url = new URL(href, location.origin);
            const match = url.pathname.match(/\/alpha\/([^/?#]+)/);
            return normalizeId(match && match[1]);
        } catch (_) {
            return null;
        }
    }

    function normalizeId(value) {
        if (typeof value !== 'string') {
            return null;
        }
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        return trimmed;
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${PANEL_ID} {
                position: fixed;
                z-index: 2147483647;
                display: none;
                width: min(620px, calc(100vw - 24px));
                max-height: min(92vh, 980px);
                overflow: auto;
                box-sizing: border-box;
                background: rgba(17, 24, 39, 0.98);
                color: #e5e7eb;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 12px;
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
                padding: 10px;
                font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                pointer-events: auto;
            }
            #${PANEL_ID} * {
                box-sizing: border-box;
            }
            #${PANEL_ID} .wqs-hover__header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 10px;
                margin-bottom: 8px;
            }
            #${PANEL_ID} .wqs-hover__title {
                font-size: 14px;
                font-weight: 700;
                color: #f9fafb;
            }
            #${PANEL_ID} .wqs-hover__subtitle {
                margin-top: 1px;
                color: #9ca3af;
                font-size: 11px;
            }
            #${PANEL_ID} .wqs-hover__pill-row {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-bottom: 8px;
            }
            #${PANEL_ID} .wqs-hover__pill {
                border-radius: 999px;
                padding: 2px 7px;
                background: rgba(255, 255, 255, 0.08);
                color: #e5e7eb;
                font-size: 11px;
                white-space: nowrap;
            }
            #${PANEL_ID} .wqs-hover__pill--bad {
                background: rgba(239, 68, 68, 0.18);
                color: #fecaca;
            }
            #${PANEL_ID} .wqs-hover__pill--good {
                background: rgba(34, 197, 94, 0.18);
                color: #bbf7d0;
            }
            #${PANEL_ID} .wqs-hover__expression {
                margin: 0 0 8px;
                padding: 8px 10px;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.05);
                color: #d1d5db;
                font-size: 11px;
                line-height: 1.45;
                white-space: pre-wrap;
                word-break: break-word;
                overflow-wrap: anywhere;
                text-indent: 0;
            }
            #${PANEL_ID} .wqs-hover__metrics {
                display: grid;
                grid-template-columns: repeat(6, minmax(0, 1fr));
                gap: 4px;
                margin-bottom: 6px;
            }
            #${PANEL_ID} .wqs-hover__metric {
                border-radius: 7px;
                padding: 5px 7px;
                background: rgba(255, 255, 255, 0.05);
            }
            #${PANEL_ID} .wqs-hover__metric-label {
                color: #9ca3af;
                font-size: 9px;
                margin-bottom: 1px;
            }
            #${PANEL_ID} .wqs-hover__metric-value {
                color: #f9fafb;
                font-size: 12px;
                font-weight: 600;
                line-height: 1.25;
            }
            #${PANEL_ID} .wqs-hover__section-title {
                font-size: 10px;
                font-weight: 700;
                margin: 2px 0 4px;
                color: #e5e7eb;
            }
            #${PANEL_ID} .wqs-hover__metric-value mark,
            #${PANEL_ID} .wqs-hover__group-text mark {
                background: rgba(56, 189, 248, 0.2);
                color: #7dd3fc;
                padding: 0 2px;
                border-radius: 3px;
                font-weight: 700;
            }
            #${PANEL_ID} .wqs-hover__groups {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-top: 8px;
            }
            #${PANEL_ID} .wqs-hover__group {
                border-radius: 9px;
                overflow: hidden;
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.08);
            }
            #${PANEL_ID} .wqs-hover__group > summary {
                list-style: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 8px 10px;
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.03em;
                text-transform: uppercase;
                background: rgba(255, 255, 255, 0.04);
            }
            #${PANEL_ID} .wqs-hover__group > summary::-webkit-details-marker {
                display: none;
            }
            #${PANEL_ID} .wqs-hover__group > summary::after {
                content: '▾';
                font-size: 11px;
                opacity: 0.9;
            }
            #${PANEL_ID} .wqs-hover__group:not([open]) > summary::after {
                content: '▸';
            }
            #${PANEL_ID} .wqs-hover__group--fail > summary {
                color: #fca5a5;
                border-bottom: 2px solid rgba(239, 68, 68, 0.55);
            }
            #${PANEL_ID} .wqs-hover__group--pass > summary {
                color: #86efac;
                border-bottom: 2px solid rgba(34, 197, 94, 0.55);
            }
            #${PANEL_ID} .wqs-hover__group--warning > summary {
                color: #fcd34d;
                border-bottom: 2px solid rgba(245, 158, 11, 0.55);
            }
            #${PANEL_ID} .wqs-hover__group-body {
                padding: 10px;
            }
            #${PANEL_ID} .wqs-hover__group-list {
                margin: 0;
                padding: 0;
                list-style: none;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            #${PANEL_ID} .wqs-hover__group-item {
                display: grid;
                grid-template-columns: auto minmax(0, 1fr);
                gap: 8px;
                align-items: start;
            }
            #${PANEL_ID} .wqs-hover__group-dot {
                width: 8px;
                height: 8px;
                border-radius: 999px;
                margin-top: 5px;
                flex: 0 0 auto;
            }
            #${PANEL_ID} .wqs-hover__group-item--fail .wqs-hover__group-dot {
                background: #fb7185;
            }
            #${PANEL_ID} .wqs-hover__group-item--pass .wqs-hover__group-dot {
                background: #4ade80;
            }
            #${PANEL_ID} .wqs-hover__group-item--warning .wqs-hover__group-dot {
                background: #f59e0b;
            }
            #${PANEL_ID} .wqs-hover__group-text {
                min-width: 0;
                color: #e5e7eb;
                font-size: 12px;
                line-height: 1.35;
                word-break: break-word;
            }
            #${PANEL_ID} .wqs-hover__empty,
            #${PANEL_ID} .wqs-hover__status {
                border-radius: 10px;
                padding: 10px 12px;
                background: rgba(255, 255, 255, 0.05);
                color: #d1d5db;
            }
        `;

        document.documentElement.appendChild(style);
    }

    function ensurePanel() {
        if (panel) {
            return panel;
        }

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.addEventListener('mouseenter', clearHideTimer);
        panel.addEventListener('mouseleave', scheduleHide);
        panel.addEventListener('toggle', handleGroupToggle, true);
        document.documentElement.appendChild(panel);
        return panel;
    }

    function handleGroupToggle(event) {
        const target = event.target;
        if (!target || target.tagName !== 'DETAILS') {
            return;
        }
        const key = target.getAttribute('data-group-key');
        if (!key) {
            return;
        }
        const state = getGroupState();
        state[key] = target.open;
        saveGroupState(state);
    }

    function getGroupState() {
        try {
            const raw = localStorage.getItem(GROUP_STATE_KEY);
            if (!raw) {
                return { ...DEFAULT_GROUP_STATE };
            }
            const parsed = JSON.parse(raw);
            return { ...DEFAULT_GROUP_STATE, ...parsed };
        } catch (_) {
            return { ...DEFAULT_GROUP_STATE };
        }
    }

    function saveGroupState(state) {
        try {
            localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(state));
        } catch (_) {
            // Ignore storage failures.
        }
    }

    function renderLoading(alphaId) {
        ensurePanel();
        panel.innerHTML = `
            <div class="wqs-hover__header">
                <div>
                    <div class="wqs-hover__title">${escapeHtml(alphaId || 'Alpha')}</div>
                    <div class="wqs-hover__subtitle">Loading hover details...</div>
                </div>
            </div>
            <div class="wqs-hover__status">Waiting for the alpha list response to arrive.</div>
        `;
        panel.style.display = 'block';
    }

    function renderUnavailable(alphaId, message) {
        ensurePanel();
        const debugLine = activeAnchor ? `<div class="wqs-hover__subtitle">debug: ${escapeHtml(buildDebugSummary(activeAnchor, alphaId))}</div>` : '';
        panel.innerHTML = `
            <div class="wqs-hover__header">
                <div>
                    <div class="wqs-hover__title">${escapeHtml(alphaId || 'Alpha')}</div>
                    <div class="wqs-hover__subtitle">Data unavailable</div>
                    ${debugLine}
                </div>
            </div>
            <div class="wqs-hover__status">${escapeHtml(message)}</div>
        `;
        panel.style.display = 'block';
    }

    function renderAlpha(record) {
        ensurePanel();

        const visibleChecks = record.checks.filter(shouldDisplayCheck);
        const failChecks = visibleChecks.filter((check) => isFailResult(check.result));
        const passChecks = visibleChecks.filter((check) => isPassResult(check.result));
        const warningChecks = visibleChecks.filter((check) => isWarningResult(check.result));

        panel.innerHTML = `
            <div class="wqs-hover__pill-row">
                <span class="wqs-hover__pill">ID: ${escapeHtml(record.id)}</span>
                <span class="wqs-hover__pill">Operators: ${escapeHtml(formatDisplayValue(record.operatorCount))}</span>
                <span class="wqs-hover__pill">Fields: ${escapeHtml(formatDisplayValue(record.fieldCount))}</span>
                <span class="wqs-hover__pill wqs-hover__pill--bad">RA fail: ${escapeHtml(String(record.failedNumRA))}</span>
                <span class="wqs-hover__pill wqs-hover__pill--bad">PPA fail: ${escapeHtml(String(record.failedNumPPA))}</span>
                <span class="wqs-hover__pill wqs-hover__pill--good">Pass: ${escapeHtml(String(passChecks.length))}</span>
                <span class="wqs-hover__pill">Pyramid: ${escapeHtml(record.pyramid || '—')}</span>
            </div>
            ${renderExpression(record.regularCode)}
            <div class="wqs-hover__metrics">
                ${renderMetric('Sharpe', record.metrics && record.metrics.sharpe)}
                ${renderMetric('Fitness', record.metrics && record.metrics.fitness)}
                ${renderMetric('Turnover', record.metrics && record.metrics.turnover, 'percent')}
                ${renderMetric('Returns', record.metrics && record.metrics.returns, 'percent')}
                ${renderMetric('Margin', record.metrics && record.metrics.margin, 'percent')}
                ${renderMetric('Drawdown', record.metrics && record.metrics.drawdown, 'percent')}
            </div>
            ${renderMetricSection('Investability constrained', record.investMetrics)}
            ${renderMetricSection('Risk neutralized', record.riskMetrics)}
            <div class="wqs-hover__groups">
                ${renderCheckGroup('fail', failChecks, 'FAIL')}
                ${renderCheckGroup('pass', passChecks, 'PASS')}
                ${warningChecks.length ? renderCheckGroup('warning', warningChecks, 'WARNING') : ''}
            </div>
        `;

        panel.style.display = 'block';
    }

    function renderCheckGroup(kind, checks, stateKey) {
        if (!checks.length) {
            return '';
        }

        const labels = {
            fail: 'FAIL',
            pass: 'PASS',
            warning: 'WARNING'
        };
        const groupState = getGroupState();
        const isOpen = groupState[stateKey] ?? DEFAULT_GROUP_STATE[stateKey.toLowerCase()] ?? true;
        const items = checks.map((check) => renderCheckGroupItem(check, kind)).join('');
        return `
            <details class="wqs-hover__group wqs-hover__group--${escapeHtml(kind)}" data-group-key="${escapeHtml(stateKey)}" ${isOpen ? 'open' : ''}>
                <summary>${escapeHtml(String(checks.length))} ${escapeHtml(labels[kind])}</summary>
                <div class="wqs-hover__group-body">
                    <ul class="wqs-hover__group-list">${items}</ul>
                </div>
            </details>
        `;
    }

    function renderCheckGroupItem(check, kind) {
        const message = highlightPrimaryValue(buildCheckMessage(check), check);
        return `
            <li class="wqs-hover__group-item wqs-hover__group-item--${escapeHtml(kind)}">
                <span class="wqs-hover__group-dot"></span>
                <span class="wqs-hover__group-text">${message}</span>
            </li>
        `;
    }

    function renderMetric(label, value, formatHint) {
        return `
            <div class="wqs-hover__metric">
                <div class="wqs-hover__metric-label">${escapeHtml(label)}</div>
                <div class="wqs-hover__metric-value">${escapeHtml(formatDisplayValue(value, formatHint))}</div>
            </div>
        `;
    }

    function renderExpression(code) {
        if (!code) {
            return '';
        }
        return `
            <div class="wqs-hover__expression">${escapeHtml(code)}</div>
        `;
    }

    function renderMetricSection(title, metrics) {
        if (!hasAnyMetric(metrics)) {
            return '';
        }
        return `
            <div class="wqs-hover__section-title">${escapeHtml(title)}</div>
            <div class="wqs-hover__metrics">
                ${renderMetric('Sharpe', metrics.sharpe)}
                ${renderMetric('Fitness', metrics.fitness)}
                ${renderMetric('Turnover', metrics.turnover, 'percent')}
                ${renderMetric('Returns', metrics.returns, 'percent')}
                ${renderMetric('Margin', metrics.margin, 'percent')}
                ${renderMetric('Drawdown', metrics.drawdown, 'percent')}
            </div>
        `;
    }

    function shouldDisplayCheck(check) {
        if (!check) {
            return false;
        }
        if (isPendingResult(check.result)) {
            return false;
        }
        if ((check.name === 'MATCHES_THEMES' || check.name === 'MATCHES_COMPETITION') && String(check.result || '').toUpperCase() === 'WARNING') {
            return false;
        }
        return true;
    }

    function isFailResult(result) {
        const normalized = String(result || '').toUpperCase();
        return normalized === 'FAIL';
    }

    function isWarningResult(result) {
        const normalized = String(result || '').toUpperCase();
        return normalized === 'WARNING';
    }

    function getResultClassName(result) {
        if (isPassResult(result)) {
            return 'wqs-hover__result--pass';
        }
        if (isPendingResult(result)) {
            return 'wqs-hover__result--pending';
        }
        return 'wqs-hover__result--fail';
    }

    function buildCheckMessage(check) {
        if (check.message) {
            return check.message;
        }
        if (check.description) {
            return check.description;
        }

        const value = formatDisplayValue(check.value, inferFormatHint(check.name));
        const limit = formatDisplayValue(check.limit, inferFormatHint(check.name));
        const pyramidDetails = formatPyramidDetails(check);

        switch (check.name) {
            case 'HIGH_TURNOVER':
                return `Turnover of ${value} is above cutoff of ${limit}.`;
            case 'LOW_TURNOVER':
                return `Turnover of ${value} is below cutoff of ${limit}.`;
            case 'CONCENTRATED_WEIGHT':
                return check.result === 'PASS'
                    ? 'Weight is well distributed over instruments.'
                    : `Weight concentration is above cutoff of ${limit}.`;
            case 'LOW_SUB_UNIVERSE_SHARPE':
                return `Sub-universe Sharpe of ${value} is ${check.result === 'PASS' ? 'above' : 'below'} cutoff of ${limit}.`;
            case 'LOW_ROBUST_UNIVERSE_SHARPE':
            case 'LOW_ROBUST_UNIVERSE_SHARPE.WITH_RATIO':
                return `Robust universe Sharpe of ${value} is ${check.result === 'PASS' ? 'above' : 'below'} cutoff of ${limit}.`;
            case 'LOW_SHARPE':
                return `Sharpe of ${value} is below cutoff of ${limit}.`;
            case 'LOW_FITNESS':
                return `Fitness of ${value} is below cutoff of ${limit}.`;
            case 'LOW_RETURNS':
                return `Returns of ${value} are below cutoff of ${limit}.`;
            case 'LOW_2Y_SHARPE':
                return `2 year Sharpe of ${value} is below cutoff of ${limit}.`;
            case 'MATCHES_PYRAMID':
                return pyramidDetails || 'Pyramid theme check result is available.';
            case 'MATCHES_COMPETITION':
                return check.result === 'PASS'
                    ? 'Competition matches.'
                    : 'Competition does not match.';
            case 'MATCHES_THEMES':
                return check.result === 'PASS'
                    ? 'Themes match.'
                    : 'These themes do not match.';
            default:
                if (check.value != null && check.limit != null) {
                    return `${humanizeCheckName(check.name)} value ${value} vs cutoff ${limit}.`;
                }
                if (check.value != null) {
                    return `${humanizeCheckName(check.name)} value is ${value}.`;
                }
                return humanizeCheckName(check.name);
        }
    }

    function highlightPrimaryValue(message, check) {
        const primaryValue = formatDisplayValue(check && check.value, inferFormatHint(check && check.name));
        if (!message || !primaryValue || primaryValue === '—') {
            return escapeHtml(message || '');
        }
        const escapedMessage = escapeHtml(message);
        const escapedValue = escapeHtml(primaryValue);
        return escapedMessage.replace(escapedValue, `<mark>${escapedValue}</mark>`);
    }

    function formatPyramidDetails(check) {
        if (!check.pyramids || !check.pyramids.length) {
            return '';
        }
        const items = check.pyramids.map((pyramid) => {
            const multiplier = pyramid.multiplier != null ? ` with multiplier of ${formatDisplayValue(pyramid.multiplier)}` : '';
            return `${pyramid.name}${multiplier}`;
        });

        if (check.result === 'PASS') {
            return `Pyramid theme ${items.join(', ')} matches.`;
        }
        return `These themes do not match with the following multipliers: ${items.join('; ')}.`;
    }

    function humanizeCheckName(name) {
        return String(name || '')
            .toLowerCase()
            .split(/[._]+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function inferFormatHint(name) {
        return /TURNOVER|RETURNS/i.test(String(name || '')) ? 'percent' : undefined;
    }

    function formatDisplayValue(value, formatHint) {
        if (value === undefined || value === null || value === '') {
            return '—';
        }
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return String(value);
        }
        if (formatHint === 'percent') {
            return `${stripTrailingZeros((value * 100).toFixed(2))}%`;
        }
        if (Number.isInteger(value)) {
            return String(value);
        }
        if (Math.abs(value) >= 100) {
            return stripTrailingZeros(value.toFixed(1));
        }
        if (Math.abs(value) >= 10) {
            return stripTrailingZeros(value.toFixed(2));
        }
        return stripTrailingZeros(value.toFixed(4));
    }

    function stripTrailingZeros(text) {
        return String(text).replace(/0+$/, '').replace(/\.$/, '');
    }

    function positionPanel(anchor) {
        ensurePanel();
        if (!anchor) {
            return;
        }

        panel.style.display = 'block';
        const rect = anchor.getBoundingClientRect();
        const margin = 14;
        const panelWidth = panel.offsetWidth || 620;
        const panelHeight = panel.offsetHeight || 240;

        let left = rect.right + margin;
        let top = Math.max(12, rect.top - 6);

        if (left + panelWidth + 12 > window.innerWidth) {
            const leftSide = rect.left - panelWidth - margin;
            if (leftSide >= 12) {
                left = leftSide;
            } else {
                left = Math.max(12, window.innerWidth - panelWidth - 12);
            }
        }

        if (top + panelHeight + 12 > window.innerHeight) {
            top = Math.max(12, window.innerHeight - panelHeight - 12);
        }

        panel.style.left = `${Math.max(12, left)}px`;
        panel.style.top = `${Math.max(12, top)}px`;
    }

    function repositionActivePanel() {
        if (activeAnchor && panel && panel.style.display === 'block') {
            positionPanel(activeAnchor);
        }
    }

    function scheduleHide() {
        clearHideTimer();
        hideTimer = window.setTimeout(() => {
            hidePanel();
        }, 120);
    }

    function clearHideTimer() {
        if (!hideTimer) {
            return;
        }
        window.clearTimeout(hideTimer);
        hideTimer = 0;
    }

    function hidePanel() {
        clearHideTimer();
        activeAnchor = null;
        activeAlphaId = null;
        activeLookupToken += 1;
        if (panel) {
            panel.style.display = 'none';
        }
    }

    function buildDebugSummary(target, alphaId) {
        const row = resolveRowElement(target);
        const rowText = row && typeof row.textContent === 'string'
            ? row.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)
            : 'no-row-text';
        const datasetSummary = summarizeDatasets(target, row);
        return `alpha=${alphaId || 'none'}; cache=${latestAlphaOrder.length}; dataset=${datasetSummary}; row=${rowText}`;
    }

    function summarizeDatasets(target, row) {
        const nodes = [target, row].filter(Boolean);
        return nodes.map((node) => {
            const dataset = node && node.dataset ? Object.keys(node.dataset).slice(0, 6).join('|') : '';
            return dataset || 'none';
        }).join(' / ');
    }

    function compareChecks(left, right) {
        const leftPriority = FAILURE_PRIORITY.get(left.name) || Number.MAX_SAFE_INTEGER;
        const rightPriority = FAILURE_PRIORITY.get(right.name) || Number.MAX_SAFE_INTEGER;
        if (leftPriority !== rightPriority) {
            return leftPriority - rightPriority;
        }
        return left.name.localeCompare(right.name);
    }

    function isPassResult(result) {
        return String(result || '').toUpperCase() === 'PASS';
    }

    function isPendingResult(result) {
        return String(result || '').toUpperCase() === 'PENDING';
    }

    function normalizeScalar(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) {
                return null;
            }
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? parsed : trimmed;
        }
        return value;
    }

    function toOptionalNumber(value, fallback) {
        const numeric = toFiniteNumber(value);
        return numeric == null ? fallback : numeric;
    }

    function toFiniteNumber(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function formatNumber(value) {
        return formatDisplayValue(value);
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
})();
