import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import playwright from 'playwright'

const wsPort = process.env.WS_PORT || 3334
const baseUrl = `http://localhost:${wsPort}/tests/targets/web/blank.html`
const pglitePath = '../../../dist/index.js'

describe('IDBFS correctness', () => {
  let browser
  let page

  beforeAll(async () => {
    browser = await playwright.firefox.launch()
    page = await browser.newPage()
    await page.goto(baseUrl)
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('rejects a second owner and releases ownership on close', async () => {
    const result = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://ownership-test'
        const databaseName = '/pglite/ownership-test'
        const owner = await PGlite.create(dataDir)
        const contender = new PGlite(dataDir)

        let contenderError = null
        try {
          await contender.waitReady
          await contender.close()
        } catch (error) {
          contenderError =
            error instanceof Error ? error.message : String(error)
        }

        await owner.close()

        const nextOwner = await PGlite.create(dataDir)
        await nextOwner.close()

        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () =>
            reject(new Error('database deletion blocked'))
        })

        return contenderError
      },
      { pglitePath },
    )

    expect(result).toMatch(/already open/)
  })

  it('releases ownership when initialization fails', async () => {
    const initializationError = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://failed-init-test'
        const databaseName = '/pglite/failed-init-test'
        const failing = new PGlite({
          dataDir,
          fsBundle: new Blob([new Uint8Array(1)]),
        })

        let errorMessage = null
        try {
          await failing.waitReady
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error)
        }

        const nextOwner = await PGlite.create(dataDir)
        await nextOwner.close()

        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () =>
            reject(new Error('database deletion blocked'))
        })

        return errorMessage
      },
      { pglitePath },
    )

    expect(initializationError).toMatch(/Invalid FS bundle size/)
  })

  it('closes IDBFS resources when initialization fails after mounting', async () => {
    const result = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://late-failed-init-test'
        const databaseName = '/pglite/late-failed-init-test'
        const failing = new PGlite({
          dataDir,
          relaxedDurability: true,
          extensions: {
            failing: {
              setup: async (pg) => ({
                init: async () => {
                  const fs = pg.Module.FS
                  const originalSyncfs = fs.syncfs.bind(fs)
                  let delayNextSync = false
                  fs.syncfs = (populate, callback) => {
                    originalSyncfs(populate, (error) => {
                      if (!populate && delayNextSync) {
                        delayNextSync = false
                        setTimeout(() => callback(error), 50)
                      } else {
                        callback(error)
                      }
                    })
                  }
                  await new Promise((resolve) => setTimeout(resolve, 50))
                  delayNextSync = true
                  await pg.syncToFs()
                  throw new Error('forced late initialization failure')
                },
              }),
            },
          },
        })

        let initializationError = null
        try {
          await failing.waitReady
        } catch (error) {
          initializationError =
            error instanceof Error ? error.message : JSON.stringify(error)
        }

        const nextOwner = await PGlite.create(dataDir)
        await nextOwner.close()

        let deletionBlocked = false
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () => {
            deletionBlocked = true
            reject(new Error('database deletion blocked'))
          }
        })

        return { initializationError, deletionBlocked }
      },
      { pglitePath },
    )

    expect(result.initializationError).toBe(
      'forced late initialization failure',
    )
    expect(result.deletionBlocked).toBe(false)
  })

  // Relaxed IDBFS deliberately does NOT serialize queries behind an in-flight
  // snapshot: doing so made every operation pay the whole-FS IndexedDB
  // snapshot latency (measured relaxed == strict at ~80ms/op, reads included).
  // The price is upstream's documented loss window — a crash mid-snapshot can
  // lose the tail — which is what relaxedDurability has always meant here.
  it('runs the next query concurrently while a relaxed sync is taking its snapshot', async () => {
    const result = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://relaxed-sync-test'
        const databaseName = '/pglite/relaxed-sync-test'

        const setup = await PGlite.create(dataDir)
        await setup.exec('CREATE TABLE test (value INTEGER)')
        await setup.close()

        const db = await PGlite.create({
          dataDir,
          relaxedDurability: true,
        })
        const idbfs = db.Module.FS.filesystems.IDBFS
        const originalGetRemoteSet = idbfs.getRemoteSet
        let notifyRemoteSetRequested
        const remoteSetRequested = new Promise((resolve) => {
          notifyRemoteSetRequested = resolve
        })
        let releaseRemoteSet
        const remoteSetRelease = new Promise((resolve) => {
          releaseRemoteSet = resolve
        })

        idbfs.getRemoteSet = (mount, callback) => {
          idbfs.getRemoteSet = originalGetRemoteSet
          notifyRemoteSetRequested()
          void remoteSetRelease.then(() => {
            originalGetRemoteSet.call(idbfs, mount, callback)
          })
        }

        await db.exec('INSERT INTO test VALUES (1)')
        await remoteSetRequested

        let secondQueryFinished = false
        const secondQuery = db.exec('INSERT INTO test VALUES (2)').then(() => {
          secondQueryFinished = true
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        const completedBeforeRelease = secondQueryFinished

        releaseRemoteSet()
        await secondQuery
        await db.close()

        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () =>
            reject(new Error('database deletion blocked'))
        })

        return {
          completedBeforeRelease,
        }
      },
      { pglitePath },
    )

    expect(result.completedBeforeRelease).toBe(true)
  })

  it('does not complete a strict sync until the MEMFS timestamp can advance', async () => {
    const result = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://mtime-test'
        const databaseName = '/pglite/mtime-test'
        const db = await PGlite.create(dataDir)
        await db.exec('CREATE TABLE test (value INTEGER)')

        const fs = db.Module.FS
        const originalSyncfs = fs.syncfs.bind(fs)
        let notifySyncCompleted
        const syncCompleted = new Promise((resolve) => {
          notifySyncCompleted = resolve
        })
        let interceptNextSync = true
        fs.syncfs = (populate, callback) => {
          originalSyncfs(populate, (error) => {
            if (!populate && interceptNextSync) {
              interceptNextSync = false
              notifySyncCompleted()
            }
            callback(error)
          })
        }

        const originalDateNow = Date.now
        let now = originalDateNow()
        Date.now = () => now

        let completedBeforeClockAdvance
        try {
          let queryFinished = false
          const query = db.exec('INSERT INTO test VALUES (1)').then(() => {
            queryFinished = true
          })
          await syncCompleted
          await new Promise((resolve) => setTimeout(resolve, 0))
          completedBeforeClockAdvance = queryFinished

          now += 1
          await query
        } finally {
          // A frozen clock outlives this test's failure and poisons every
          // later test in the page — always restore it.
          Date.now = originalDateNow
        }
        await db.close()

        const reopened = await PGlite.create(dataDir)
        const persisted = await reopened.exec('SELECT value FROM test')
        await reopened.close()

        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () =>
            reject(new Error('database deletion blocked'))
        })

        return {
          completedBeforeClockAdvance,
          persisted,
        }
      },
      { pglitePath },
    )

    // The strict query itself awaits its sync inline, so the mtime-tick gate
    // in #syncFs holds it until the clock can advance — no exclusive-execution
    // machinery involved. (The former "sync is pending" probes asserted that
    // machinery; it is intentionally not engaged for IDBFS any more.)
    expect(result.completedBeforeClockAdvance).toBe(false)
    expect(result.persisted[0].rows).toEqual([{ value: 1 }])
  })

  it('releases ownership after recovering a failed relaxed sync on close', async () => {
    const result = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://sync-failure-test'
        const databaseName = '/pglite/sync-failure-test'
        const db = await PGlite.create({
          dataDir,
          relaxedDurability: true,
        })
        await db.exec('CREATE TABLE test (value INTEGER)')

        const fs = db.Module.FS
        const originalSyncfs = fs.syncfs.bind(fs)
        let failNextSync = true
        let notifyFailureDelivered
        const failureDelivered = new Promise((resolve) => {
          notifyFailureDelivered = resolve
        })
        fs.syncfs = (populate, callback) => {
          if (!populate && failNextSync) {
            failNextSync = false
            queueMicrotask(() => {
              callback(new Error('forced sync failure'))
              notifyFailureDelivered()
            })
          } else {
            originalSyncfs(populate, callback)
          }
        }

        await db.exec('INSERT INTO test VALUES (1)')
        // The failing sync is detached (it may still be queued behind an
        // earlier in-flight snapshot); the latch delivers on the first public
        // operation AFTER the rejection has settled — wait for the delivery,
        // then a macrotask for it to propagate to the latch.
        await failureDelivered
        await new Promise((resolve) => setTimeout(resolve, 0))
        let queryError = null
        try {
          await db.exec('SELECT * FROM test')
        } catch (error) {
          queryError = error instanceof Error ? error.message : String(error)
        }

        await db.close()
        const nextOwner = await PGlite.create(dataDir)
        const persisted = await nextOwner.exec('SELECT value FROM test')
        await nextOwner.close()

        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () =>
            reject(new Error('database deletion blocked'))
        })

        return { queryError, persisted }
      },
      { pglitePath },
    )

    expect(result.queryError).toBe('forced sync failure')
    expect(result.persisted[0].rows).toEqual([{ value: 1 }])
  })

  it('performs final sync and releases ownership when an extension close hook fails', async () => {
    const result = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://extension-close-failure-test'
        const databaseName = '/pglite/extension-close-failure-test'
        let finalSyncRequested = false
        let atexitCalled = false
        let syncDuringCloseError = null
        const db = await PGlite.create({
          dataDir,
          relaxedDurability: true,
          extensions: {
            failing: {
              setup: async (pg) => ({
                close: async () => {
                  try {
                    await pg.syncToFs()
                  } catch (error) {
                    syncDuringCloseError =
                      error instanceof Error ? error.message : String(error)
                  }
                  const fs = pg.Module.FS
                  const originalSyncfs = fs.syncfs.bind(fs)
                  const originalAtexit = pg.Module._pgl_run_atexit_funcs
                  fs.syncfs = (populate, callback) => {
                    if (!populate) {
                      finalSyncRequested = true
                    }
                    originalSyncfs(populate, callback)
                  }
                  pg.Module._pgl_run_atexit_funcs = () => {
                    atexitCalled = true
                    return originalAtexit.call(pg.Module)
                  }
                  throw new Error('forced extension close failure')
                },
              }),
            },
          },
        })

        const fs = db.Module.FS
        const originalSyncfs = fs.syncfs.bind(fs)
        let delayNextSync = true
        fs.syncfs = (populate, callback) => {
          originalSyncfs(populate, (error) => {
            if (!populate && delayNextSync) {
              delayNextSync = false
              setTimeout(() => {
                callback(error)
              }, 50)
            } else {
              callback(error)
            }
          })
        }
        await db.exec('SELECT 1')

        let closeError = null
        try {
          await db.close()
        } catch (error) {
          closeError = error instanceof Error ? error.message : String(error)
        }
        let syncAfterCloseError = null
        try {
          await db.syncToFs()
        } catch (error) {
          syncAfterCloseError =
            error instanceof Error ? error.message : String(error)
        }

        const nextOwner = await PGlite.create(dataDir)
        await nextOwner.close()

        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () =>
            reject(new Error('database deletion blocked'))
        })

        return {
          closeError,
          finalSyncRequested,
          atexitCalled,
          syncDuringCloseError,
          syncAfterCloseError,
        }
      },
      { pglitePath },
    )

    expect(result.closeError).toBe('forced extension close failure')
    expect(result.finalSyncRequested).toBe(true)
    expect(result.atexitCalled).toBe(true)
    expect(result.syncDuringCloseError).toBe('PGlite is closing')
    expect(result.syncAfterCloseError).toBe('PGlite is closed')
  })

  it('reports a final sync failure ahead of an extension close failure', async () => {
    const closeError = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://combined-close-failure-test'
        const databaseName = '/pglite/combined-close-failure-test'
        const db = await PGlite.create({
          dataDir,
          extensions: {
            failing: {
              setup: async (pg) => ({
                close: async () => {
                  const fs = pg.Module.FS
                  fs.syncfs = (populate, callback) => {
                    if (populate) {
                      callback(null)
                    } else {
                      queueMicrotask(() =>
                        callback(new Error('forced final sync failure')),
                      )
                    }
                  }
                  throw new Error('forced extension close failure')
                },
              }),
            },
          },
        })

        let errorMessage = null
        try {
          await db.close()
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error)
        }

        const nextOwner = await PGlite.create(dataDir)
        await nextOwner.close()

        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () =>
            reject(new Error('database deletion blocked'))
        })

        return errorMessage
      },
      { pglitePath },
    )

    expect(closeError).toBe('forced final sync failure')
  })

  it('shuts down cleanly so reopening does not perform crash recovery', async () => {
    const result = await page.evaluate(
      async ({ pglitePath }) => {
        const { PGlite } = await import(pglitePath)
        const dataDir = 'idb://clean-shutdown-test'
        const databaseName = '/pglite/clean-shutdown-test'
        const recoveryPattern = /not properly shut down|automatic recovery/

        // With debug enabled PGlite routes postgres stderr to console.error,
        // where crash recovery announces itself on startup.
        const collectReopenStderr = async () => {
          const messages = []
          const originalError = console.error
          console.error = (...args) => {
            messages.push(args.map(String).join(' '))
          }
          try {
            const reopened = await PGlite.create({ dataDir, debug: 1 })
            const rows = await reopened.exec(
              'SELECT value FROM test ORDER BY value',
            )
            await reopened.close()
            return { messages, rows }
          } finally {
            console.error = originalError
          }
        }

        const db = await PGlite.create(dataDir)
        await db.exec('CREATE TABLE test (value INTEGER)')
        await db.exec('INSERT INTO test VALUES (1)')
        await db.close()

        const cleanReopen = await collectReopenStderr()
        const cleanRecoveryDetected = cleanReopen.messages.some((message) =>
          recoveryPattern.test(message),
        )

        // Positive control for the detection channel: simulate a crash by
        // dropping every sync from here on, so the shutdown checkpoint never
        // reaches IndexedDB and the store is left at the last query's state.
        const crashDb = await PGlite.create(dataDir)
        await crashDb.exec('INSERT INTO test VALUES (2)')
        crashDb.Module.FS.syncfs = (_populate, callback) =>
          queueMicrotask(() => callback(null))
        await crashDb.close()

        const crashReopen = await collectReopenStderr()
        const crashRecoveryDetected = crashReopen.messages.some((message) =>
          recoveryPattern.test(message),
        )

        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
          request.onblocked = () =>
            reject(new Error('database deletion blocked'))
        })

        return {
          cleanRecoveryDetected,
          crashRecoveryDetected,
          persistedAfterCrash: crashReopen.rows[0].rows,
        }
      },
      { pglitePath },
    )

    expect(result.cleanRecoveryDetected).toBe(false)
    expect(result.crashRecoveryDetected).toBe(true)
    expect(result.persistedAfterCrash).toEqual([{ value: 1 }, { value: 2 }])
  })
})
