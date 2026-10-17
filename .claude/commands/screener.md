---
name: screener
description: Refresh the local Screener tab's data (screener_universe) from staging. Use when the user runs /screener or asks to refresh/sync the local screener data.
---

Run, from the API repo (`/Users/marcelo/Sites/iorio-reloaded-api`):

```
npm run sync-screener
```

It reads staging's `screener_universe` (read-only) and replaces the local table with it in one transaction; nothing else in the local database changes and the dev server keeps running. Report the script's last line (row count and last refresh time). On failure, report the error as printed; a missing-column error means the local migrations are behind (`npm run migrate:latest`).
