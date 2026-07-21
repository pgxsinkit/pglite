---
'@electric-sql/pglite': patch
---

Keep the raw-protocol entry points synchronous when no filesystem sync is pending (an unconditional
await starved pglite-tools' pg_dump socket bridge, which drives them from a blocking WASM callMain),
and stop latching awaited non-exclusive sync failures — the caller already receives the rejection,
and replaying it at the next syncToFs() shadowed stateful filesystems' own failure policies. The
failure latch remains for the lanes that cannot report any other way: detached relaxed syncs and the
exclusive-execution (IDBFS) lane.
