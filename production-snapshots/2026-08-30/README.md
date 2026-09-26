# Deployed form Functions source snapshot

Read-only copies of the immutable Google Cloud Functions source archives for project `aokitosou-miniapp` in `us-central1`, downloaded on 2026-09-26. These are the original ZIP bytes; do not edit them.

| Function | Deployed (UTC) | GCS object | Generation | ZIP SHA-256 |
| --- | --- | --- | --- | --- |
| `submitForm` | `2026-08-30T00:17:45.902013367Z` | `gs://gcf-v2-sources-546067044990-us-central1/submitForm/function-source.zip` | `1788048978598520` | `676FFF70C6CA18FFAB68680EC560815FE5CC0E06AF6431DCE0947C6AF095BBB5` |
| `submitOtherInquiry` | `2026-08-30T00:17:56.384941550Z` | `gs://gcf-v2-sources-546067044990-us-central1/submitOtherInquiry/function-source.zip` | `1788049067049548` | `676FFF70C6CA18FFAB68680EC560815FE5CC0E06AF6431DCE0947C6AF095BBB5` |

Each ZIP has 13 files. After Git CRLF-to-LF normalization, every file matches `functions/` at commit `0f6a81c45934ded7d6ebe752bf30f3ad313aeaa4`. The archives are identical to each other. Google Cloud deployment metadata does not identify the operator's Git branch.

For rollback, check out commit `0f6a81c` in a clean worktree and run the exact two-function Firebase deploy target from that source; do not deploy every function. Restore the site by reverting the A release commit on GitHub `main` if necessary. Recheck this procedure before executing a rollback.
