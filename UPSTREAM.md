# Upstream

AIOPC is built on [OpenWork](https://github.com/different-ai/openwork) (MIT; the `ee/` directory has its own license and is not used by AIOPC).

- Imported from: `different-ai/openwork` @ `0d06aff4c1ffc12a16aa1c81ad902920b0b9ca56` (2026-11-10)
- Imported without history; this file is the sync point.

## Syncing upstream changes

```sh
git remote add upstream https://github.com/different-ai/openwork   # once
git fetch --depth=200 upstream dev
git diff 0d06aff4c1ffc12a16aa1c81ad902920b0b9ca56 upstream/dev > /tmp/upstream.patch
git apply --3way /tmp/upstream.patch    # resolve conflicts, then update the commit above
```
