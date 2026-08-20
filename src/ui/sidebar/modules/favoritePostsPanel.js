import { sendMessage } from './runtimeClient.js';
import { setStatus } from './ui.js';

const ids = {
    refresh: 'refreshFavoritePostsBtn',
    summary: 'favoritePostsSummary',
    list: 'favoritePostsList',
    pageSize: 'favoritePostsPageSize',
    pagination: 'favoritePostsPagination',
    pageStatus: 'favoritePostsPageStatus',
    previous: 'favoritePostsPrevBtn',
    next: 'favoritePostsNextBtn',
};

const PAGE_SIZE_STORAGE_KEY = 'WQP_FavoritePostsPageSize';
const DEFAULT_PAGE_SIZE = 5;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 50;

let favoriteItems = [];
let refreshPromise = null;
let currentPage = 1;
let pageSize = DEFAULT_PAGE_SIZE;

function getEl(id) {
    return document.getElementById(id);
}

function normalizePageSize(value) {
    const number = Math.trunc(Number(value));
    if (!Number.isFinite(number)) return DEFAULT_PAGE_SIZE;
    return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, number));
}

function getStoredPageSize() {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(PAGE_SIZE_STORAGE_KEY, (items) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(normalizePageSize(items?.[PAGE_SIZE_STORAGE_KEY]));
        });
    });
}

function savePageSize(value) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [PAGE_SIZE_STORAGE_KEY]: value }, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve();
        });
    });
}

function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN');
}

function appendFavoriteDate(card, item) {
    const parts = [];
    const postDate = formatDateTime(item.postDate);
    const favoritedAt = formatDateTime(item.favoritedAt);
    if (postDate) parts.push(`帖子日期：${postDate}`);
    if (favoritedAt) parts.push(`收藏日期：${favoritedAt}`);
    if (!parts.length) return;

    const date = document.createElement('p');
    date.className = 'favorite-post-date';
    date.textContent = parts.join(' · ');
    card.appendChild(date);
}

function renderFavorites() {
    const summary = getEl(ids.summary);
    const list = getEl(ids.list);
    const pagination = getEl(ids.pagination);
    const pageStatus = getEl(ids.pageStatus);
    const previous = getEl(ids.previous);
    const next = getEl(ids.next);
    if (!summary || !list) return;

    const pageCount = Math.max(1, Math.ceil(favoriteItems.length / pageSize));
    currentPage = Math.min(Math.max(1, currentPage), pageCount);
    summary.className = 'info-box';
    summary.textContent = favoriteItems.length
        ? `共收藏 ${favoriteItems.length} 个论坛帖子；第 ${currentPage}/${pageCount} 页，每页 ${pageSize} 条。`
        : '共收藏 0 个论坛帖子。';
    list.innerHTML = '';
    if (!favoriteItems.length) {
        if (pagination) pagination.hidden = true;
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '暂无收藏。请在论坛 topics 页面点击“☆ 收藏”。';
        list.appendChild(empty);
        return;
    }

    if (pagination) pagination.hidden = false;
    if (pageStatus) pageStatus.textContent = `第 ${currentPage} / ${pageCount} 页`;
    if (previous) previous.disabled = currentPage <= 1;
    if (next) next.disabled = currentPage >= pageCount;

    const fragment = document.createDocumentFragment();
    const pageStart = (currentPage - 1) * pageSize;
    favoriteItems.slice(pageStart, pageStart + pageSize).forEach((item) => {
        const card = document.createElement('article');
        card.className = 'favorite-post-card';
        card.dataset.postId = String(item.postId || '');

        const head = document.createElement('div');
        head.className = 'favorite-post-head';

        const title = document.createElement('a');
        title.className = 'favorite-post-title';
        title.href = String(item.postUrl || '');
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
        title.textContent = String(item.title || `帖子 ${item.postId || ''}`);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'favorite-post-remove';
        remove.dataset.action = 'remove-favorite';
        remove.dataset.postId = String(item.postId || '');
        remove.textContent = '取消收藏';
        remove.title = `取消收藏：${title.textContent}`;
        head.append(title, remove);

        const url = document.createElement('a');
        url.className = 'favorite-post-url';
        url.href = title.href;
        url.target = '_blank';
        url.rel = 'noopener noreferrer';
        url.textContent = title.href;
        url.title = title.href;

        card.append(head, url);
        appendFavoriteDate(card, item);
        fragment.appendChild(card);
    });
    list.appendChild(fragment);
    list.scrollTop = 0;
}

