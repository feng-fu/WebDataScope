import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import core from '../src/content/support/communityEnhanceCore.js';

const {
    authorIdFrom,
    badgeKey,
    classifyInlineCode,
    guessLang,
    highlightFastExpr,
    looksLikeFastExpr,
    normalizeFollowedIds,
} = core;

test('community enhancement is injected as ordered classic content scripts', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const entry = manifest.content_scripts.find((item) => item.js?.includes(
        'src/content/support/communityEnhance.js',
    ));

    assert.ok(entry, 'Community enhancement content script must be registered.');
    assert.equal(entry.type, undefined, 'Static content scripts cannot opt into module parsing.');
    assert.deepEqual(entry.js, [
        'src/vendor/js/highlight.min.js',
        'src/content/support/communityEnhanceCore.js',
        'src/content/support/communityEnhance.js',
    ]);

    for (const path of entry.js.slice(1)) {
        const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
        assert.doesNotThrow(() => new vm.Script(source), `${path} must parse as a classic script.`);
    }
});

test('guessLang detects python, json and fastplus snippets', () => {
    assert.equal(guessLang('import fastplus\nalpha = 1'), 'python');
    assert.equal(guessLang("{'matrix': ['close']}"), 'json');
    assert.equal(guessLang('const x = () => 1'), 'javascript');
    assert.equal(guessLang('hello world'), '');
});

test('highlightFastExpr colors BRAIN operators, fields and fastplus APIs', () => {
    const html = highlightFastExpr('a=ts_delay(close, 5); group_rank(a, industry)');
    assert.match(html, /wqp-ce-op">ts_delay</);
    assert.match(html, /wqp-ce-field">close</);
    assert.match(html, /wqp-ce-op">group_rank</);
    assert.match(html, /wqp-ce-field">industry</);
    assert.match(html, /hljs-number">5</);
});

test('highlightFastExpr preserves every character in malformed strings', () => {
    const samples = [
        'ts_delay("close, 5)',
        "group_rank('returns, industry)",
        'fastplus.parse("ts_delay(\\"close\\", 5)")',
        '<tag>&value',
    ];

    for (const sample of samples) {
        const renderedText = highlightFastExpr(sample)
            .replace(/<[^>]*>/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
        assert.equal(renderedText, sample);
    }
});

test('highlightFastExpr colors FASTEXPR tokens inside quoted strings', () => {
    const html = highlightFastExpr('"fastplus.parse(ts_delay(close, 5))"');
    assert.match(html, /wqp-ce-api">fastplus</);
    assert.match(html, /wqp-ce-api">parse</);
    assert.match(html, /wqp-ce-op">ts_delay</);
    assert.match(html, /wqp-ce-field">close</);
    assert.match(html, /hljs-number">5</);
});

test('looksLikeFastExpr recognizes expression strings but not prose', () => {
    assert.equal(looksLikeFastExpr('ts_delay(close, 5)'), true);
    assert.equal(looksLikeFastExpr('hello consultant'), false);
});

test('classifyInlineCode maps platform chips', () => {
    assert.equal(classifyInlineCode('fastplus'), 'api');
    assert.equal(classifyInlineCode('ts_delay'), 'op');
    assert.equal(classifyInlineCode('close'), 'field');
    assert.equal(classifyInlineCode('hello'), '');
});

test('authorIdFrom only accepts consultant IDs', () => {
    assert.equal(authorIdFrom('SZ83096 ★'), 'SZ83096');
    assert.equal(authorIdFrom('7 days ago'), '');
    assert.equal(authorIdFrom('Edited'), '');
});

test('badgeKey and follow-id normalization', () => {
    assert.equal(badgeKey('Gold Consultant'), 'gold');
    assert.equal(badgeKey('Staff'), 'staff');
    assert.deepEqual(normalizeFollowedIds([' SZ83096 ', 'sz83096', '', 'KH94146']), ['sz83096', 'kh94146']);
});
