// Description: 弹出窗口的 JS 文件
console.log('popup.js loaded');

// 获取 HTML 元素
const dataAnalysisCheckbox = document.getElementById('dataAnalysis');
const geniusCombineTagCheckbox = document.getElementById('geniusCombineTag');
const geniusAlphaCountInput = document.getElementById('geniusAlphaCount');
const apiMonitorEnabledCheckbox = document.getElementById('apiMonitorEnabled');
const saveBtn = document.getElementById('saveBtn');
const statusText = document.getElementById('status');
const settingsForm = document.getElementById('settingsForm');
const exportCommunityBtn = document.getElementById('exportCommunityBtn');
const exportCommunityCompressedBtn = document.getElementById('exportCommunityCompressedBtn');
const importCommunityBtn = document.getElementById('importCommunityBtn');
const importCommunityFile = document.getElementById('importCommunityFile');
const importDataZipBtn = document.getElementById('importDataZipBtn');
const importDataZipFile = document.getElementById('importDataZipFile');

// 加载用户设置
function loadSettings() {
    statusText.textContent = '加载中...';
    chrome.storage.local.get('WQP_Settings', ({ WQP_Settings }) => {
        const settings = WQP_Settings || {};
        dataAnalysisCheckbox.checked = settings.dataAnalysisEnabled || false;
        geniusCombineTagCheckbox.checked = settings.geniusCombineTag || false;
        geniusAlphaCountInput.value = settings.geniusAlphaCount || 40;
        apiMonitorEnabledCheckbox.checked = settings.apiMonitorEnabled || false;

        statusText.textContent = '';
    });
}

// 保存用户设置
function saveSettings(event) {
    event.preventDefault();
    saveBtn.disabled = true;
    const WQP_Settings = {
        dataAnalysisEnabled: dataAnalysisCheckbox.checked,
        geniusCombineTag: geniusCombineTagCheckbox.checked,
        geniusAlphaCount: parseInt(geniusAlphaCountInput.value) || 40,
        apiMonitorEnabled: apiMonitorEnabledCheckbox.checked
    };

    chrome.storage.local.set({ WQP_Settings }, () => {
        if (chrome.runtime.lastError) {
            showStatusMessage('保存失败，请重试！', false);
            saveBtn.disabled = false;
        } else {
            showStatusMessage('设置已保存！', true);
            setTimeout(() => {
                statusText.textContent = '';
                saveBtn.disabled = false;
            }, 2000);
        }
    });
}

