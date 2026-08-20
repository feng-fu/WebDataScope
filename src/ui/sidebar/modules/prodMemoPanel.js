import { sendMessage } from './runtimeClient.js';
import { downloadText, formatNow, setStatus } from './ui.js';

const ids = {
    summary: 'prodMemoSummary',
    status: 'prodMemoStatus',
    list: 'prodMemoList',
    search: 'prodMemoSearch',
    sync: 'syncProdMemoBtn',
    refresh: 'refreshProdMemoBtn',
    export: 'exportProdMemoBtn',
    import: 'importProdMemoBtn',
    importFile: 'importProdMemoFile',
    clear: 'clearProdMemoBtn',
    clearSync: 'clearProdMemoSyncBtn',
};

let latestMemoData = {};
let latestStats = {};
let currentSearch = '';
let syncRunning = false;
const ROW_BATCH_SIZE = 100;
let renderLimit = ROW_BATCH_SIZE;
let refreshTimer = null;

function getEl(id) {
    return document.getElementById(id);
}

function formatTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function formatStat(value, prefix = '') {
    const numeric = Number(value);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(numeric)
        ? `${prefix}${numeric.toFixed(4)}`
        : '-';
}

function setPanelStatus(message, mode = '') {
    const element = getEl(ids.status);
    if (!element) return;
    element.textContent = message || '';
    element.className = `info-box${mode ? ` ${mode}` : ''}`;
}

function setSyncRunning(running) {
    syncRunning = running;
    const button = getEl(ids.sync);
    if (!button) return;
    button.textContent = running ? '停止同步' : '增量同步 Alpha + PnL';
    button.classList.toggle('danger', running);
}

function renderSummary(stats = latestStats) {
    latestStats = stats || {};
    const summary = getEl(ids.summary);
    if (!summary) return;
    const sync = latestStats.sync || {};
    summary.innerHTML = `
        <div><strong>Submitted Alpha：</strong>${latestStats.submittedAlphaCount || 0}</div>
        <div><strong>Submitted PnL：</strong>${latestStats.submittedPnlCount ?? latestStats.pnlCount ?? 0}</div>
        <div><strong>Platform Corr：</strong>${latestStats.platformCorrCount || 0}</div>
        <div><strong>Local Corr：</strong>${latestStats.localCorrCount || 0}</div>
        <div><strong>有效 Prod 参考：</strong>${latestStats.validReferenceCount || 0}</div>
        <div><strong>同步状态：</strong>${sync.status || '未同步'} · ${formatTime(sync.incrementalSyncedAt || sync.fullSyncedAt)}</div>
        ${sync.failedIds?.length ? `<div class="error"><strong>PnL 失败：</strong>${sync.failedIds.length}</div>` : ''}
        ${sync.backfillFailedIds?.length ? `<div class="error"><strong>历史回填失败：</strong>${sync.backfillFailedIds.length}</div>` : ''}
    `;
    setSyncRunning(sync.status === 'running');
}

function metricChip(label, stat, source, options = {}) {
    const element = document.createElement('span');
    const available = stat?.max !== null && stat?.max !== undefined && Number.isFinite(Number(stat.max));
    const stale = stat?.stale === true;
    element.className = available && !stale ? 'is-present' : 'is-missing';
    const icon = source === 'platform' ? 'Ⓟ' : 'Ⓛ';
    const prefix = options.lowerBound ? '≥' : '';
    element.textContent = available
        ? `${icon} ${label}: ${formatStat(stat.max, prefix)}${stale ? '（过期）' : ''}`
        : `${icon} ${label}: ${stat?.result?.reason || '缺失'}`;
    element.title = source === 'platform'
        ? `平台返回 · ${formatTime(stat?.updated)}`
        : `本地计算 · ${formatTime(stat?.calculatedAt)}`;
    return element;
}

function bestTimestamp(entry) {
    return Math.max(
        Number(entry?.platform?.prod?.updated || 0),
        Number(entry?.platform?.pool?.updated || 0),
        Number(entry?.platform?.self?.updated || 0),
        Number(entry?.local?.self?.calculatedAt || 0),
        Number(entry?.local?.pool?.calculatedAt || 0),
        Number(entry?.local?.prodLowerBound?.calculatedAt || 0),
    );
}

