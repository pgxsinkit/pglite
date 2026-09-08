---
'@electric-sql/pglite': patch
---

Fix a temporal dead zone in the live extension: a notification that arrives
while a live query is still initialising no longer throws
`ReferenceError: Cannot access 'refresh' before initialization`.

`live.query` and `live.changes` register their per-table notification listeners
inside the transaction that initialises the query, but the `refresh` function
those listeners call is only created after that transaction has returned.
`PGlite#listen` adds a callback to its dispatch table before it issues the
`LISTEN`, so a notification delivered while initialisation is still in flight —
riding back on a reply inside the initialising transaction, or sent by another
session — invoked `refresh` in its temporal dead zone. The rejection surfaced as
an unhandled rejection inside the notification dispatch and the refresh was
lost. Such a notification is now recorded and replayed once `refresh` exists.
