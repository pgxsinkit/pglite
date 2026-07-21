---
'@electric-sql/pglite': patch
---

Restore relaxed-durability concurrency for IDBFS: queries no longer wait out an in-flight whole-FS
IndexedDB snapshot. The exclusive-execution lane had made every operation pay the full snapshot
latency (measured: relaxed == strict at ~80ms/op, reads included, and bulk workloads timing out).
Relaxed IDBFS returns to upstream's contract — background snapshots race queries and a crash
mid-snapshot can lose the tail (the documented loss window). Retained: the Web Locks single-owner
access lock, failed-init resource cleanup, the detached sync-failure latch, the close() drain and
final strict sync, and the distinct-mtime guard for snapshot diffing.
