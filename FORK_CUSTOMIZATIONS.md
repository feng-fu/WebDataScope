# Fork customizations

Fork-owned browser code lives under `src/custom/`. Keep new local features there whenever possible so upstream source files can continue to merge cleanly.

Current integration points are intentionally small:

- `manifest.json` registers the fork scripts.
- `src/content/platform/common/patchColumns.js` appends columns declared through `globalThis.WQS_CUSTOM_COLUMNS`.
- `src/custom/platform/robustUniverseSharpe.js` declares the custom column and enriches alpha-list responses without modifying upstream's background worker.
- `src/custom/platform/unsubmittedHover.js` contains the unsubmitted-alpha hover panel.

To synchronize a clean working tree with upstream:

```bash
./scripts/sync-upstream.sh
```

The helper enables Git `rerere`, fetches `upstream`, and merges `upstream/main` into the current branch. If upstream changes one of the two small integration points, Git can reuse a previously recorded resolution where applicable.
