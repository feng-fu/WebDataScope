import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/custom/platform/robustUniverseSharpe.js', import.meta.url), 'utf8');
let nativeFetchCalls = 0;

const context = {
    console,
    Headers,
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

assert.equal(context.WQS_CUSTOM_COLUMNS.length, 1);
assert.equal(context.WQS_CUSTOM_COLUMNS[0].id, 'robustUniverseSharpe');

const installedFetch = context.fetch;
vm.runInContext(source, context, { filename: 'robustUniverseSharpe.js' });
assert.equal(context.fetch, installedFetch, 'the fetch wrapper must only install once');
assert.equal(context.WQS_CUSTOM_COLUMNS.length, 1, 'the custom column must not be duplicated');

const response = await context.fetch('https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED');
const payload = await response.json();

assert.equal(nativeFetchCalls, 1);
assert.equal(payload.results[0].is.robustUniverseSharpe, 0.73);
assert.equal(payload.results[1].is.robustUniverseSharpe, null);
assert.equal(response.headers.get('content-length'), null);

console.log('robustUniverseSharpe custom integration: ok');
