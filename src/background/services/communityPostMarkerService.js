import { getLocalValue, setLocalValue } from './storageService.js';

const STORAGE_KEY = 'WQP_CommunityPostMarkers';
const MAX_STATUS_POSTS = 100;

let updateQueue = Promise.resolve();

function parsePostId(value) {
    if (value && typeof value === 'object' && value.postId != null) {
        return parsePostId(value.postId);
    }
    const raw = String(value || '').trim();
    if (/^\d+$/.test(raw)) return raw;
    try {
        return new URL(raw).pathname.match(/\/community\/posts\/(\d+)/)?.[1] || '';
    } catch (_) {
        return '';
    }
}

function normalizeHttpUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) {
        return '';
    }
}

function normalizeEntry(postId, value = {}) {
    return {
        postId,
        postUrl: normalizeHttpUrl(value.postUrl),
        title: String(value.title || '').trim(),
        postDate: String(value.postDate || ''),
        readAt: String(value.readAt || ''),
        lastReadAt: String(value.lastReadAt || value.readAt || ''),
        favorite: value.favorite === true,
        favoritedAt: value.favorite === true ? String(value.favoritedAt || '') : '',
        updatedAt: String(value.updatedAt || ''),
    };
}

async function getMarkerState() {
    const state = await getLocalValue(STORAGE_KEY);
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function updateMarker(postRef, updater) {
    const postId = parsePostId(postRef);
    if (!postId) return Promise.reject(new Error('无法识别帖子 ID'));

    const run = updateQueue
        .catch(() => {})
        .then(async () => {
            const state = await getMarkerState();
            const current = normalizeEntry(postId, state[postId]);
            const next = normalizeEntry(postId, updater(current));
            state[postId] = next;
            await setLocalValue(STORAGE_KEY, state);
            return next;
        });
    updateQueue = run;
    return run;
}

export async function getCommunityPostMarkers(payload = {}) {
    const refs = Array.isArray(payload.postIds) ? payload.postIds : [];
    const postIds = Array.from(new Set(refs.map(parsePostId).filter(Boolean))).slice(0, MAX_STATUS_POSTS);
    const state = await getMarkerState();
    const byPost = {};
    postIds.forEach((postId) => {
        byPost[postId] = normalizeEntry(postId, state[postId]);
    });
    return { byPost };
}

export async function listCommunityFavoritePosts() {
    const state = await getMarkerState();
    const items = Object.entries(state)
        .map(([rawPostId, value]) => {
            const postId = parsePostId(rawPostId);
            return postId ? normalizeEntry(postId, value) : null;
        })
        .filter((entry) => entry?.favorite)
        .map((entry) => ({
            ...entry,
            postUrl: entry.postUrl || `https://support.worldquantbrain.com/hc/en-us/community/posts/${entry.postId}`,
            title: entry.title || `帖子 ${entry.postId}`,
        }))
        .sort((a, b) => String(b.favoritedAt || b.postDate).localeCompare(String(a.favoritedAt || a.postDate)));
    return {
        count: items.length,
        items,
    };
}

export function markCommunityPostRead(payload = {}) {
    const postRef = payload.postId || payload.postUrl;
    const now = new Date().toISOString();
    return updateMarker(postRef, (current) => ({
        ...current,
        postUrl: normalizeHttpUrl(payload.postUrl) || current.postUrl,
        title: String(payload.title || '').trim() || current.title,
        postDate: String(payload.postDate || '').trim() || current.postDate,
        readAt: current.readAt || now,
        lastReadAt: now,
        updatedAt: now,
    }));
}

export function setCommunityPostFavorite(payload = {}) {
    const postRef = payload.postId || payload.postUrl;
    const now = new Date().toISOString();
    return updateMarker(postRef, (current) => {
        const favorite = typeof payload.favorite === 'boolean' ? payload.favorite : !current.favorite;
        return {
            ...current,
            postUrl: normalizeHttpUrl(payload.postUrl) || current.postUrl,
            title: String(payload.title || '').trim() || current.title,
            postDate: String(payload.postDate || '').trim() || current.postDate,
            favorite,
            favoritedAt: favorite ? (current.favoritedAt || now) : '',
            updatedAt: now,
        };
    });
}
