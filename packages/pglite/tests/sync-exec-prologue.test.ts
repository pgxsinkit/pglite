import { describe, expect, it } from 'vitest'
import { serialize } from '@electric-sql/pg-protocol'
import { PGlite } from '../dist/index.js'

// The raw-protocol entry points are driven from SYNCHRONOUS WASM callbacks:
// pglite-tools' pg_dump bridges its socket write to execProtocolRawStream and
// reads the streamed bytes back inside a blocking callMain, where the JS
// microtask queue can never drain. The protocol execution must therefore
// complete inside the synchronous prefix of the call whenever no filesystem
// sync is actually pending — an unconditional `await` in the prologue starves
// the bridge and pg_dump reports "server closed the connection unexpectedly".
describe('raw protocol synchronous prefix', () => {
  it('execProtocolRawStream delivers its bytes before the caller can await', async () => {
    const pg = await PGlite.create()
    await pg.exec('SELECT 1') // settle any post-boot sync scheduling

    let received = 0
    const pending = pg.execProtocolRawStream(serialize.query('SELECT 1'), {
      onRawData: (bytes) => {
        received += bytes.length
      },
    })
    // Asserted BEFORE awaiting: a blocked event loop (pg_dump's callMain)
    // would otherwise never observe the response at all.
    expect(received).toBeGreaterThan(0)
    await pending
    await pg.close()
  })
})
