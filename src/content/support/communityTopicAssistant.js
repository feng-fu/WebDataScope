(function () {
    'use strict';

    if (window.__WQP_COMMUNITY_TOPIC_AI_ASSISTANT__) return;
    window.__WQP_COMMUNITY_TOPIC_AI_ASSISTANT__ = true;

    const TOPIC_URL_PATTERN = /^https:\/\/support\.worldquantbrain\.com\/hc\/[^/]+\/community\/topics\/\d+/;
    if (!TOPIC_URL_PATTERN.test(location.href)) return;

    let card = null;
    let posts = [];
    let statusByPost = {};
    let markerByPost = {};
    let aiEnabled = false;
    let markerRefreshPromise = null;
    let aiStatusRefreshPromise = null;
    let showUnreadOnly = false;
    let skipPosted = true;
    let customInstruction = '';
    let running = false;
    let stopRequested = false;
    const results = new Map();

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
        return blocks.join('') || '<p class="wqp-topic-ai-muted">暂无内容。</p>';
    }

    function extractPostId(value) {
        try {
            return new URL(value, location.href).pathname.match(/\/community\/posts\/(\d+)/)?.[1] || '';
        } catch (_) {
            return '';
        }
    }

    function formatDateTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('zh-CN');
    }

    function safeHttpUrl(value) {
        const rawUrl = String(value || '').trim();
        if (!rawUrl) return '';
        try {
            const url = new URL(rawUrl, location.origin);
            return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
        } catch (_) {
            return '';
        }
    }

    function scanPosts() {
        const anchors = document.querySelectorAll(
            '#main-content.posts-list a.striped-list-title[href*="/community/posts/"],'
            + '.posts-list a.striped-list-title[href*="/community/posts/"]',
        );
        const seen = new Set();
        return Array.from(anchors).map((anchor) => {
            const postId = extractPostId(anchor.href);
            if (!postId || seen.has(postId)) return null;
            seen.add(postId);
            const section = anchor.closest('section[role="region"]') || anchor.closest('section');
            const row = anchor.closest('.striped-list-item') || section;
            const postDate = row?.querySelector('.meta-group time[datetime], time[datetime]')?.getAttribute('datetime') || '';
            return {
                postId,
                postUrl: anchor.href,
                title: anchor.textContent?.trim() || `帖子 ${postId}`,
                postDate,
                anchor,
                row,
            };
        }).filter(Boolean);
    }

    function isPosted(postId) {
        return Boolean(statusByPost[postId]?.lastPostedComment);
    }

    function selectedPosts() {
        const selectedIds = new Set(Array.from(document.querySelectorAll('.wqp-topic-ai-select-input:checked'))
            .map((input) => input.dataset.postId));
        return posts.filter((post) => selectedIds.has(post.postId)
            && !(skipPosted && isPosted(post.postId))
            && !(showUnreadOnly && markerByPost[post.postId]?.readAt));
    }

    function updateSelectionCount() {
        const target = card?.querySelector('[data-role="selection-count"]');
        const availableCount = showUnreadOnly
            ? posts.filter((post) => !markerByPost[post.postId]?.readAt).length
            : posts.length;
        if (target) target.textContent = `已选择 ${selectedPosts().length}/${availableCount} 个帖子`;
    }

    function ensureUnreadFilterButton() {
        const followButton = document.querySelector(
            'button[aria-label="Following Topic"],'
            + 'button[aria-label="Follow Topic"],'
            + 'button[aria-haspopup="true"][data-follower-count]',
        );
        if (!followButton?.parentElement) return null;

        let button = document.getElementById('wqp-topic-unread-filter-button');
        if (!button) {
            button = document.createElement('button');
            button.id = 'wqp-topic-unread-filter-button';
            button.type = 'button';
            button.dataset.action = 'toggle-unread-filter';
            button.setAttribute('aria-controls', 'main-content');
        }
        if (!button.querySelector('[data-role="unread-filter-label"]')) {
            button.innerHTML = `
                <svg class="wqp-topic-unread-filter-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z"></path>
                    <circle cx="12" cy="12" r="2.6"></circle>
                </svg>
                <span data-role="unread-filter-label"></span>
                <span class="wqp-topic-unread-filter-count" data-role="unread-filter-count" aria-hidden="true"></span>
            `;
        }
        if (button.previousElementSibling !== followButton) {
            followButton.parentElement.insertBefore(button, followButton.nextSibling);
        }
        return button;
    }

    function applyUnreadFilter() {
        let unreadCount = 0;
        posts.forEach((post) => {
            const read = Boolean(markerByPost[post.postId]?.readAt);
            if (!read) unreadCount += 1;
            const item = post.row?.closest('section[role="region"]') || post.row;
            const filtered = showUnreadOnly && read;
            item?.classList?.toggle('wqp-topic-read-filtered', filtered);
            if (filtered) {
                const input = post.row?.querySelector(`.wqp-topic-ai-select-input[data-post-id="${post.postId}"]`);
                if (input) input.checked = false;
            }
        });

        const button = ensureUnreadFilterButton();
        if (button) {
            button.classList.toggle('is-active', showUnreadOnly);
            button.setAttribute('aria-pressed', String(showUnreadOnly));
            const label = button.querySelector('[data-role="unread-filter-label"]');
            const count = button.querySelector('[data-role="unread-filter-count"]');
            if (label) label.textContent = showUnreadOnly ? '显示本页面全部帖子' : '只显示本页面未阅读帖子';
            if (count) count.textContent = showUnreadOnly ? `${unreadCount}/${posts.length}` : String(unreadCount);
            button.setAttribute('aria-label', showUnreadOnly
                ? `显示本页面全部 ${posts.length} 个帖子；当前显示 ${unreadCount} 个未阅读帖子`
                : `只显示本页面 ${unreadCount} 个未阅读帖子`);
            button.title = showUnreadOnly
                ? `当前仅显示 ${unreadCount} 个未阅读帖子；点击恢复本页全部 ${posts.length} 个帖子`
                : `本页面共有 ${unreadCount} 个未阅读帖子`;
        }
        updateSelectionCount();
    }

    function decoratePosts() {
        posts.forEach((post) => {
            if (!post.row || !post.anchor) return;
            const markerHost = post.row.querySelector('.post-overview-item') || post.anchor.parentElement;
            let markerRail = post.row.querySelector(`.wqp-topic-marker-rail[data-post-id="${post.postId}"]`);
            if (!markerRail) {
                markerRail = document.createElement('span');
                markerRail.className = 'wqp-topic-marker-rail';
                markerRail.dataset.postId = post.postId;
                markerRail.setAttribute('aria-label', '帖子操作与状态');
                post.row.insertBefore(markerRail, post.row.firstChild);
            }
            let selector = post.row.querySelector(`.wqp-topic-ai-selector[data-post-id="${post.postId}"]`);
            if (aiEnabled && !selector) {
                selector = document.createElement('label');
                selector.className = 'wqp-topic-ai-selector';
                selector.dataset.postId = post.postId;
                selector.title = '选择此帖子交给 AI 论坛助手处理';
                selector.innerHTML = `
                    <input class="wqp-topic-ai-select-input" type="checkbox" data-post-id="${post.postId}">
                    <span>AI</span>
                `;
            }
            if (!aiEnabled && selector) {
                selector.remove();
                selector = null;
            }

            const input = selector?.querySelector('input');
            const posted = statusByPost[post.postId]?.lastPostedComment;
            if (input) {
                input.disabled = Boolean(skipPosted && posted);
                if (input.disabled) input.checked = false;
            }

            const postMarker = markerByPost[post.postId] || {};
            let readMarker = post.row.querySelector(`.wqp-topic-read-marker[data-post-id="${post.postId}"]`);
            if (postMarker.readAt && !readMarker) {
                readMarker = document.createElement('span');
                readMarker.className = 'wqp-topic-read-marker';
                readMarker.dataset.postId = post.postId;
            }
            if (readMarker) {
                readMarker.textContent = '已阅读';
                readMarker.title = postMarker.lastReadAt
                    ? `最近阅读：${formatDateTime(postMarker.lastReadAt)}`
                    : '此帖子已经打开阅读';
                readMarker.hidden = !postMarker.readAt;
            }

            let favoriteButton = post.row.querySelector(`.wqp-topic-favorite-button[data-post-id="${post.postId}"]`);
            if (!favoriteButton) {
                favoriteButton = document.createElement('button');
                favoriteButton.type = 'button';
                favoriteButton.className = 'wqp-topic-favorite-button';
                favoriteButton.dataset.postId = post.postId;
            }
            const favorite = postMarker.favorite === true;
            favoriteButton.classList.toggle('is-favorite', favorite);
            favoriteButton.textContent = favorite ? '★ 已收藏' : '☆ 收藏';
            favoriteButton.setAttribute('aria-pressed', String(favorite));
            favoriteButton.setAttribute('aria-label', favorite ? `取消收藏：${post.title}` : `收藏：${post.title}`);
            favoriteButton.title = favorite && postMarker.favoritedAt
                ? `收藏于 ${formatDateTime(postMarker.favoritedAt)}；点击取消收藏`
                : favorite ? '点击取消收藏' : '收藏此帖子';
            if (selector) markerRail.appendChild(selector);
            markerRail.appendChild(favoriteButton);
            if (readMarker) markerRail.appendChild(readMarker);
            post.row.querySelector(`.wqp-topic-title-markers[data-post-id="${post.postId}"]`)?.remove();

            let marker = post.row.querySelector(`.wqp-topic-ai-posted-marker[data-post-id="${post.postId}"]`);
            if (posted && !marker) {
                marker = document.createElement('span');
                marker.className = 'wqp-topic-ai-posted-marker';
                marker.dataset.postId = post.postId;
                markerHost?.appendChild(marker);
            }
            if (marker) {
                marker.textContent = 'AI 已评论';
                marker.title = posted?.postedAt
                    ? `AI 评论发布于 ${formatDateTime(posted.postedAt)}`
                    : '此帖子已经发布过 AI 评论';
                marker.hidden = !posted;
            }
        });
        applyUnreadFilter();
    }

    async function refreshPostMarkers() {
        if (!posts.length) return;
        if (markerRefreshPromise) return markerRefreshPromise;
        markerRefreshPromise = sendMessage('WQP_COMMUNITY_POST_MARKERS_GET', {
            postIds: posts.map((post) => post.postId),
        }).then((data) => {
            markerByPost = data?.byPost || {};
            decoratePosts();
        }).catch((error) => {
            console.warn('[WQP Community] 无法刷新阅读与收藏状态：', error);
        }).finally(() => {
            markerRefreshPromise = null;
        });
        return markerRefreshPromise;
    }

    function refreshAiPostStatuses() {
        if (!aiEnabled || !posts.length) return Promise.resolve();
        if (aiStatusRefreshPromise) return aiStatusRefreshPromise;
        aiStatusRefreshPromise = sendMessage('WQP_COMMUNITY_AI_GET_POST_STATUSES', {
            postIds: posts.map((post) => post.postId),
        }).then((data) => {
            statusByPost = data?.byPost || {};
            decoratePosts();
        }).catch((error) => {
            console.warn('[WQP Community] 无法读取 AI 评论状态：', error);
        }).finally(() => {
            aiStatusRefreshPromise = null;
        });
        return aiStatusRefreshPromise;
    }

    async function toggleFavorite(postId) {
        const post = posts.find((item) => item.postId === postId);
        if (!post) return;
        const button = post.row?.querySelector(`.wqp-topic-favorite-button[data-post-id="${postId}"]`);
        if (button) button.disabled = true;
        try {
            const marker = await sendMessage('WQP_COMMUNITY_POST_FAVORITE_SET', {
                postId,
                postUrl: post.postUrl,
                title: post.title,
                postDate: post.postDate,
                favorite: markerByPost[postId]?.favorite !== true,
            });
            markerByPost[postId] = marker || {};
            decoratePosts();
        } catch (error) {
            if (button) button.title = `收藏操作失败：${error.message || String(error)}`;
            console.warn('[WQP Community] 收藏操作失败：', error);
        } finally {
            if (button?.isConnected) button.disabled = false;
        }
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function constrainCardToViewport() {
        if (!card) return;
        const rect = card.getBoundingClientRect();
        const visibleWidth = Math.min(rect.width, window.innerWidth - 16);
        const visibleHeight = Math.min(rect.height, window.innerHeight - 16);
        const maxLeft = Math.max(8, window.innerWidth - visibleWidth - 8);
        const maxTop = Math.max(8, window.innerHeight - visibleHeight - 8);
        card.style.left = `${clamp(rect.left, 8, maxLeft)}px`;
        card.style.top = `${clamp(rect.top, 8, maxTop)}px`;
        card.style.right = 'auto';
        card.style.bottom = 'auto';
    }

    function bindCardWindowInteractions() {
        if (!card || card.dataset.boundWindow === 'true') return;
        card.dataset.boundWindow = 'true';
        let dragState = null;

        card.addEventListener('pointerdown', (event) => {
            const handle = event.target?.closest?.('.wqp-topic-ai-head');
            if (!handle || event.target.closest('button, input, textarea, select, a, summary')) return;
            if (event.isPrimary === false) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;

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
            card.style.bottom = 'auto';
        });

        const stopDragging = (event) => {
            if (!dragState || (event?.pointerId != null && event.pointerId !== dragState.pointerId)) return;
            const pointerId = dragState.pointerId;
            dragState = null;
            card.releasePointerCapture?.(pointerId);
            card.classList.remove('is-dragging');
            constrainCardToViewport();
        };
        card.addEventListener('pointerup', stopDragging);
        card.addEventListener('pointercancel', stopDragging);
        window.addEventListener('resize', constrainCardToViewport);
        if (typeof ResizeObserver === 'function') {
            const resizeObserver = new ResizeObserver(() => constrainCardToViewport());
            resizeObserver.observe(card);
        }
    }

    function ensureCard() {
        if (card) return card;
        if (!document.body) return null;
        card = document.createElement('aside');
        card.id = 'wqp-community-topic-ai';
        card.innerHTML = `
            <header class="wqp-topic-ai-head">
                <div>
                    <strong>AI 论坛批量助手</strong>
                    <p>选择本页帖子，逐个总结并生成评论。</p>
                </div>
                <button type="button" data-action="toggle-collapse" aria-label="收起 AI 论坛批量助手">收起</button>
            </header>
            <div class="wqp-topic-ai-content">
                <div class="wqp-topic-ai-loading">正在读取帖子状态…</div>
            </div>
        `;
        card.addEventListener('click', handleCardClick);
        card.addEventListener('input', handleCardInput);
        card.addEventListener('change', handleCardChange);
        document.body.appendChild(card);
        bindCardWindowInteractions();
        constrainCardToViewport();
        return card;
    }

    function setCollapsed(collapsed) {
        if (!card) return;
        card.classList.toggle('is-collapsed', collapsed);
        const button = card.querySelector('[data-action="toggle-collapse"]');
        if (button) {
            button.textContent = collapsed ? '展开' : '收起';
            button.setAttribute('aria-label', collapsed ? '展开 AI 论坛批量助手' : '收起 AI 论坛批量助手');
        }
        constrainCardToViewport();
    }

    function statusLabel(result) {
        const labels = {
            queued: '等待处理',
            summarizing: '正在总结',
            drafting: '正在生成评论',
            publishing: '正在发布',
            draftReady: '草稿已生成',
            posted: '已发布',
            skipped: '已跳过',
            error: '失败',
        };
        return labels[result.status] || result.status || '等待处理';
    }

    function renderResults() {
        const host = card?.querySelector('[data-role="results"]');
        if (!host) return;
        const items = Array.from(results.values());
        if (!items.length) {
            host.innerHTML = '';
            return;
        }
        host.innerHTML = items.map((result) => {
            const canPost = result.status === 'draftReady' && result.draftText;
            const postedUrl = result.status === 'posted'
                ? safeHttpUrl(result.postedComment?.comment?.url)
                : '';
            return `
                <details class="wqp-topic-ai-result ${result.status === 'error' ? 'is-error' : ''}" ${result.status === 'error' ? 'open' : ''}>
                    <summary>
                        <span title="${escapeHtml(result.post.title)}">${escapeHtml(result.post.title)}</span>
                        <em>${escapeHtml(statusLabel(result))}</em>
                    </summary>
                    <div class="wqp-topic-ai-result-body">
                        ${result.error ? `<p class="wqp-topic-ai-error">${escapeHtml(result.error)}</p>` : ''}
                        ${result.summaryMarkdown ? `
                            <details class="wqp-topic-ai-summary">
                                <summary>查看总结</summary>
                                <div class="wqp-topic-ai-markdown">${markdownToHtml(result.summaryMarkdown)}</div>
                            </details>
                        ` : ''}
                        ${result.draftText ? `
                            <label>
                                <span>评论草稿</span>
                                <textarea rows="6" data-role="draft" data-post-id="${result.post.postId}">${escapeHtml(result.draftText)}</textarea>
                            </label>
                        ` : ''}
                        ${canPost ? `<button type="button" class="wqp-topic-ai-primary" data-action="post-one" data-post-id="${result.post.postId}">发布此评论</button>` : ''}
                        ${postedUrl ? `<a class="wqp-topic-ai-comment-link" href="${escapeHtml(postedUrl)}" target="_blank" rel="noopener noreferrer">查看已发布评论</a>` : ''}
                    </div>
                </details>
            `;
        }).join('');
    }

    function setStatus(text, mode = '') {
        const target = card?.querySelector('[data-role="status"]');
        if (!target) return;
        target.textContent = text || '';
        target.className = `wqp-topic-ai-status${mode ? ` ${mode}` : ''}`;
    }

    function renderReady() {
        const content = ensureCard()?.querySelector('.wqp-topic-ai-content');
        if (!content) return;
        content.innerHTML = `
            <div class="wqp-topic-ai-toolbar">
                <span data-role="selection-count">已选择 0/${posts.length} 个帖子</span>
                <div>
                    <button type="button" data-action="select-all">全选本页</button>
                    <button type="button" data-action="clear-selection">取消全选</button>
                </div>
            </div>
            <label class="wqp-topic-ai-option">
                <input type="checkbox" data-role="skip-posted" ${skipPosted ? 'checked' : ''}>
                <span>跳过已经发布过 AI 评论的帖子</span>
            </label>
            <label class="wqp-topic-ai-field">
                <span>统一评论要求</span>
                <textarea rows="3" data-role="instruction" placeholder="可选：语气、回复角度、长度或其他限制">${escapeHtml(customInstruction)}</textarea>
            </label>
            <div class="wqp-topic-ai-actions">
                <button type="button" class="wqp-topic-ai-primary" data-action="run-drafts">逐个生成草稿</button>
                <button type="button" class="wqp-topic-ai-danger" data-action="run-and-post">逐个生成并发布</button>
                <button type="button" data-action="stop" hidden>处理完当前帖子后停止</button>
            </div>
            <p class="wqp-topic-ai-note">“生成并发布”会在开始前再次确认；单个草稿也可以检查、编辑后再发布。</p>
            <div class="wqp-topic-ai-status" data-role="status"></div>
            <div class="wqp-topic-ai-results" data-role="results"></div>
        `;
        updateSelectionCount();
        renderResults();
        constrainCardToViewport();
    }

    function setRunning(nextRunning) {
        running = nextRunning;
        card?.classList.toggle('is-running', running);
        card?.querySelectorAll('button[data-action="run-drafts"], button[data-action="run-and-post"]')
            .forEach((button) => { button.disabled = running; });
        const stopButton = card?.querySelector('button[data-action="stop"]');
        if (stopButton) stopButton.hidden = !running;
    }

    async function publishResult(result, askForConfirmation = true) {
        const text = String(result?.draftText || '').trim();
        if (!text) throw new Error('没有可发布的评论草稿');
        if (askForConfirmation && !confirm(`确定向帖子“${result.post.title}”发布这条 AI 评论吗？\n\n${text}`)) {
            return false;
        }
        result.status = 'publishing';
        renderResults();
        const data = await sendMessage('WQP_COMMUNITY_AI_POST_COMMENT', {
            postUrl: result.post.postUrl,
            postId: result.post.postId,
            commentText: text,
        });
        result.status = 'posted';
        result.postedComment = {
            postedAt: new Date().toISOString(),
            comment: data.comment || {},
        };
        statusByPost[result.post.postId] = {
            ...(statusByPost[result.post.postId] || {}),
            lastPostedComment: result.postedComment,
        };
        decoratePosts();
        renderResults();
        return true;
    }

    async function runBatch(autoPublish) {
        if (running) return;
        if (aiStatusRefreshPromise) {
            setStatus('正在完成 AI 评论状态同步…', 'loading');
            await aiStatusRefreshPromise;
        }
        const queue = selectedPosts();
        if (!queue.length) {
            setStatus('请先在帖子列表中选择至少一个帖子。', 'error');
            return;
        }
        if (autoPublish && !confirm(`即将按顺序处理并向 ${queue.length} 个帖子发布 AI 评论。\n\n发布属于外部操作，请确认已经检查统一评论要求，并同意继续。`)) {
            return;
        }

        stopRequested = false;
        setRunning(true);
        queue.forEach((post) => {
            results.set(post.postId, { post, status: 'queued', summaryMarkdown: '', draftText: '', error: '' });
        });
        renderResults();

        let completed = 0;
        let failed = 0;
        for (const post of queue) {
            if (stopRequested) break;
            const result = results.get(post.postId);
            try {
                if (skipPosted && isPosted(post.postId)) {
                    result.status = 'skipped';
                    renderResults();
                    continue;
                }
                result.status = 'summarizing';
                setStatus(`(${completed + 1}/${queue.length}) 正在总结：${post.title}`, 'loading');
                renderResults();
                const summary = await sendMessage('WQP_COMMUNITY_AI_SUMMARIZE_POST', {
                    postUrl: post.postUrl,
                    postId: post.postId,
                    forceRefresh: false,
                });
                result.summaryMarkdown = summary?.summaryMarkdown || '';

                result.status = 'drafting';
                setStatus(`(${completed + 1}/${queue.length}) 正在生成评论：${post.title}`, 'loading');
                renderResults();
                const draft = await sendMessage('WQP_COMMUNITY_AI_DRAFT_COMMENT', {
                    postUrl: post.postUrl,
                    postId: post.postId,
                    customInstruction,
                });
                result.draftText = draft?.draft?.commentMarkdown || draft?.draft?.commentText || '';
                result.status = 'draftReady';
                renderResults();

                if (autoPublish) await publishResult(result, false);
                completed += 1;
            } catch (error) {
                result.status = 'error';
                result.error = error.message || String(error);
                failed += 1;
                renderResults();
            }
        }

        setRunning(false);
        const stoppedText = stopRequested ? '，已按要求停止后续任务' : '';
        setStatus(`处理结束：完成 ${completed} 个，失败 ${failed} 个${stoppedText}。`, failed ? 'error' : 'success');
    }

    async function postOne(postId) {
        if (running) return;
        const result = results.get(postId);
        if (!result) return;
        setRunning(true);
        try {
            const posted = await publishResult(result, true);
            setStatus(posted ? `“${result.post.title}”的评论已发布。` : '已取消发布。', posted ? 'success' : '');
        } catch (error) {
            result.status = 'error';
            result.error = error.message || String(error);
            renderResults();
            setStatus(result.error, 'error');
        } finally {
            setRunning(false);
        }
    }

    function setAllSelected(checked) {
        document.querySelectorAll('.wqp-topic-ai-select-input').forEach((input) => {
            const filtered = showUnreadOnly && markerByPost[input.dataset.postId]?.readAt;
            if (filtered) input.checked = false;
            else if (!input.disabled) input.checked = checked;
        });
        updateSelectionCount();
    }

    function handleCardClick(event) {
        const action = event.target?.dataset?.action;
        if (!action) return;
        if (action === 'toggle-collapse') setCollapsed(!card?.classList.contains('is-collapsed'));
        if (action === 'select-all') setAllSelected(true);
        if (action === 'clear-selection') setAllSelected(false);
        if (action === 'run-drafts') runBatch(false);
        if (action === 'run-and-post') runBatch(true);
        if (action === 'stop') {
            stopRequested = true;
            setStatus('将在当前帖子处理完成后停止。', 'loading');
        }
        if (action === 'post-one') postOne(event.target.dataset.postId);
    }

    function handleCardInput(event) {
        if (event.target?.dataset?.role === 'instruction') {
            customInstruction = event.target.value;
        }
        if (event.target?.dataset?.role === 'draft') {
            const result = results.get(event.target.dataset.postId);
            if (result) result.draftText = event.target.value;
        }
    }

    function handleCardChange(event) {
        if (event.target?.dataset?.role !== 'skip-posted') return;
        skipPosted = event.target.checked;
        decoratePosts();
    }

    function handlePageClick(event) {
        const unreadFilterButton = event.target?.closest?.('#wqp-topic-unread-filter-button');
        if (unreadFilterButton) {
            event.preventDefault();
            event.stopPropagation();
            showUnreadOnly = !showUnreadOnly;
            applyUnreadFilter();
            return;
        }
        const favoriteButton = event.target?.closest?.('.wqp-topic-favorite-button');
        if (!favoriteButton) return;
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(favoriteButton.dataset.postId);
    }

    function bindPageMarkerEvents() {
        document.addEventListener('click', handlePageClick);
        document.addEventListener('change', (event) => {
            if (event.target?.classList?.contains('wqp-topic-ai-select-input')) updateSelectionCount();
        });
        window.addEventListener('pageshow', () => refreshPostMarkers());
        window.addEventListener('focus', () => refreshPostMarkers());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refreshPostMarkers();
        });
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local' && changes.WQP_CommunityPostMarkers) refreshPostMarkers();
        });
    }

    async function initialize() {
        try {
            posts = scanPosts();
            if (!posts.length) return;

            const [configResult, markerResult] = await Promise.allSettled([
                sendMessage('WQP_LLM_CONFIG_GET'),
                sendMessage('WQP_COMMUNITY_POST_MARKERS_GET', {
                    postIds: posts.map((post) => post.postId),
                }),
            ]);
            const config = configResult.status === 'fulfilled' ? configResult.value : {};
            markerByPost = markerResult.status === 'fulfilled' ? (markerResult.value?.byPost || {}) : {};
            aiEnabled = config?.enabled === true;

            if (configResult.status === 'rejected') {
                console.warn('[WQP Community] 无法读取 AI 配置：', configResult.reason);
            }
            if (markerResult.status === 'rejected') {
                console.warn('[WQP Community] 无法读取阅读与收藏状态：', markerResult.reason);
            }

            if (aiEnabled) {
                ensureCard();
                setCollapsed(config.defaultCollapsed === true);
            }
            decoratePosts();
            if (aiEnabled) renderReady();
            bindPageMarkerEvents();
            // AI 状态来自可能很大的 Community 缓存，必须在首屏标记渲染后异步补充。
            if (aiEnabled) refreshAiPostStatuses();
        } catch (error) {
            console.warn('[WQP Community] topics 页面助手初始化失败：', error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
