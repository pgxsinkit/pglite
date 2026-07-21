---
'@electric-sql/pglite': patch
---

Sync to the filesystem when a transaction ends. `transaction()` executed its terminal `COMMIT`/`ROLLBACK` while the in-transaction flag still suppressed the per-exec `syncToFs()`, and cleared the flag only afterwards — so a resolved `transaction()` had neither performed nor scheduled any filesystem sync, and a committed transaction was not persisted until some later unrelated query ran. The transaction now ends with the same synchronization as a top-level exec, on the commit, rollback, and explicit `tx.rollback()` paths.
