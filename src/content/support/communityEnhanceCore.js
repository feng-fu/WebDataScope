(function initCommunityEnhanceCore(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.WQPCommunityEnhanceCore = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const BRAIN_OPS = new Set([
        'abs', 'add', 'and', 'arc_cos', 'arc_sin', 'bucket', 'ceiling', 'convert',
        'days_from_last_change', 'densify', 'divide', 'equal', 'floor', 'greater',
        'greater_equal', 'group_backfill', 'group_coalesce', 'group_max', 'group_mean',
        'group_median', 'group_min', 'group_neutralize', 'group_normalize', 'group_rank',
        'group_scale', 'group_vector_neut', 'group_zscore', 'hump', 'hump_decay',
        'if_else', 'inst_tvr', 'inverse', 'is_nan', 'jump_decay', 'kth_element',
        'last_diff_value', 'left_tail', 'less', 'less_equal', 'log', 'log_diff', 'max',
        'min', 'multiply', 'negate', 'normalize', 'not', 'not_equal', 'one_side', 'or',
        'power', 'quantile', 'rank', 'rank_by_side', 'regression_neut', 'replace',
        'reverse', 'right_tail', 's_log_1p', 'scale', 'scale_down', 'sign',
        'signed_power', 'sqrt', 'subtract', 'to_nan', 'trade_when', 'truncate',
        'ts_arg_max', 'ts_arg_min', 'ts_av_diff', 'ts_backfill', 'ts_co_kurtosis',
        'ts_corr', 'ts_count_nans', 'ts_covariance', 'ts_decay_exp_window',
        'ts_decay_linear', 'ts_delay', 'ts_delta', 'ts_delta_limit', 'ts_max',
        'ts_mean', 'ts_median', 'ts_min', 'ts_partial_corr', 'ts_product',
        'ts_quantile', 'ts_rank', 'ts_regression', 'ts_scale', 'ts_std_dev', 'ts_step',
        'ts_sum', 'ts_target_tvr_decay', 'ts_target_tvr_delta_limit',
        'ts_target_tvr_hump', 'ts_triple_corr', 'ts_vector_proj', 'ts_weighted_decay',
        'ts_zscore', 'vec_avg', 'vec_choose', 'vec_count', 'vec_max', 'vec_min',
        'vec_percentage', 'vec_sum', 'vector_neut', 'winsorize', 'zscore',
    ]);

    const BRAIN_FIELDS = new Set([
        'adv20', 'adv60', 'cap', 'close', 'country', 'currency', 'dividend',
        'exchange', 'high', 'industry', 'low', 'market', 'open', 'returns',
        'sector', 'sharesout', 'split', 'split_factor', 'subindustry', 'volume', 'vwap',
    ]);

    const BRAIN_API = new Set([
        'Alpha', 'Group', 'ValueError', 'Vector', 'assignments', 'fastplus',
        'fields', 'group', 'matrix', 'operators', 'parse', 'signal', 'value',
        'variable', 'vector',
    ]);

    function escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function guessLang(text) {
        const value = String(text || '');
        if (/^\s*[{\[]/.test(value.trim()) || /"[A-Za-z0-9_]+"\s*:/.test(value)) return 'json';
        if (
            /#\s*-\*-\s*coding/.test(value)
            || /^\s*(def |class |import |from |async def )/m.test(value)
            || /"""/.test(value)
            || /\bfastplus\b/.test(value)
        ) {
            return 'python';
        }
        if (/^\s*(function |const |let |var |import )/m.test(value) || /=>/.test(value)) {
            return 'javascript';
        }
        return '';
    }

    function looksLikeFastExpr(text) {
        const value = String(text || '');
        if (!/[a-z_]+\s*\(/i.test(value)) return false;
        return /\b(ts_|group_|vec_|rank|bucket|trade_when|if_else|hump|normalize|winsorize)/.test(value)
            || /\b(close|open|high|low|volume|returns|vwap|industry)\b/.test(value);
    }

    function highlightIdentifier(id) {
        if (BRAIN_OPS.has(id)) return `<span class="wqp-ce-op">${id}</span>`;
        if (BRAIN_FIELDS.has(id)) return `<span class="wqp-ce-field">${id}</span>`;
        if (BRAIN_API.has(id)) return `<span class="wqp-ce-api">${id}</span>`;
        return escapeHtml(id);
    }

    function highlightTokens(text, includeStrings) {
        const tokenPattern = includeStrings
            ? /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)|([\s\S])/g
            : /(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)|([\s\S])/g;
        let out = '';
        let match;

        while ((match = tokenPattern.exec(String(text ?? '')))) {
            if (includeStrings && match[1]) {
                const quoted = match[1];
                const quote = quoted[0];
                const inner = quoted.slice(1, -1);
                const content = looksLikeFastExpr(inner)
                    ? highlightTokens(inner, false)
                    : escapeHtml(inner);
                out += `<span class="hljs-string">${quote}${content}${quote}</span>`;
            } else {
                const number = includeStrings ? match[2] : match[1];
                const identifier = includeStrings ? match[3] : match[2];
                const character = includeStrings ? match[4] : match[3];
                if (number) out += `<span class="hljs-number">${number}</span>`;
                else if (identifier) out += highlightIdentifier(identifier);
                else out += escapeHtml(character);
            }
        }
        return out;
    }

    function highlightFastExpr(text) {
        return highlightTokens(text, true);
    }

    function classifyInlineCode(word) {
        const value = String(word || '').trim();
        if (BRAIN_OPS.has(value)) return 'op';
        if (BRAIN_FIELDS.has(value)) return 'field';
        if (BRAIN_API.has(value)) return 'api';
        return '';
    }

    function authorIdFrom(text) {
        const value = String(text || '')
            .replace(/[★☆]/g, '')
            .trim()
            .split(/\s+/)[0];
        return /^[A-Za-z]{2}\d{4,}$/.test(value) ? value : '';
    }

    function badgeKey(text) {
        const value = String(text || '').trim().toLowerCase();
        if (value.includes('gold') || value.includes('金')) return 'gold';
        if (value.includes('silver') || value.includes('银')) return 'silver';
        if (value.includes('bronze') || value.includes('铜')) return 'bronze';
        if (value.includes('staff') || value.includes('official') || value.includes('官方')) return 'staff';
        if (value.includes('consultant') || value.includes('顾问')) return 'consultant';
        return '';
    }

    function normalizeFollowedIds(raw) {
        const list = Array.isArray(raw) ? raw : [];
        return [...new Set(list.map((id) => String(id).trim().toLowerCase()).filter(Boolean))];
    }

    return {
        BRAIN_OPS,
        BRAIN_FIELDS,
        BRAIN_API,
        escapeHtml,
        guessLang,
        looksLikeFastExpr,
        highlightFastExpr,
        classifyInlineCode,
        authorIdFrom,
        badgeKey,
        normalizeFollowedIds,
    };
}));
