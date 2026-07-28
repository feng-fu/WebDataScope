import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const referencedFiles = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
].filter(Boolean);

await Promise.all(referencedFiles.map((file) => access(resolve(root, file))));

const columnPatchEntry = manifest.content_scripts.find((entry) =>
    entry.js?.includes('src/content/platform/common/patchColumns.js')
);
assert.ok(columnPatchEntry, 'patchColumns content-script registration is required');
assert.deepEqual(columnPatchEntry.js.slice(0, 2), [
    'src/custom/platform/robustUniverseSharpe.js',
    'src/content/platform/common/patchColumns.js',
]);

console.log(`manifest paths: ok (${referencedFiles.length} files)`);
