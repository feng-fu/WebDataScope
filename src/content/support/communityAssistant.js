(function () {
    'use strict';

    if (window.__WQP_COMMUNITY_AI_ASSISTANT__) return;
    window.__WQP_COMMUNITY_AI_ASSISTANT__ = true;

    const POST_URL_PATTERN = /^https:\/\/support\.worldquantbrain\.com\/hc\/[^/]+\/community\/posts\/\d+/;
    if (!POST_URL_PATTERN.test(location.href)) return;

    const MIN_CARD_WIDTH = 300;
    const MIN_CARD_HEIGHT = 132;

    let latestSummary = null;
    let latestDraft = null;
    let latestInstruction = '';
    let card = null;

    function sendMessage(type, payload = {}) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type, ...payload }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!response?.ok) {
                    reject(new Error(response?.error || `请求失败：${type}`));
                    return;
                }
                resolve(response.data);
            });
        });
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function inlineMarkdownHtml(value) {
        return escapeHtml(value)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    }

    function markdownToHtml(value) {
        const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
        const blocks = [];
        let paragraph = [];
        let listItems = [];
        let listOrdered = false;

        const flushParagraph = () => {
            if (!paragraph.length) return;
            blocks.push(`<p>${paragraph.map(inlineMarkdownHtml).join('<br>')}</p>`);
            paragraph = [];
        };
        const flushList = () => {
            if (!listItems.length) return;
            const tag = listOrdered ? 'ol' : 'ul';
            blocks.push(`<${tag}>${listItems.map((item) => `<li>${inlineMarkdownHtml(item)}</li>`).join('')}</${tag}>`);
            listItems = [];
        };

        lines.forEach((rawLine) => {
            const line = rawLine.trim();
            if (!line) {
                flushParagraph();
                flushList();
                return;
            }
            const heading = line.match(/^(#{1,4})\s+(.+)$/);
            if (heading) {
                flushParagraph();
                flushList();
                const level = Math.min(4, heading[1].length + 1);
                blocks.push(`<h${level}>${inlineMarkdownHtml(heading[2])}</h${level}>`);
                return;
            }
            const numbered = line.match(/^\d+[.)]\s+(.+)$/);
            const bulleted = line.match(/^[-*+]\s+(.+)$/);
            if (numbered || bulleted) {
                flushParagraph();
                const isOrdered = Boolean(numbered);
                if (listItems.length && listOrdered !== isOrdered) flushList();
                listOrdered = isOrdered;
                listItems.push(numbered?.[1] || bulleted?.[1] || line);
                return;
            }
            flushList();
            paragraph.push(line);
        });

        flushParagraph();
        flushList();
        return blocks.join('') || '<p class="wqp-ai-muted">暂无内容。</p>';
    }

    function formatDateTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('zh-CN');
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function constrainCardToViewport() {
        if (!card) return;
        const rect = card.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - Math.min(rect.width, window.innerWidth - 16) - 8);
        const maxTop = Math.max(8, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8);
        card.style.left = `${clamp(rect.left, 8, maxLeft)}px`;
        card.style.top = `${clamp(rect.top, 8, maxTop)}px`;
        card.style.right = 'auto';
    }

    function setCollapsed(collapsed) {
        if (!card) return;
        card.classList.toggle('is-collapsed', collapsed);
        const toggle = card.querySelector('[data-action="toggle-collapse"]');
        if (toggle) {
            toggle.textContent = collapsed ? '展开' : '收起';
            toggle.setAttribute('aria-label', collapsed ? '展开 AI 助手卡片' : '收起 AI 助手卡片');
        }
        if (!collapsed && !card.style.height) {
            card.style.height = '';
        }
    }

    function bindCardWindowInteractions() {
        if (!card || card.dataset.boundWindow === 'true') return;
        card.dataset.boundWindow = 'true';
        let dragState = null;

        card.addEventListener('pointerdown', (event) => {
            const handle = event.target?.closest?.('.wqp-ai-card-head');
            if (!handle || event.target.closest('button, input, textarea, select, a, summary')) return;
            const rect = card.getBoundingClientRect();
            dragState = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
            };
            card.setPointerCapture?.(event.pointerId);
            card.classList.add('is-dragging');
            event.preventDefault();
        });

        card.addEventListener('pointermove', (event) => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;
            const nextLeft = dragState.left + event.clientX - dragState.startX;
            const nextTop = dragState.top + event.clientY - dragState.startY;
            const maxLeft = Math.max(8, window.innerWidth - dragState.width - 8);
            const maxTop = Math.max(8, window.innerHeight - dragState.height - 8);
            card.style.left = `${clamp(nextLeft, 8, maxLeft)}px`;
            card.style.top = `${clamp(nextTop, 8, maxTop)}px`;
            card.style.right = 'auto';
        });

        card.addEventListener('pointerup', (event) => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;
            dragState = null;
            card.releasePointerCapture?.(event.pointerId);
            card.classList.remove('is-dragging');
        });

        card.addEventListener('pointercancel', () => {
            dragState = null;
            card.classList.remove('is-dragging');
        });

        window.addEventListener('resize', () => {
            constrainCardToViewport();
        });
    }

    function ensureCard() {
        if (card) return card;
        if (!document.body) return null;

        card = document.createElement('div');
        card.id = 'wqp-community-ai-prompt';
        card.innerHTML = `
            <div class="wqp-ai-card-head">
                <div class="wqp-ai-card-title-row">
                    <div class="wqp-ai-prompt-title">AI 论坛助手</div>
                    <div class="wqp-ai-window-actions">
                        <span class="wqp-ai-badge">已启用</span>
                        <button type="button" class="wqp-ai-window-button" data-action="toggle-collapse" aria-label="收起 AI 助手卡片">收起</button>
                    </div>
                </div>
                <div class="wqp-ai-prompt-body">总结当前帖子及评论，并可按需生成回复草稿。</div>
            </div>
            <div class="wqp-ai-card-content">
                <div class="wqp-ai-intro">只有在你请求总结后才会调用 AI。</div>
                <div class="wqp-ai-prompt-actions">
                    <button type="button" class="wqp-ai-primary" data-action="summarize">AI 总结</button>
                </div>
                <div class="wqp-ai-prompt-status"></div>
            </div>
        `;
        card.addEventListener('click', handleCardClick);
        card.addEventListener('input', handleCardInput);
        document.body.appendChild(card);
        bindCardWindowInteractions();
        return card;
    }

    function setCardContent(html) {
        ensureCard();
        const content = card?.querySelector('.wqp-ai-card-content');
        if (content) content.innerHTML = html;
    }

    function setCardStatus(text, mode = '') {
        ensureCard();
        const status = card?.querySelector('.wqp-ai-prompt-status');
        if (!status) return;
        status.textContent = text || '';
        status.className = `wqp-ai-prompt-status${mode ? ` ${mode}` : ''}`;
    }

    function setCardLoading(text) {
        setCardContent(`
            <div class="wqp-ai-loading">${escapeHtml(text)}</div>
            <div class="wqp-ai-prompt-status loading">${escapeHtml(location.href)}</div>
        `);
    }

    function setCardError(error) {
        setCardContent(`
            <div class="wqp-ai-error">
                <strong>操作失败</strong>
                <p>${escapeHtml(error.message || String(error))}</p>
            </div>
            <div class="wqp-ai-prompt-actions">
                <button type="button" class="wqp-ai-primary" data-action="summarize">重新总结</button>
            </div>
        `);
    }

    async function showCardIfEnabled() {
        try {
            const config = await sendMessage('WQP_LLM_CONFIG_GET');
            if (config?.enabled === true) {
                ensureCard();
                setCollapsed(config.defaultCollapsed === true);
                await loadCachedSummary();
            }
        } catch (error) {
            console.warn('[WQP AI] 无法读取 AI 设置：', error);
        }
    }

    async function markCurrentPostRead() {
        const postId = location.pathname.match(/\/community\/posts\/(\d+)/)?.[1] || '';
        if (!postId) return;
        const title = document.querySelector('.community-post h1, .post-title, h1')?.textContent?.trim()
            || document.title.replace(/\s+[–-]\s+WorldQuant BRAIN.*$/i, '').trim();
        const postDate = document.querySelector('.community-post time[datetime], article time[datetime], time[datetime]')
            ?.getAttribute('datetime') || '';
        try {
            await sendMessage('WQP_COMMUNITY_POST_MARK_READ', {
                postId,
                postUrl: location.href,
                title,
                postDate,
            });
        } catch (error) {
            console.warn('[WQP Community] 无法记录帖子阅读状态：', error);
        }
    }

    function initialize() {
        markCurrentPostRead();
        showCardIfEnabled();
    }

    async function loadCachedSummary() {
        try {
            const data = await sendMessage('WQP_COMMUNITY_AI_GET_CACHED_SUMMARY', { postUrl: location.href });
            if (data?.summaryMarkdown) {
                renderSummary(data);
            }
        } catch (error) {
            console.warn('[WQP AI] 无法加载缓存的总结：', error);
        }
    }

    function renderSummary(data) {
        latestSummary = data;
        latestDraft = null;
        const source = data.source || {};
        const commentCount = `${source.commentCount || 0}/${source.totalCommentCount || 0}`;
        const cacheTime = formatDateTime(data.cache?.savedAt || source.fetchedAt);
        const statusText = data.cached ? '已加载缓存的总结。' : '总结已生成并保存。';
        const markdown = data.summaryMarkdown || '';
        setCardContent(`
            <div class="wqp-ai-summary-head">
                <div class="wqp-ai-source" title="${escapeHtml(source.title || '论坛帖子')}">${escapeHtml(source.title || '论坛帖子')}</div>
                <span class="wqp-ai-badge ${data.cached ? 'is-cached' : 'is-fresh'}">${data.cached ? '已缓存' : '新生成'}</span>
            </div>
            <div class="wqp-ai-meta">
                <span>评论 ${escapeHtml(commentCount)}</span>
                ${cacheTime ? `<span>${escapeHtml(cacheTime)}</span>` : ''}
            </div>
            <div class="wqp-ai-markdown">
                ${markdownToHtml(markdown)}
            </div>
            <label class="wqp-ai-field wqp-ai-comment-box">
                <span>回复要求</span>
                <textarea id="wqp-ai-comment-instruction" rows="3" placeholder="可选：语气、回复角度或其他限制">${escapeHtml(latestInstruction)}</textarea>
            </label>
            <div class="wqp-ai-prompt-actions">
                <button type="button" class="wqp-ai-primary" data-action="draft">生成回复</button>
                <button type="button" data-action="refresh-summary">重新总结</button>
            </div>
            <div class="wqp-ai-prompt-status success">${escapeHtml(statusText)}</div>
        `);
    }

    function renderDraft(data) {
        latestDraft = data;
        const draft = data.draft || {};
        const markdown = draft.commentMarkdown || draft.commentText || '';
        setCardContent(`
            <div class="wqp-ai-summary-head">
                <div class="wqp-ai-source" title="${escapeHtml(latestSummary?.source?.title || '论坛帖子')}">${escapeHtml(latestSummary?.source?.title || '论坛帖子')}</div>
                <span class="wqp-ai-badge">草稿</span>
            </div>
            <div class="wqp-ai-draft-preview" id="wqp-ai-comment-preview">
                <div class="wqp-ai-preview-title">Markdown 预览</div>
                ${markdownToHtml(markdown)}
            </div>
            <label class="wqp-ai-field">
                <span>可编辑的 Markdown</span>
                <textarea id="wqp-ai-comment-draft" rows="8">${escapeHtml(markdown)}</textarea>
            </label>
            <div class="wqp-ai-prompt-actions">
                <button type="button" class="wqp-ai-primary" data-action="insert">插入草稿</button>
                <button type="button" data-action="post">发布回复</button>
                <button type="button" data-action="draft">重新生成</button>
                <button type="button" data-action="show-summary">返回总结</button>
            </div>
            <div class="wqp-ai-prompt-status success">回复草稿已生成。</div>
        `);
    }

    async function runSummary(forceRefresh = false) {
        try {
            setCardLoading(forceRefresh ? '正在使用 AI 重新总结…' : '正在检查已保存的总结…');
            const data = await sendMessage('WQP_COMMUNITY_AI_SUMMARIZE_POST', {
                postUrl: location.href,
                forceRefresh,
            });
            renderSummary(data);
        } catch (error) {
            setCardError(error);
        }
    }

    async function runDraft() {
        try {
            const instructionInput = document.getElementById('wqp-ai-comment-instruction');
            const instruction = instructionInput ? instructionInput.value : latestInstruction;
            latestInstruction = instruction;
            setCardStatus('正在生成回复草稿…', 'loading');
            const data = await sendMessage('WQP_COMMUNITY_AI_DRAFT_COMMENT', {
                postUrl: latestSummary?.source?.postUrl || location.href,
                customInstruction: instruction,
            });
            renderDraft(data);
        } catch (error) {
            setCardStatus(error.message || String(error), 'error');
        }
    }

    function setNativeInputValue(element, value) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function insertDraftIntoPage() {
        const text = document.getElementById('wqp-ai-comment-draft')?.value?.trim();
        if (!text) {
            setCardStatus('没有可插入的回复草稿。', 'error');
            return false;
        }
        const editor = document.querySelector('textarea[name="body"], textarea#comment_body, .comment-form textarea, [contenteditable="true"], .ck-editor__editable, trix-editor');
        if (!editor) {
            setCardStatus('当前页面未找到回复编辑器。', 'error');
            return false;
        }
        editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        editor.focus();
        if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
            setNativeInputValue(editor, text);
        } else if (editor.tagName === 'TRIX-EDITOR' && editor.editor) {
            editor.editor.loadHTML(markdownToHtml(text));
        } else {
            editor.innerHTML = markdownToHtml(text);
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
        setCardStatus('草稿已插入页面编辑器。', 'success');
        return true;
    }

    async function postDraft() {
        const text = document.getElementById('wqp-ai-comment-draft')?.value?.trim();
        if (!text) {
            setCardStatus('没有可发布的回复草稿。', 'error');
            return;
        }
        if (!confirm(`确定将这条 AI 回复发布到当前论坛帖子吗？\n\n${text}`)) return;
        try {
            setCardLoading('正在发布回复…');
            const data = await sendMessage('WQP_COMMUNITY_AI_POST_COMMENT', {
                postUrl: latestDraft?.source?.postUrl || location.href,
                commentText: text,
            });
            setCardContent(`
                <div class="wqp-ai-success">
                    <strong>回复已发布。</strong>
                    <p>${escapeHtml(data.comment?.url || '')}</p>
                </div>
                <div class="wqp-ai-prompt-actions">
                    <button type="button" class="wqp-ai-primary" data-action="refresh-summary">重新总结</button>
                </div>
            `);
        } catch (error) {
            setCardError(error);
        }
    }

    function handleCardClick(event) {
        const action = event.target?.dataset?.action;
        if (!action) return;
        if (action === 'toggle-collapse') {
            setCollapsed(!card?.classList.contains('is-collapsed'));
            return;
        }
        if (action === 'summarize') runSummary(false);
        if (action === 'refresh-summary') runSummary(true);
        if (action === 'show-summary' && latestSummary) renderSummary(latestSummary);
        if (action === 'draft') runDraft();
        if (action === 'insert') insertDraftIntoPage();
        if (action === 'post') postDraft();
    }

    function handleCardInput(event) {
        if (event.target?.id !== 'wqp-ai-comment-draft') return;
        const preview = document.getElementById('wqp-ai-comment-preview');
        if (!preview) return;
        preview.innerHTML = `
            <div class="wqp-ai-preview-title">Markdown 预览</div>
            ${markdownToHtml(event.target.value)}
        `;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
