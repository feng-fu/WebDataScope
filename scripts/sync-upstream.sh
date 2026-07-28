#!/usr/bin/env bash
set -euo pipefail

sync_remote="${1:-upstream}"
sync_branch="${2:-main}"
current_branch="$(git branch --show-current)"

if [[ -z "${current_branch}" ]]; then
    echo "Cannot sync from a detached HEAD." >&2
    exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree is not clean. Commit or stash changes before syncing." >&2
    exit 1
fi

if ! git remote get-url "${sync_remote}" >/dev/null 2>&1; then
    echo "Remote '${sync_remote}' does not exist." >&2
    exit 1
fi

git config rerere.enabled true
git config rerere.autoupdate true

echo "Fetching ${sync_remote}..."
if ! GIT_TERMINAL_PROMPT=0 git fetch --prune "${sync_remote}"; then
    echo "Default fetch failed; retrying once with HTTP/1.1..." >&2
    GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 fetch --prune "${sync_remote}"
fi

echo "Merging ${sync_remote}/${sync_branch} into ${current_branch}..."
git merge --no-edit "${sync_remote}/${sync_branch}"

echo "Upstream synchronization completed."
