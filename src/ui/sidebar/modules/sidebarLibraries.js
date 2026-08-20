const SCRIPT_PATHS = [
    '../../vendor/js/pako.min.js',
    '../../vendor/js/msgpack.min.js',
    '../../vendor/js/jszip.min.js',
    '../../shared/dataStore.js',
];

let loadPromise = null;

function loadScript(path) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-wqp-library="${path}"]`);
        if (existing?.dataset.loaded === 'true') {
            resolve();
            return;
        }

        const script = existing || document.createElement('script');
        script.dataset.wqpLibrary = path;
        script.addEventListener('load', () => {
            script.dataset.loaded = 'true';
            resolve();
        }, { once: true });
        script.addEventListener('error', () => {
            script.remove();
            reject(new Error(`加载侧边栏依赖失败：${path}`));
        }, { once: true });
        if (!existing) {
            script.src = path;
            document.head.appendChild(script);
        }
    });
}

export function loadSidebarLibraries() {
    if (globalThis.pako && globalThis.msgpack && globalThis.JSZip && globalThis.WQPDataStore) {
        return Promise.resolve();
    }
    if (!loadPromise) {
        loadPromise = SCRIPT_PATHS.reduce(
            (promise, path) => promise.then(() => loadScript(path)),
            Promise.resolve(),
        ).catch((error) => {
            loadPromise = null;
            throw error;
        });
    }
    return loadPromise;
}
