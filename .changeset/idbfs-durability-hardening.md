---
'@electric-sql/pglite': minor
---

Harden IDBFS durability and ownership. Fixes several ways an `idb://` database could lose or corrupt data, with some deliberate behavior changes:

- IDBFS instances now take an exclusive Web Lock on their data directory. A second `PGlite` instance opening the same `idb://` directory fails fast with "already open" instead of silently corrupting the store from two MEMFS trees. The Web Locks API (secure context) is now required for `idb://` data directories.
- Query execution is excluded while an IDBFS sync snapshot is in flight (including under `relaxedDurability`), so a persisted snapshot always corresponds to a single database state. Synchronous entry points (`execProtocolRawSync`, `callMain`, `copyToFS`) throw while a sync is pending.
- Syncs wait for the millisecond clock to advance before completing, closing a window where a write in the same millisecond as a previously persisted mtime was never detected and silently lost.
- A failed background sync now latches: subsequent queries throw instead of silently running without persistence. A successful final sync during `close()` recovers the failure.
- `close()` drains in-flight syncs, performs a final strict sync (persisting the shutdown checkpoint so reopening does not need crash recovery), always releases the lock and IndexedDB connection — including when initialization fails partway — and throws if the final sync failed. Extension `close` hooks run during shutdown and can no longer execute queries; `query`/`sync` calls from a close hook throw "PGlite is closing".