function createCacheRow(alphaId, entry) {
    const row = document.createElement('div');
    row.className = 'cache-row';
    row.dataset.alphaId = alphaId;

    const head = document.createElement('div');
    head.className = 'cache-row-head';
    const id = document.createElement('div');
    id.className = 'cache-alpha-id';
    id.title = `${alphaId}${entry.alpha?.groupKey ? ` · ${entry.alpha.groupKey}` : ''}`;
    id.textContent = alphaId;
    const actions = document.createElement('div');
    actions.className = 'cache-row-actions';
    const time = document.createElement('div');
    time.className = 'cache-time';
    time.textContent = formatTime(bestTimestamp(entry));
    const deleteButton = document.createElement('button');
    deleteButton.className = 'cache-delete-btn';
    deleteButton.type = 'button';
    deleteButton.dataset.action = 'delete-prod-memo';
    deleteButton.dataset.alphaId = alphaId;
    deleteButton.textContent = '删除 Corr';
    actions.append(time, deleteButton);
    head.append(id, actions);

    const platformTitle = document.createElement('div');
    platformTitle.className = 'cache-source-title is-platform';
    platformTitle.textContent = 'Ⓟ Platform';
    const platform = document.createElement('div');
    platform.className = 'cache-stats';
    [
        metricChip('Self', entry.platform?.self, 'platform'),
        metricChip('Pool', entry.platform?.pool, 'platform'),
        metricChip('Prod', entry.platform?.prod, 'platform'),
    ].forEach((chip) => platform.appendChild(chip));

    const localTitle = document.createElement('div');
    localTitle.className = 'cache-source-title is-local';
    localTitle.textContent = 'Ⓛ Local';
    const local = document.createElement('div');
    local.className = 'cache-stats';
    [
        metricChip('Self', entry.local?.self?.result, 'local', { record: entry.local?.self }),
        metricChip('Pool', entry.local?.pool?.result, 'local', { record: entry.local?.pool }),
        metricChip('Prod 下限', entry.local?.prodLowerBound?.result, 'local', {
            record: entry.local?.prodLowerBound,
            lowerBound: true,
        }),
    ].forEach((chip, index) => {
        const record = [entry.local?.self, entry.local?.pool, entry.local?.prodLowerBound][index];
        chip.classList.toggle('is-missing', !record?.result?.available || record?.stale);
        chip.title = record?.result?.available
            ? `本地计算 · ${formatTime(record.calculatedAt)}${record.stale ? ' · 输入数据已变化' : ''}`
            : (record?.result?.reason || '尚未计算');
        local.appendChild(chip);
    });

    row.append(head, platformTitle, platform, localTitle, local);
    return row;
}

function sortedEntries() {
    return Object.entries(latestMemoData || {})
        .filter(([alphaId]) => !currentSearch || alphaId.toLowerCase().includes(currentSearch.toLowerCase()))
        .sort((left, right) => bestTimestamp(right[1]) - bestTimestamp(left[1]));
}

function renderList() {
    const list = getEl(ids.list);
    if (!list) return;
    list.innerHTML = '';
    const entries = sortedEntries();
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = Object.keys(latestMemoData).length ? '没有匹配的 ProdMemo 记录。' : '暂无 ProdMemo Corr 记录。';
        list.appendChild(empty);
        return;
    }
    const fragment = document.createDocumentFragment();
    const visibleEntries = entries.slice(0, renderLimit);
    visibleEntries.forEach(([alphaId, entry]) => fragment.appendChild(createCacheRow(alphaId, entry)));
    if (visibleEntries.length < entries.length) {
        const loadMoreButton = document.createElement('button');
        loadMoreButton.type = 'button';
        loadMoreButton.className = 'prod-memo-load-more';
        loadMoreButton.dataset.action = 'load-more-prod-memo';
        loadMoreButton.textContent = `显示更多（${visibleEntries.length}/${entries.length}）`;
        fragment.appendChild(loadMoreButton);
    }
    list.appendChild(fragment);
}

async function refreshProdMemoPanel() {
    const data = await sendMessage('WQP_PRODMEMO_GET');
    latestMemoData = data.memoData || {};
    renderLimit = ROW_BATCH_SIZE;
    renderSummary(data.stats || {});
    renderList();
    return data;
}

function scheduleProdMemoRefresh(delay = 250) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshProdMemoPanel().catch(() => {});
    }, delay);
}

async function runWithButton(buttonId, fn) {
    const button = getEl(buttonId);
    if (button) button.disabled = true;
    try {
        return await fn();
    } finally {
        if (button) button.disabled = false;
    }
}

function queryActiveTab() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(tabs[0] || null);
        });
    });
}

function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(response);
        });
    });
}

async function toggleSync() {
    const tab = await queryActiveTab();
    if (!tab?.id || !String(tab.url || '').includes('platform.worldquantbrain.com')) {
        throw new Error('请先打开并登录 WorldQuant BRAIN 页面。');
    }
    if (syncRunning) {
        await sendTabMessage(tab.id, { type: 'WQP_PRODMEMO_SYNC_STOP' });
        setPanelStatus('正在停止同步…');
        return;
    }
    const response = await sendTabMessage(tab.id, { type: 'WQP_PRODMEMO_SYNC_START', mode: 'incremental' });
    if (!response?.started) throw new Error('WQB 页面没有启动同步，请刷新页面后重试。');
    setSyncRunning(true);
    setPanelStatus('已启动计数探测式增量同步。');
}

async function exportProdMemo() {
    const data = await sendMessage('WQP_PRODMEMO_EXPORT');
    const platformCount = Object.keys(data.platformCorrs || {}).length;
    const localCount = (data.localCorrs || []).length;
    if (!platformCount && !localCount) throw new Error('无 Corr 数据可导出。');
    downloadText(`WQP_ProdMemo_corr_export_${formatNow()}.json`, JSON.stringify(data, null, 2));
    setPanelStatus(`已导出 ${platformCount} 条 Platform 和 ${localCount} 条 Local Corr 记录。`, 'success');
}

