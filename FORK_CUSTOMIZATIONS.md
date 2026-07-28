# Fork customizations

Fork-owned browser code lives under `src/custom/`. Keep new local features there whenever possible so upstream source files can continue to merge cleanly.

Current integration points are intentionally small:

- `manifest.json` registers the fork scripts before and after the upstream column patcher.
- `src/custom/platform/robustUniverseSharpe.js` enriches alpha-list responses and narrowly augments the inline bundle produced by the upstream column patcher immediately before execution.
- `src/custom/platform/unsubmittedHover.js` contains the unsubmitted-alpha hover panel.

No upstream JavaScript file contains fork business logic. After an upstream merge, verify that the manifest keeps the custom scripts around `patchColumns.js`; the automated tests enforce this ordering.

To synchronize a clean working tree with upstream:

```bash
./scripts/sync-upstream.sh
```

The helper enables Git `rerere`, fetches `upstream`, and merges `upstream/main` into the current branch. If upstream changes one of the two small integration points, Git can reuse a previously recorded resolution where applicable.
