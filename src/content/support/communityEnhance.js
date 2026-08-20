const {
    authorIdFrom,
    badgeKey,
    classifyInlineCode,
    guessLang,
    highlightFastExpr,
    looksLikeFastExpr,
    normalizeFollowedIds,
} = globalThis.WQPCommunityEnhanceCore;

if (!window.__WQP_COMMUNITY_ENHANCE__) {
    window.__WQP_COMMUNITY_ENHANCE__ = true;

    const FOLLOW_KEY = 'WQP_CommunityFollowedUsers';
    let followed = new Set();

    function loadFollowed() {
        return new Promise((resolve) => {
            if (!chrome?.storage?.local) {
                resolve(new Set());
                return;
            }
            chrome.storage.local.get(FOLLOW_KEY, (items) => {
                resolve(new Set(normalizeFollowedIds(items?.[FOLLOW_KEY])));
            });
        });
    }

    function saveFollowed() {
        if (!chrome?.storage?.local) return;
        chrome.storage.local.set({ [FOLLOW_KEY]: [...followed] });
    }

    function looksLikeDate(text) {
        return /ago|edited|yesterday|just now|\d{4}-\d{2}-\d{2}|小时|天前|分钟|刚刚|月前|年前|编辑/i.test(
            String(text || '').trim(),
        );
    }

    function paintBadges(root) {
        const scope = root?.querySelectorAll ? root : document;
        scope.querySelectorAll('.community-badge-title').forEach((el) => {
            const key = badgeKey(el.textContent);
            if (key) el.setAttribute('data-wqp-ce', key);
        });
    }

    function looksLikeCodeText(text) {
        const value = String(text || '').trim();
        if (value.length < 12) return false;
        return /coding\s*:\s*utf-8/i.test(value)
            || /^\s*(#|\/\/|\/\*|"""|'''|\{|def |class |import |from |function |const |let |var )/m.test(value)
            || /["']prod["']\s*:/.test(value)
            || /\bfastplus\b/.test(value);
    }

    function markCodeBlocks(root) {
        const scope = root?.querySelectorAll ? root : document;
        scope.querySelectorAll('pre, code, .highlight, .highlighter-rouge').forEach((el) => {
            el.classList.add('wqp-ce-code');
        });
        scope.querySelectorAll('.post-body, .comment-body, .post-content').forEach((body) => {
            [...body.children].forEach((el) => {
                if (el.matches('pre, code, .wqp-ce-code')) return;
                if (!looksLikeCodeText(el.textContent)) return;
                const style = window.getComputedStyle(el);
                if (style.whiteSpace.startsWith('pre') || parseFloat(style.borderTopWidth) > 0) {
                    el.classList.add('wqp-ce-code');
                }
            });
        });
    }

    function paintBrainTokens(rootEl) {
        const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach((node) => {
            const parent = node.parentElement;
            if (!parent) return;
            if (parent.closest('.wqp-ce-op, .wqp-ce-field, .wqp-ce-api, .hljs-comment, .hljs-keyword')) {
                return;
            }
            const text = node.nodeValue;
            if (!text || !/[A-Za-z_]/.test(text)) return;
            if (parent.closest('.hljs-string') && !looksLikeFastExpr(text)) return;
            const html = highlightFastExpr(text);
            if (!html.includes('wqp-ce-')) return;
            const wrap = document.createElement('span');
            wrap.innerHTML = html;
            parent.replaceChild(wrap, node);
        });
    }

    function highlightCode(root) {
        const scope = root?.querySelectorAll ? root : document;
        scope.querySelectorAll('code').forEach((el) => {
            if (el.closest('pre') || el.dataset.wqpCeHl === '1') return;
            const kind = classifyInlineCode(el.textContent);
            if (kind) el.classList.add(`wqp-ce-inline-${kind}`);
        });

        const hljs = window.hljs;
        const targets = [];
        scope.querySelectorAll('pre code, pre, code').forEach((el) => {
            if (el.dataset.wqpCeHl === '1') return;
            if (el.tagName === 'PRE' && el.querySelector('code')) return;
            if (el.tagName === 'CODE' && !el.closest('pre') && el.textContent.length < 48) return;
            targets.push(el);
        });
        targets.forEach((el) => {
            const lang = guessLang(el.textContent);
            if (lang) el.classList.add(`language-${lang}`);
            try {
                hljs?.highlightElement?.(el);
            } catch (_) {
                /* ignore malformed blocks */
            }
            paintBrainTokens(el);
            el.dataset.wqpCeHl = '1';
        });
    }

    function findRow(el) {
        const preferred = el.closest(
            '.striped-list-item, .posts-list > ul > li, .posts-list li, .comment-wrapper, .comment',
        );
        if (preferred && preferred !== el && preferred.getBoundingClientRect().width >= 280) {
            return preferred;
        }
        let node = el.parentElement;
        while (node && node !== document.body) {
            if (node.classList.contains('meta-group') || node.classList.contains('meta-data')) {
                node = node.parentElement;
                continue;
            }
            const width = node.getBoundingClientRect().width;
            const tag = node.tagName;
            if (
                width >= 280
                && (tag === 'SECTION' || tag === 'ARTICLE' || tag === 'LI'
                    || node.classList.contains('striped-list-item')
                    || node.classList.contains('post'))
            ) {
                return node;
            }
            node = node.parentElement;
        }
        return preferred && preferred !== el ? preferred : null;
    }

    function collectAuthorNodes(root) {
        const scope = root?.querySelectorAll ? root : document;
        const nodes = [];
        scope.querySelectorAll('.meta-group .meta-data').forEach((el) => {
            if (looksLikeDate(el.textContent)) return;
            if (authorIdFrom(el.textContent)) nodes.push(el);
        });
        scope.querySelectorAll(
            '.post-meta a, .post-meta > span, .comment-meta a, .comment-author, .comment-author a, .comment-author strong, .post-author a, a[href*="/profiles/"], a[href*="/community/users/"]',
        ).forEach((el) => {
            if (authorIdFrom(el.textContent)) nodes.push(el);
        });
        return nodes.filter((el, index) => !nodes.some((other, otherIndex) => otherIndex !== index && el.contains(other)));
    }

    function syncFollowButton(btn, id) {
        const on = followed.has(id.toLowerCase());
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.title = on ? `取消关注 ${id}` : `关注 ${id}`;
        btn.textContent = on ? '★' : '☆';
    }

    function ensureFollowButton(authorEl, id) {
        const row = findRow(authorEl);
        row?.querySelectorAll('.wqp-ce-follow-btn').forEach((btn) => {
            if (!authorIdFrom(btn.parentElement?.textContent || '')) btn.remove();
        });

        let btn = authorEl.querySelector(':scope > .wqp-ce-follow-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wqp-ce-follow-btn';
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const key = id.toLowerCase();
                if (followed.has(key)) followed.delete(key);
                else followed.add(key);
                saveFollowed();
                paintFollows(document);
            });
            authorEl.appendChild(btn);
        }
        syncFollowButton(btn, id);
        return btn;
    }

    function paintFollows(root) {
        document.querySelectorAll('.wqp-ce-followed-post').forEach((el) => el.classList.remove('wqp-ce-followed-post'));
        document.querySelectorAll('.wqp-ce-followed-author').forEach((el) => el.classList.remove('wqp-ce-followed-author'));

        collectAuthorNodes(root).forEach((el) => {
            const id = authorIdFrom(el.textContent);
            if (!id) return;
            const row = findRow(el);
            ensureFollowButton(el, id);
            if (!followed.has(id.toLowerCase())) return;
            el.classList.add('wqp-ce-followed-author');
            if (row && row.matches('.striped-list-item, .posts-list li')) {
                row.classList.add('wqp-ce-followed-post');
            }
        });
    }

    function start() {
        paintBadges(document);
        markCodeBlocks(document);
        highlightCode(document);
        paintFollows(document);

        let timer = 0;
        const observer = new MutationObserver((records) => {
            const relevant = records.some((record) => [...record.addedNodes].some((node) => {
                if (node.nodeType !== 1) return false;
                const cls = node.classList;
                if (!cls) return true;
                if (cls.contains('wqp-ce-follow-btn') || cls.contains('wqp-ce-code')
                    || cls.contains('wqp-ce-op') || cls.contains('wqp-ce-field') || cls.contains('wqp-ce-api')) {
                    return false;
                }
                return ![...cls].some((name) => name.startsWith('hljs'));
            }));
            if (!relevant) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                paintBadges(document);
                markCodeBlocks(document);
                highlightCode(document);
                paintFollows(document);
            }, 50);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    loadFollowed().then((ids) => {
        followed = ids;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    });

    chrome.storage?.onChanged?.addListener((changes, namespace) => {
        if (namespace !== 'local' || !changes[FOLLOW_KEY]) return;
        followed = new Set(normalizeFollowedIds(changes[FOLLOW_KEY].newValue));
        paintFollows(document);
    });
}
