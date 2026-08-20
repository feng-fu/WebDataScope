import { initSessionPanel } from './modules/sessionPanel.js';
import { initSettingsPanel } from './modules/settingsPanel.js';
import { bindTabs, setStatus } from './modules/ui.js';

const panelInitializers = {
    prodmemo: async () => {
        const { initProdMemoPanel } = await import('./modules/prodMemoPanel.js');
        await initProdMemoPanel();
    },
    community: async () => {
        await Promise.all([
            import('./modules/favoritePostsPanel.js')
                .then(({ initFavoritePostsPanel }) => initFavoritePostsPanel()),
            import('./modules/communityPanel.js')
                .then(({ initCommunityPanel }) => initCommunityPanel()),
        ]);
    },
    help: async () => {
        const { initEncodedContentPanels } = await import('./modules/encodedContentPanels.js');
        initEncodedContentPanels();
    },
};

const panelInitPromises = new Map();

function initializePanel(key) {
    if (!panelInitializers[key]) return Promise.resolve();
    if (panelInitPromises.has(key)) return panelInitPromises.get(key);
    const promise = panelInitializers[key]().catch((error) => {
        panelInitPromises.delete(key);
        setStatus(`${key} 页面加载失败：${error.message}`, 'error');
        throw error;
    });
    panelInitPromises.set(key, promise);
    return promise;
}

document.addEventListener('DOMContentLoaded', async () => {
    bindTabs((key) => {
        initializePanel(key).catch(() => {});
    });
    await Promise.allSettled([
        initSettingsPanel(),
        initSessionPanel(),
    ]);
});
