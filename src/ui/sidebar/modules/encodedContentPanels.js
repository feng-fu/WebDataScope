import { ENCODED_CHANGELOG } from './changelogData.js';
import { ENCODED_GUIDE } from './guideData.js';
import { ENCODED_ACKNOWLEDGEMENTS } from './acknowledgementsData.js';

function decodeEncodedJson(encoded) {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(decoded);
}

function renderChangelog() {
    const container = document.getElementById('changelogBox');
    if (!container) return;

    try {
        const entries = decodeEncodedJson(ENCODED_CHANGELOG);
        if (!Array.isArray(entries)) throw new Error('Invalid changelog payload');
        const fragment = document.createDocumentFragment();
        entries.forEach((entry) => {
            const article = document.createElement('article');
            article.className = 'changelog-entry';

            const head = document.createElement('div');
            head.className = 'changelog-entry-head';

            const version = document.createElement('strong');
            version.className = 'changelog-version';
            version.textContent = `v${String(entry?.version || '')}`;

            const date = document.createElement('time');
            date.className = 'changelog-date';
            date.dateTime = String(entry?.date || '');
            date.textContent = String(entry?.date || '');

            const items = document.createElement('ul');
            items.className = 'changelog-items';
            (Array.isArray(entry?.items) ? entry.items : []).forEach((item) => {
                const listItem = document.createElement('li');
                listItem.textContent = String(item);
                items.appendChild(listItem);
            });

            head.append(version, date);
            article.append(head, items);
            fragment.appendChild(article);
        });
        container.replaceChildren(fragment);
    } catch (error) {
        console.error('[WQP] 更新日志解码失败：', error);
        container.className = 'changelog-error';
        container.textContent = '更新日志加载失败。';
    }
}

function renderAcknowledgements() {
    const container = document.getElementById('acknowledgementsBox');
    if (!container) return;

    try {
        const acknowledgements = decodeEncodedJson(ENCODED_ACKNOWLEDGEMENTS);
        if (!acknowledgements || !Array.isArray(acknowledgements.items)) {
            throw new Error('Invalid acknowledgements payload');
        }

        const fragment = document.createDocumentFragment();
        const title = document.createElement('div');
        title.className = 'section-title acknowledgements-title';
        title.textContent = String(acknowledgements.title || '致谢与友情链接');
        fragment.appendChild(title);

        const list = document.createElement('ul');
        list.className = 'acknowledgements-list';
        acknowledgements.items.forEach((item) => {
            try {
                const url = new URL(String(item?.href || ''));
                if (!['http:', 'https:'].includes(url.protocol)) return;

                const listItem = document.createElement('li');
                const link = document.createElement('a');
                link.href = url.href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = String(item?.name || url.href);
                listItem.appendChild(link);
                list.appendChild(listItem);
            } catch (error) {
                console.warn('[WQP] 致谢链接无效：', error);
            }
        });
        fragment.appendChild(list);
        container.replaceChildren(fragment);
    } catch (error) {
        console.error('[WQP] 致谢与友情链接解码失败：', error);
        container.className = 'acknowledgements-error';
        container.textContent = '致谢与友情链接加载失败。';
    }
}

function appendGuideList(parent, tagName, values, className) {
    if (!Array.isArray(values) || !values.length) return;
    const list = document.createElement(tagName);
    list.className = className;
    values.forEach((value) => {
        const item = document.createElement('li');
        item.textContent = String(value);
        list.appendChild(item);
    });
    parent.appendChild(list);
}

function renderGuide() {
    const container = document.getElementById('guideBox');
    if (!container) return;

    try {
        const guide = decodeEncodedJson(ENCODED_GUIDE);
        if (!guide || !Array.isArray(guide.sections)) throw new Error('Invalid guide payload');
        const fragment = document.createDocumentFragment();

        const title = document.createElement('h2');
        title.className = 'guide-title';
        title.textContent = String(guide.title || '');
        fragment.appendChild(title);

        if (guide.intro) {
            const intro = document.createElement('p');
            intro.className = 'guide-intro';
            intro.textContent = String(guide.intro);
            fragment.appendChild(intro);
        }

        if (guide.notice && typeof guide.notice === 'object') {
            const notice = document.createElement('aside');
            notice.className = 'guide-notice';
            notice.setAttribute('role', 'note');

            if (guide.notice.title) {
                const noticeTitle = document.createElement('strong');
                noticeTitle.className = 'guide-notice-title';
                noticeTitle.textContent = String(guide.notice.title);
                notice.appendChild(noticeTitle);
            }

            if (guide.notice.text) {
                const noticeText = document.createElement('p');
                noticeText.className = 'guide-notice-text';
                noticeText.textContent = String(guide.notice.text);
                notice.appendChild(noticeText);
            }

            if (guide.notice.href) {
                try {
                    const noticeUrl = new URL(String(guide.notice.href));
                    if (['http:', 'https:'].includes(noticeUrl.protocol)) {
                        const noticeLink = document.createElement('a');
                        noticeLink.className = 'guide-notice-link';
                        noticeLink.href = noticeUrl.href;
                        noticeLink.target = '_blank';
                        noticeLink.rel = 'noopener noreferrer';
                        noticeLink.textContent = String(guide.notice.linkLabel || noticeUrl.href);
                        notice.appendChild(noticeLink);
                    }
                } catch (error) {
                    console.warn('[WQP] 使用指南提示链接无效：', error);
                }
            }

            fragment.appendChild(notice);
        }

        guide.sections.forEach((section, index) => {
            const details = document.createElement('details');
            details.className = 'guide-section';
            details.open = index === 0;

            const summary = document.createElement('summary');
            summary.textContent = String(section?.title || '');
            details.appendChild(summary);

            const body = document.createElement('div');
            body.className = 'guide-section-body';
            if (section?.description) {
                const description = document.createElement('p');
                description.className = 'guide-description';
                description.textContent = String(section.description);
                body.appendChild(description);
            }
            appendGuideList(body, 'ol', section?.steps, 'guide-steps');
            appendGuideList(body, 'ul', section?.notes, 'guide-notes');
            details.appendChild(body);
            fragment.appendChild(details);
        });

        container.replaceChildren(fragment);
    } catch (error) {
        console.error('[WQP] 使用指南解码失败：', error);
        container.className = 'guide-error';
        container.textContent = '使用指南加载失败。';
    }
}

export function initEncodedContentPanels() {
    renderGuide();
    renderChangelog();
    renderAcknowledgements();
}
