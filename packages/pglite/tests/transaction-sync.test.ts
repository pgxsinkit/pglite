import { describe, expect, it } from 'vitest'
import { MemoryFS, PGlite } from '../dist/index.js'

class CountingFS extends MemoryFS {
  syncCalls = 0

  override async syncToFs(relaxedDurability?: boolean): Promise<void> {
    this.syncCalls += 1
    await super.syncToFs(relaxedDurability)
  }
}

describe('transaction end synchronization', () => {
  it('syncs to the filesystem after COMMIT before transaction() resolves', async () => {
    const fs = new CountingFS()
    const pg = await PGlite.create({ fs })
    await pg.exec('CREATE TABLE t (v int)')

    let syncsAtCallbackEnd = -1
    await pg.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (1)')
      syncsAtCallbackEnd = fs.syncCalls
    })
    // The terminal COMMIT must end with the same awaited sync as a top-level
    // exec; without it a committed transaction is not persisted until some
    // later unrelated query runs.
    expect(fs.syncCalls).toBeGreaterThan(syncsAtCallbackEnd)
    await pg.close()
  })

  it('syncs after an explicit tx.rollback()', async () => {
    const fs = new CountingFS()
    const pg = await PGlite.create({ fs })
    await pg.exec('CREATE TABLE t (v int)')

    let syncsAtCallbackEnd = -1
    await pg.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (1)')
      await tx.rollback()
      syncsAtCallbackEnd = fs.syncCalls
    })
    expect(fs.syncCalls).toBeGreaterThan(syncsAtCallbackEnd)
    await pg.close()
  })

  it('syncs after the ROLLBACK issued for a throwing callback', async () => {
    const fs = new CountingFS()
    const pg = await PGlite.create({ fs })
    await pg.exec('CREATE TABLE t (v int)')

    let syncsAtCallbackEnd = -1
    await expect(
      pg.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (1)')
        syncsAtCallbackEnd = fs.syncCalls
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')
    expect(fs.syncCalls).toBeGreaterThan(syncsAtCallbackEnd)
    await pg.close()
  })
})
