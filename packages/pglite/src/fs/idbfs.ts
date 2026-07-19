import { EmscriptenBuiltinFilesystem } from './base.js'
import type { PostgresMod } from '../postgresMod.js'
import { PGlite } from '../pglite.js'
import { PGDATA, PG_ROOT } from '../initdb.js'

export class IdbFs extends EmscriptenBuiltinFilesystem {
  readonly syncRequiresExclusiveExecution = true
  #releaseHeldLock?: () => void
  #accessLockRequest?: Promise<void>

  async init(pg: PGlite, opts: Partial<PostgresMod>) {
    this.pg = pg
    await this.#acquireAccessLock()

    const options: Partial<PostgresMod> = {
      ...opts,
      preRun: [
        ...(opts.preRun || []),
        (mod: any) => {
          const idbfs = mod.FS.filesystems.IDBFS
          // Mount the idbfs to the users dataDir then symlink the PGDATA to the
          // idbfs mount point.
          // We specifically use /pglite as the root directory for the idbfs
          // as the fs will be persisted in indexedDB as a database with
          // the path as the name.
          if (!mod.FS.analyzePath(PG_ROOT).exists) {
            mod.FS.mkdir(PG_ROOT)
          }
          if (!mod.FS.analyzePath(`${PG_ROOT}/${this.dataDir}`).exists) {
            mod.FS.mkdir(`${PG_ROOT}/${this.dataDir}`)
          }
          mod.FS.mount(idbfs, {}, `${PG_ROOT}/${this.dataDir}`)
          mod.FS.symlink(`${PG_ROOT}/${this.dataDir}`, PGDATA)
        },
      ],
    }
    return { emscriptenOpts: options }
  }

  initialSyncFs() {
    return this.#syncFs(true)
  }

  syncToFs(_relaxedDurability?: boolean) {
    return this.#syncFs(false)
  }

  async closeFs(): Promise<void> {
    // IDBDatabase.close() method is essentially async, but returns immediately,
    // the database will be closed when all transactions are complete.
    // This needs to be handled in application code if you want to delete the
    // database after it has been closed. If you try to delete the database
    // before it has fully closed it will throw a blocking error.
    await this.#closeResourcesAndReleaseAccessLock()
  }

  async cleanupFailedInit(): Promise<void> {
    await this.#closeResourcesAndReleaseAccessLock()
  }

  async #acquireAccessLock(): Promise<void> {
    const lockManager = globalThis.navigator?.locks
    if (!lockManager) {
      throw new Error('IDBFS requires the Web Locks API')
    }

    const lockName = `pglite-idbfs:${PG_ROOT}/${this.dataDir}`
    let resolveAcquisition!: (acquired: boolean) => void
    let rejectAcquisition!: (reason: unknown) => void
    const acquisition = new Promise<boolean>((resolve, reject) => {
      resolveAcquisition = resolve
      rejectAcquisition = reject
    })
    let releaseLock!: () => void
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    const lockRequest = lockManager.request(
      lockName,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        resolveAcquisition(lock !== null)
        if (lock) {
          await holdLock
        }
      },
    )
    this.#accessLockRequest = lockRequest
    void lockRequest.catch(rejectAcquisition)

    if (!(await acquisition)) {
      await lockRequest
      this.#accessLockRequest = undefined
      throw new Error(`IDBFS database "${this.dataDir}" is already open`)
    }

    this.#releaseHeldLock = releaseLock
  }

  async #releaseAccessLock(): Promise<void> {
    const releaseLock = this.#releaseHeldLock
    const lockRequest = this.#accessLockRequest
    this.#releaseHeldLock = undefined
    this.#accessLockRequest = undefined
    releaseLock?.()
    await lockRequest
  }

  async #closeResourcesAndReleaseAccessLock(): Promise<void> {
    try {
      // On a failed init the Module getter returns undefined rather than
      // throwing; the guard below must handle both missing pg and missing mod.
      const mod = this.pg?.Module
      if (mod) {
        const indexedDb =
          mod.FS.filesystems.IDBFS.dbs[`${PG_ROOT}/${this.dataDir}`]
        indexedDb?.close()
        mod.FS.quit()
      }
    } finally {
      await this.#releaseAccessLock()
    }
  }

  async #syncFs(populate: boolean): Promise<void> {
    const timestampFloor = Date.now()
    await new Promise<void>((resolve, reject) => {
      this.pg!.Module.FS.syncfs(populate, (err: any) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })

    // IDBFS compares only millisecond-resolution mtimes. Do not let a later
    // MEMFS mutation reuse a timestamp that this sync may have persisted.
    // Cost note: this loop only spins when the whole sync completed within a
    // single clock millisecond, so the overhead is bounded by one tick.
    const waitStartedAt = performance.now()
    while (Date.now() === timestampFloor) {
      if (performance.now() - waitStartedAt >= 1000) {
        throw new Error('IDBFS cannot guarantee a distinct MEMFS timestamp')
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}
