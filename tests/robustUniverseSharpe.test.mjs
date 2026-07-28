import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/custom/platform/robustUniverseSharpe.js', import.meta.url), 'utf8');
let nativeFetchCalls = 0;

class FakeNode {
    appendChild(node) {
        this.lastChild = node;
        return node;
    }
}

const context = {
    console,
    Headers,
    Node: FakeNode,
    Response,
    fetch: async () => {
        nativeFetchCalls += 1;
        return new Response(JSON.stringify({
            results: [
                {
                    id: 'alpha-with-ratio',
                    is: {
                        checks: [
                            { name: 'LOW_ROBUST_UNIVERSE_SHARPE.WITH_RATIO', value: 0.73 },
                        ],
                    },
                },
                { id: 'alpha-without-checks' },
            ],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': '999' },
        });
    },
};
context.window = context;
vm.createContext(context);

vm.runInContext(source, context, { filename: 'robustUniverseSharpe.js' });

const installedFetch = context.fetch;
const installedAppendChild = context.Node.prototype.appendChild;
vm.runInContext(source, context, { filename: 'robustUniverseSharpe.js' });
assert.equal(context.fetch, installedFetch, 'the fetch wrapper must only install once');
assert.equal(context.Node.prototype.appendChild, installedAppendChild, 'the DOM hook must only install once');

const bundleScript = {
    nodeName: 'SCRIPT',
    src: '',
    textContent: 'prefix,{"id":"failedNumRA"},{"id":"operatorCount","parent":"regular"},{suffix',
};
new context.Node().appendChild(bundleScript);
assert.match(bundleScript.textContent, /"id":"operatorCount"[^}]*},\{"id":"robustUniverseSharpe"/);

const alreadyPatched = bundleScript.textContent;
new context.Node().appendChild(bundleScript);
assert.equal(bundleScript.textContent, alreadyPatched, 'the custom column must not be duplicated');

const response = await context.fetch('https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED');
const payload = await response.json();

assert.equal(nativeFetchCalls, 1);
assert.equal(payload.results[0].is.robustUniverseSharpe, 0.73);
assert.equal(payload.results[1].is.robustUniverseSharpe, null);
assert.equal(response.headers.get('content-length'), null);

console.log('robustUniverseSharpe custom integration: ok');
