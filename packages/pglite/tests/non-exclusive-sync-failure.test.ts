import { describe, expect, it } from 'vitest'
import { MemoryFS, PGlite } from '../dist/index.js'

class RejectingNonExclusiveFS extends MemoryFS {
  readonly failure = new Error('forced detached sync failure')
  readonly failureObserved: Promise<void>
  #failNextRelaxedSync = false
  #resolveFailureObserved: () => void = () => {}

  constructor() {
    super()
    this.failureObserved = new Promise((resolve) => {
      this.#resolveFailureObserved = resolve
    })
  }

  failNextRelaxedSync(): void {
    this.#failNextRelaxedSync = true
  }

  override async syncToFs(relaxedDurability?: boolean): Promise<void> {
    if (relaxedDurability && this.#failNextRelaxedSync) {
      this.#failNextRelaxedSync = false
      this.#resolveFailureObserved()
      throw this.failure
    }
    await super.syncToFs(relaxedDurability)
  }
}

describe('non-exclusive filesystem sync failure', () => {
  it('latches a detached relaxed rejection for the next public query and sync', async () => {
    const fs = new RejectingNonExclusiveFS()
    const pg = await PGlite.create({ fs, relaxedDurability: true })
    fs.failNextRelaxedSync()

    await pg.exec('SELECT 1')
    await fs.failureObserved

    await expect(pg.exec('SELECT 2')).rejects.toBe(fs.failure)
    await expect(pg.syncToFs()).rejects.toBe(fs.failure)
    await pg.close()
  })
})