async function importProdMemoFile(file) {
    const memoData = JSON.parse(await file.text());
    const result = await sendMessage('WQP_PRODMEMO_IMPORT', { memoData });
    await refreshProdMemoPanel();
    setPanelStatus(`已导入 ${result.imported || 0} 条，跳过 ${result.skipped || 0} 条。`, 'success');
}

async function clearCorrs() {
    if (!confirm('确定清空所有 Platform 与 Local Corr 结果吗？Alpha/PnL 同步数据会保留。')) return;
    const result = await sendMessage('WQP_PRODMEMO_CLEAR');
    await refreshProdMemoPanel();
    setPanelStatus(`已清空 ${result.cleared || 0} 条 Corr 记录。`, 'success');
}

async function clearSyncData() {
    if (!confirm('确定清空 Submitted Alpha、PnL 和同步状态吗？Corr 结果会保留；本地 Corr 将标记为过期，重新同步并计算后恢复。')) return;
    const result = await sendMessage('WQP_PRODMEMO_CLEAR_SYNC');
    await refreshProdMemoPanel();
    setPanelStatus(`已清空 ${result.cleared || 0} 条 Alpha/PnL 同步记录；Corr 结果已保留。`, 'success');
}

async function deleteCorr(alphaId) {
    if (!confirm(`确定删除 ${alphaId} 的 Platform 与 Local Corr 吗？`)) return;
    const result = await sendMessage('WQP_PRODMEMO_DELETE', { alphaId });
    delete latestMemoData[alphaId];
    renderList();
    setPanelStatus(result.deleted ? `已删除 ${alphaId} 的 Corr。` : `${alphaId} 没有可删除的 Corr。`, 'success');
}

export async function initProdMemoPanel() {
    try {
        await refreshProdMemoPanel();
        setPanelStatus('ProdMemo 数据已加载。');
    } catch (error) {
        setPanelStatus(`ProdMemo 加载失败：${error.message}`, 'error');
        setStatus(`ProdMemo 加载失败：${error.message}`, 'error');
    }

    getEl(ids.sync).addEventListener('click', () => {
        toggleSync().catch((error) => setPanelStatus(`同步操作失败：${error.message}`, 'error'));
    });
    getEl(ids.refresh).addEventListener('click', () => {
        runWithButton(ids.refresh, refreshProdMemoPanel)
            .then(() => setPanelStatus('ProdMemo 状态已刷新。', 'success'))
            .catch((error) => setPanelStatus(`刷新失败：${error.message}`, 'error'));
    });
    getEl(ids.export).addEventListener('click', () => {
        runWithButton(ids.export, exportProdMemo).catch((error) => setPanelStatus(`导出失败：${error.message}`, 'error'));
    });
    getEl(ids.import).addEventListener('click', () => {
        const input = getEl(ids.importFile);
        input.value = '';
        input.click();
    });
    getEl(ids.importFile).addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        runWithButton(ids.import, () => importProdMemoFile(file))
            .catch((error) => setPanelStatus(`导入失败：${error.message}`, 'error'))
            .finally(() => { event.target.value = ''; });
    });
    getEl(ids.clear).addEventListener('click', () => {
        runWithButton(ids.clear, clearCorrs).catch((error) => setPanelStatus(`清空失败：${error.message}`, 'error'));
    });
    getEl(ids.clearSync).addEventListener('click', () => {
        runWithButton(ids.clearSync, clearSyncData).catch((error) => setPanelStatus(`清空失败：${error.message}`, 'error'));
    });
    getEl(ids.search).addEventListener('input', (event) => {
        currentSearch = event.target.value || '';
        renderLimit = ROW_BATCH_SIZE;
        renderList();
    });
    getEl(ids.list).addEventListener('click', (event) => {
        const loadMoreButton = event.target.closest('[data-action="load-more-prod-memo"]');
        if (loadMoreButton) {
            renderLimit += ROW_BATCH_SIZE;
            renderList();
            return;
        }
        const button = event.target.closest('[data-action="delete-prod-memo"]');
        if (!button) return;
        button.disabled = true;
        deleteCorr(button.dataset.alphaId)
            .catch((error) => setPanelStatus(`删除失败：${error.message}`, 'error'))
            .finally(() => { if (button.isConnected) button.disabled = false; });
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.type !== 'WQP_PRODMEMO_SYNC_PROGRESS') return false;
        const progress = message.payload || {};
        setPanelStatus([
            progress.message || progress.phase || '同步中',
            progress.total ? `${progress.current || 0}/${progress.total} · 成功 ${progress.success || 0} · 失败 ${progress.failed || 0}` : '',
        ].filter(Boolean).join('\n'), progress.phase === 'error' ? 'error' : '');
        setSyncRunning(!['completed', 'error', 'stopped'].includes(progress.phase));
        if (['completed', 'error', 'stopped'].includes(progress.phase)) scheduleProdMemoRefresh(0);
        return false;
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local' || !changes.WQP_ProdMemo_DB_Revision) return;
        scheduleProdMemoRefresh();
    });
}