async function refreshFavorites() {
    if (refreshPromise) return refreshPromise;
    const refreshButton = getEl(ids.refresh);
    if (refreshButton) refreshButton.disabled = true;
    refreshPromise = sendMessage('WQP_COMMUNITY_POST_FAVORITES_GET')
        .then((data) => {
            favoriteItems = Array.isArray(data?.items) ? data.items : [];
            renderFavorites();
        })
        .catch((error) => {
            const summary = getEl(ids.summary);
            if (summary) {
                summary.className = 'info-box error';
                summary.textContent = `收藏加载失败：${error.message}`;
            }
            throw error;
        })
        .finally(() => {
            refreshPromise = null;
            if (refreshButton) refreshButton.disabled = false;
        });
    return refreshPromise;
}

async function removeFavorite(postId, button) {
    const item = favoriteItems.find((entry) => String(entry.postId) === postId);
    if (!item) return;
    if (!confirm(`确定取消收藏“${item.title}”吗？`)) return;
    if (button) button.disabled = true;
    try {
        await sendMessage('WQP_COMMUNITY_POST_FAVORITE_SET', {
            postId,
            favorite: false,
        });
        favoriteItems = favoriteItems.filter((entry) => String(entry.postId) !== postId);
        renderFavorites();
        setStatus('已取消论坛帖子收藏。', 'success');
    } catch (error) {
        setStatus(`取消收藏失败：${error.message}`, 'error');
        if (button) button.disabled = false;
    }
}

export async function initFavoritePostsPanel() {
    const refreshButton = getEl(ids.refresh);
    const list = getEl(ids.list);
    const pageSizeInput = getEl(ids.pageSize);
    const previous = getEl(ids.previous);
    const next = getEl(ids.next);

    try {
        pageSize = await getStoredPageSize();
    } catch (error) {
        console.warn('[WQP] 无法读取论坛收藏每页数量：', error);
    }
    if (pageSizeInput) pageSizeInput.value = String(pageSize);

    refreshButton?.addEventListener('click', () => {
        refreshFavorites().catch(() => {});
    });
    pageSizeInput?.addEventListener('change', () => {
        pageSize = normalizePageSize(pageSizeInput.value);
        pageSizeInput.value = String(pageSize);
        currentPage = 1;
        renderFavorites();
        savePageSize(pageSize).catch((error) => {
            setStatus(`保存收藏每页数量失败：${error.message}`, 'error');
        });
    });
    previous?.addEventListener('click', () => {
        if (currentPage <= 1) return;
        currentPage -= 1;
        renderFavorites();
    });
    next?.addEventListener('click', () => {
        const pageCount = Math.max(1, Math.ceil(favoriteItems.length / pageSize));
        if (currentPage >= pageCount) return;
        currentPage += 1;
        renderFavorites();
    });
    list?.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-action="remove-favorite"]');
        if (button) removeFavorite(button.dataset.postId, button);
    });
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.WQP_CommunityPostMarkers) {
            refreshFavorites().catch(() => {});
        }
        if (namespace === 'local' && changes[PAGE_SIZE_STORAGE_KEY]) {
            pageSize = normalizePageSize(changes[PAGE_SIZE_STORAGE_KEY].newValue);
            currentPage = 1;
            if (pageSizeInput) pageSizeInput.value = String(pageSize);
            renderFavorites();
        }
    });
    await refreshFavorites();
}