// 显示状态信息
function showStatusMessage(message, isSuccess = true) {
    statusText.textContent = message;
    statusText.className = isSuccess ? 'success' : 'error';
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function notifyIndexedDataUpdated() {
    chrome.runtime.sendMessage({ type: 'WQP_INDEXED_DATA_UPDATED' }, () => {
        void chrome.runtime.lastError;
    });
}

function handleImportDataZipClick() {
    if (!importDataZipFile) return;
    if (importDataZipFile) importDataZipFile.value = '';
    importDataZipFile.click();
}

async function handleImportDataZipFileChange(evt) {
    const file = evt.target.files && evt.target.files[0];
    if (!file) return;

    if (!/\.zip$/i.test(file.name)) {
        showStatusMessage('请选择 zip 文件。', false);
        return;
    }

    if (!globalThis.WQPDataStore) {
        showStatusMessage('数据存储模块未加载。', false);
        return;
    }

    if (importDataZipBtn) importDataZipBtn.disabled = true;
    showStatusMessage('正在读取 zip...', true);

    try {
        const meta = await globalThis.WQPDataStore.importZip(file, {
            onProgress: ({ current, total, path }) => {
                statusText.className = 'success';
                statusText.textContent = path.startsWith('preprocess ')
                    ? '正在预处理 info_data.bin...'
                    : `正在导入 ${current}/${total}: ${path}`;
            },
        });
        notifyIndexedDataUpdated();

        const missing = meta.missingRequired?.length
            ? `，缺少 ${meta.missingRequired.join(', ')}`
            : '';
        showStatusMessage(
            `导入完成：${meta.fileCount} 个文件，${formatBytes(meta.totalBytes)}，${meta.infoDataKeyCount || 0} 个 info 分片${missing}`,
            !missing
        );
    } catch (e) {
        console.error(e);
        showStatusMessage(`导入失败：${e.message || e}`, false);
    } finally {
        if (importDataZipBtn) importDataZipBtn.disabled = false;
        if (importDataZipFile) importDataZipFile.value = '';
    }
}

// 事件监听：表单提交
settingsForm.addEventListener('submit', saveSettings);

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', loadSettings);

// ========== 社区数据 导出/导入 ==========
function downloadBytes(filename, bytes, mime = 'application/octet-stream') {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function formatNow() {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const COMPRESSED_JSON_FORMAT_HEADER = 'WQCS_JSON_V1\n';
const JSON_CHUNK_MAX_CHARS = 256 * 1024;
const JSON_INDENT = '  ';

function createJsonChunkWriter(onChunk) {
    let buffer = '';
    const flush = () => { if (!buffer) return; onChunk(buffer); buffer = ''; };
    const push = (text) => {
        if (!text) return;
        let offset = 0;
        while (offset < text.length) {
            const available = JSON_CHUNK_MAX_CHARS - buffer.length;
            buffer += text.slice(offset, offset + available);
            offset += available;
            if (buffer.length >= JSON_CHUNK_MAX_CHARS) flush();
        }
    };
    return { push, flush };
}

function pushJsonValue(push, value, depth = 0) {
    if (value === null || typeof value !== 'object') { push(JSON.stringify(value) ?? 'null'); return; }
    if (Array.isArray(value)) {
        if (!value.length) { push('[]'); return; }
        push('[\n');
        value.forEach((item, index) => {
            push(JSON_INDENT.repeat(depth + 1));
            pushJsonValue(push, item === undefined ? null : item, depth + 1);
            push(index === value.length - 1 ? '\n' : ',\n');
        });
        push(`${JSON_INDENT.repeat(depth)}]`);
        return;
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) { push('{}'); return; }
    push('{\n');
    keys.forEach((key, index) => {
        push(JSON_INDENT.repeat(depth + 1));
        push(`${JSON.stringify(key)}: `);
        pushJsonValue(push, value[key], depth + 1);
        push(index === keys.length - 1 ? '\n' : ',\n');
    });
    push(`${JSON_INDENT.repeat(depth)}}`);
}

function createCommunityStateJsonBlob(state) {
    const parts = [];
    const writer = createJsonChunkWriter((chunk) => parts.push(chunk));
    pushJsonValue(writer.push, state);
    writer.push('\n');
    writer.flush();
    return new Blob(parts, { type: 'application/json;charset=utf-8' });
}

function createCompressedCommunityStateBlob(state) {
    const chunks = [];
    const encoder = new TextEncoder();
    const deflator = new pako.Deflate();
    const writer = createJsonChunkWriter((chunk) => {
        deflator.push(encoder.encode(chunk), false);
        if (deflator.err) throw new Error(deflator.msg || '压缩社区数据失败。');
    });
    deflator.onData = (chunk) => chunks.push(chunk);
    writer.push(COMPRESSED_JSON_FORMAT_HEADER);
    pushJsonValue(writer.push, state);
    writer.push('\n');
    writer.flush();
    deflator.push(new Uint8Array(0), true);
    if (deflator.err) throw new Error(deflator.msg || '压缩社区数据失败。');
    return new Blob(chunks, { type: 'application/octet-stream' });
}

function decodeCompressedCommunityState(data) {
    const inflated = pako.inflate(new Uint8Array(data));
    const prefix = new TextEncoder().encode(COMPRESSED_JSON_FORMAT_HEADER);
    if (inflated.length >= prefix.length && prefix.every((b, i) => inflated[i] === b)) {
        return JSON.parse(new TextDecoder().decode(inflated.subarray(prefix.length)));
    }
    return msgpack.decode(inflated);
}

function handleExportCommunity() {
    statusText.textContent = '导出中...';
    chrome.storage.local.get('WQP_CommunityState', ({ WQP_CommunityState }) => {
        try {
            if (!WQP_CommunityState) {
                showStatusMessage('没有可导出的社区数据。', false);
                return;
            }
            downloadBytes(`WQP_CommunityState_${formatNow()}.json`, createCommunityStateJsonBlob(WQP_CommunityState));
            showStatusMessage('导出完成。', true);
        } catch (e) {
            console.error(e);
            showStatusMessage('导出失败。', false);
        }
    });
}

function handleExportCommunityCompressed() {
    statusText.textContent = '导出(压缩)中...';
    chrome.storage.local.get('WQP_CommunityState', ({ WQP_CommunityState }) => {
        try {
            if (!WQP_CommunityState) {
                showStatusMessage('没有可导出的社区数据。', false);
                return;
            }
            downloadBytes(`WQP_CommunityState_${formatNow()}.wqcs`, createCompressedCommunityStateBlob(WQP_CommunityState));
            showStatusMessage('压缩导出完成。', true);
        } catch (e) {
            console.error(e);
            showStatusMessage('压缩导出失败。', false);
        }
    });
}

function handleImportClick() {
    if (importCommunityFile) importCommunityFile.value = '';
    importCommunityFile.click();
}

function handleImportFileChange(evt) {
    const file = evt.target.files && evt.target.files[0];
    if (!file) return;
    statusText.textContent = '导入中...';
    const isCompressed = /\.wqcs$/i.test(file.name);
    const reader = new FileReader();
    if (isCompressed) {
        reader.onload = () => {
            try {
                const obj = decodeCompressedCommunityState(reader.result);
                chrome.storage.local.set({ WQP_CommunityState: obj }, () => {
                    if (chrome.runtime.lastError) {
                        showStatusMessage('写入存储失败。', false);
                    } else {
                        showStatusMessage('导入成功。', true);
                    }
                });
            } catch (e) {
                console.error(e);
                showStatusMessage('导入失败：压缩内容无法解析。', false);
            }
        };
        reader.onerror = () => showStatusMessage('读取文件失败。', false);
        reader.readAsArrayBuffer(file);
    } else {
        reader.onload = () => {
            try {
                const obj = JSON.parse(reader.result);
                chrome.storage.local.set({ WQP_CommunityState: obj }, () => {
                    if (chrome.runtime.lastError) {
                        showStatusMessage('写入存储失败。', false);
                    } else {
                        showStatusMessage('导入成功。', true);
                    }
                });
            } catch (e) {
                console.error(e);
                showStatusMessage('导入失败：不是合法的 JSON。', false);
            }
        };
        reader.onerror = () => showStatusMessage('读取文件失败。', false);
        reader.readAsText(file, 'utf-8');
    }
}

exportCommunityBtn?.addEventListener('click', handleExportCommunity);
exportCommunityCompressedBtn?.addEventListener('click', handleExportCommunityCompressed);
importCommunityBtn?.addEventListener('click', handleImportClick);
importCommunityFile?.addEventListener('change', handleImportFileChange);
importDataZipBtn?.addEventListener('click', handleImportDataZipClick);
importDataZipFile?.addEventListener('change', handleImportDataZipFileChange);
