import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OpfsPackedFS } from '../src/fs/opfs-packed.js'

// A minimal in-memory mock of the subset of the OPFS API the FS uses, plus a
// FileSystemSyncAccessHandle backed by a growable Uint8Array with POSIX-ish
// semantics (truncate-grow zero-fills).

let openHandles = 0
let maxOpenHandles = 0

class MockSyncAccessHandle {
  file: MockFile
  #closed = false

  constructor(file: MockFile) {
    this.file = file
    openHandles++
    maxOpenHandles = Math.max(maxOpenHandles, openHandles)
  }

  #view(buffer: ArrayBuffer | ArrayBufferView): Uint8Array {
    return buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  getSize(): number {
    return this.file.data.length
  }

  read(buffer: ArrayBuffer | ArrayBufferView, { at }: { at: number }): number {
    const view = this.#view(buffer)
    const available = Math.max(0, this.file.data.length - at)
    const n = Math.min(view.length, available)
    view.set(this.file.data.subarray(at, at + n))
    // OPFS leaves the remainder of the view untouched
    return n
  }

  write(buffer: ArrayBuffer | ArrayBufferView, { at }: { at: number }): number {
    const view = this.#view(buffer)
    const end = at + view.length
    if (end > this.file.data.length) {
      const next = new Uint8Array(end)
      next.set(this.file.data)
      this.file.data = next
    }
    this.file.data.set(view, at)
    return view.length
  }

  truncate(newSize: number): void {
    const next = new Uint8Array(newSize)
    next.set(
      this.file.data.subarray(0, Math.min(this.file.data.length, newSize)),
    )
    this.file.data = next
  }

  flush(): void {}

  close(): void {
    if (this.#closed) return
    this.#closed = true
    openHandles--
  }
}

class MockFile {
  name: string
  data: Uint8Array = new Uint8Array(0)
  constructor(name: string) {
    this.name = name
  }
}

class MockFileHandle {
  _file: MockFile
  constructor(file: MockFile) {
    this._file = file
  }
  get name() {
    return this._file.name
  }
  async createSyncAccessHandle() {
    return new MockSyncAccessHandle(this._file)
  }
}

class MockDirectoryHandle {
  name: string
  #dirs = new Map<string, MockDirectoryHandle>()
  #files = new Map<string, MockFile>()

  constructor(name: string) {
    this.name = name
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let dir = this.#dirs.get(name)
    if (!dir) {
      if (!opts?.create) {
        throw new Error(`NotFoundError: ${name}`)
      }
      dir = new MockDirectoryHandle(name)
      this.#dirs.set(name, dir)
    }
    return dir
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let file = this.#files.get(name)
    if (!file) {
      if (!opts?.create) {
        throw new Error(`NotFoundError: ${name}`)
      }
      file = new MockFile(name)
      this.#files.set(name, file)
    }
    return new MockFileHandle(file)
  }

  async removeEntry(name: string) {
    this.#files.delete(name)
    this.#dirs.delete(name)
  }

  // Test-only helper to inspect the packed data file without opening a handle
  _fileData(path: string[]): Uint8Array {
    if (path.length === 1) {
      return this.#files.get(path[0]!)!.data
    }
    const [head, ...rest] = path
    return this.#dirs.get(head!)!._fileData(rest)
  }
}

const fakePg = { Module: { FS: { quit() {} } } } as any

function stubNavigator(root: MockDirectoryHandle) {
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => root },
  })
}

async function openFs(
  root: MockDirectoryHandle,
  opts?: { extentSize?: number },
) {
  stubNavigator(root)
  const fs = new OpfsPackedFS('base', opts)
  await fs.init(fakePg, {})
  return fs
}

function writeAt(
  fs: OpfsPackedFS,
  fd: number,
  bytes: Uint8Array,
  position: number,
) {
  // base.ts passes an ArrayBuffer to write()
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  )
  return fs.write(fd, ab as any, 0, bytes.length, position)
}

function readAt(
  fs: OpfsPackedFS,
  fd: number,
  length: number,
  position: number,
) {
  const buf = new Uint8Array(length)
  const n = fs.read(fd, buf, 0, length, position)
  return { n, buf }
}

function seq(length: number, start = 0): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (start + i) % 256
  return out
}

describe('OpfsPackedFS', () => {
  beforeEach(() => {
    openHandles = 0
    maxOpenHandles = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws on non-multiple-of-8192 extentSize', () => {
    expect(() => new OpfsPackedFS('base', { extentSize: 1000 })).toThrow()
    expect(() => new OpfsPackedFS('base', { extentSize: 0 })).toThrow()
    expect(() => new OpfsPackedFS('base', { extentSize: 8192 + 1 })).toThrow()
    expect(() => new OpfsPackedFS('base', { extentSize: 8192 })).not.toThrow()
    expect(() => new OpfsPackedFS('base', { extentSize: 16384 })).not.toThrow()
  })

  it('multi-extent write/read roundtrip with boundary crossing and EOF clamp', async () => {
    const root = new MockDirectoryHandle('')
    const fs = await openFs(root, { extentSize: 8192 })
    fs.writeFile('/f', '')
    const fd = fs.open('/f')

    const data = seq(20000)
    expect(writeAt(fs, fd, data, 0)).toBe(20000)
    expect(fs.lstat('/f').size).toBe(20000)

    // Full read
    const full = readAt(fs, fd, 20000, 0)
    expect(full.n).toBe(20000)
    expect(full.buf).toEqual(data)

    // Read crossing an extent boundary (8192)
    const cross = readAt(fs, fd, 4000, 6000)
    expect(cross.n).toBe(4000)
    expect(cross.buf).toEqual(data.subarray(6000, 10000))

    // Read clamped at EOF
    const clamped = readAt(fs, fd, 5000, 18000)
    expect(clamped.n).toBe(2000)
    expect(clamped.buf.subarray(0, 2000)).toEqual(data.subarray(18000, 20000))

    // Read entirely past EOF
    expect(readAt(fs, fd, 100, 20000).n).toBe(0)

    // Write crossing a boundary in place
    const patch = seq(3000, 77)
    writeAt(fs, fd, patch, 7000)
    const back = readAt(fs, fd, 3000, 7000)
    expect(back.buf).toEqual(patch)

    fs.close(fd)
    await fs.closeFs()
  })

  it('writes into a hole past EOF, intermediate extents read as zeros', async () => {
    const root = new MockDirectoryHandle('')
    const fs = await openFs(root, { extentSize: 8192 })
    fs.writeFile('/f', '')
    const fd = fs.open('/f')

    writeAt(fs, fd, seq(100, 1), 0)
    writeAt(fs, fd, seq(100, 200), 20000)
    expect(fs.lstat('/f').size).toBe(20100)

    // The hole between the two writes must be zeros
    const hole = readAt(fs, fd, 19900, 100)
    expect(hole.n).toBe(19900)
    expect(hole.buf.every((b) => b === 0)).toBe(true)

    fs.close(fd)
    await fs.closeFs()
  })

  it('truncate shrink frees extents and zeros the boundary tail', async () => {
    const root = new MockDirectoryHandle('')
    const fs = await openFs(root, { extentSize: 8192 })
    fs.writeFile('/f', '')
    const fd = fs.open('/f')
    writeAt(fs, fd, seq(20000, 3), 0)

    const totalBefore = fs.state.totalExtents
    fs.truncate('/f', 5000)
    expect(fs.lstat('/f').size).toBe(5000)
    // 20000 -> 3 extents, 5000 -> 1 extent, 2 freed
    expect(fs.state.freeExtents.length).toBe(2)
    expect(fs.state.totalExtents).toBe(totalBefore)

    // Re-extend and confirm the previously-truncated tail reads as zeros
    writeAt(fs, fd, seq(10, 9), 15000)
    const tail = readAt(fs, fd, 10000, 5000)
    expect(tail.n).toBe(10000)
    // [5000, 15000) must be zeros (old data was truncated away)
    expect(tail.buf.subarray(0, 10000).every((b) => b === 0)).toBe(true)

    fs.close(fd)
    await fs.closeFs()
  })

  it('truncate grow reads zeros', async () => {
    const root = new MockDirectoryHandle('')
    const fs = await openFs(root, { extentSize: 8192 })
    fs.writeFile('/f', '')
    const fd = fs.open('/f')
    writeAt(fs, fd, seq(100, 5), 0)

    fs.truncate('/f', 20000)
    expect(fs.lstat('/f').size).toBe(20000)
    const grown = readAt(fs, fd, 19900, 100)
    expect(grown.n).toBe(19900)
    expect(grown.buf.every((b) => b === 0)).toBe(true)

    fs.close(fd)
    await fs.closeFs()
  })

  it('unlink returns extents to the free list, realloc reads as zeros', async () => {
    const root = new MockDirectoryHandle('')
    const fs = await openFs(root, { extentSize: 8192 })
    fs.writeFile('/a', '')
    const fda = fs.open('/a')
    writeAt(fs, fda, seq(20000, 1), 0)
    fs.close(fda)
    const totalAfterWrite = fs.state.totalExtents
    expect(totalAfterWrite).toBe(3)

    fs.unlink('/a')
    expect(fs.state.freeExtents.length).toBe(3)

    // A new file should reuse the freed extents and read as zeros
    fs.writeFile('/b', '')
    const fdb = fs.open('/b')
    writeAt(fs, fdb, seq(10, 42), 8192 * 2) // force 3 extents, holes in first two
    expect(fs.state.totalExtents).toBe(totalAfterWrite) // reused, no growth
    const reused = readAt(fs, fdb, 8192 * 2, 0)
    expect(reused.buf.every((b) => b === 0)).toBe(true)

    fs.close(fdb)
    await fs.closeFs()
  })

  it('rename with overwrite frees the target extents', async () => {
    const root = new MockDirectoryHandle('')
    const fs = await openFs(root, { extentSize: 8192 })
    fs.writeFile('/a', '')
    fs.writeFile('/b', '')
    const fda = fs.open('/a')
    const fdb = fs.open('/b')
    writeAt(fs, fda, seq(9000, 1), 0) // 2 extents
    writeAt(fs, fdb, seq(20000, 2), 0) // 3 extents
    fs.close(fda)
    fs.close(fdb)
    expect(fs.state.freeExtents.length).toBe(0)

    fs.rename('/a', '/b')
    // /b's 3 extents freed, /a moved to /b
    expect(fs.state.freeExtents.length).toBe(3)
    expect(fs.lstat('/b').size).toBe(9000)
    expect(() => fs.lstat('/a')).toThrow()

    await fs.closeFs()
  })

  it('reopen WITHOUT checkpoint replays the WAL to an identical state', async () => {
    const root = new MockDirectoryHandle('')
    let fs = await openFs(root, { extentSize: 8192 })

    fs.mkdir('/dir')
    fs.writeFile('/dir/a', '')
    const fda = fs.open('/dir/a')
    const a = seq(20000, 11)
    writeAt(fs, fda, a, 0)
    fs.close(fda)

    fs.writeFile('/dir/b', '')
    const fdb = fs.open('/dir/b')
    const b = seq(5000, 22)
    writeAt(fs, fdb, b, 0)
    fs.close(fdb)

    fs.truncate('/dir/a', 12000)
    fs.chmod('/dir/b', 0o600)

    // Close (flushes, but does NOT checkpoint -> WAL remains on disk)
    await fs.closeFs()
    expect(maxOpenHandles).toBe(2)

    // Reopen over the same mock directory
    fs = await openFs(root, { extentSize: 8192 })
    expect(fs.lstat('/dir/a').size).toBe(12000)
    expect(fs.lstat('/dir/b').size).toBe(5000)
    expect(fs.lstat('/dir/b').mode).toBe(0o600)

    const fda2 = fs.open('/dir/a')
    expect(readAt(fs, fda2, 12000, 0).buf).toEqual(a.subarray(0, 12000))
    fs.close(fda2)

    const fdb2 = fs.open('/dir/b')
    expect(readAt(fs, fdb2, 5000, 0).buf).toEqual(b)
    fs.close(fdb2)

    await fs.closeFs()
    expect(maxOpenHandles).toBe(2)
  })

  it('reopen after checkpointState reloads from the baseline snapshot', async () => {
    const root = new MockDirectoryHandle('')
    let fs = await openFs(root, { extentSize: 8192 })

    fs.writeFile('/a', '')
    const fda = fs.open('/a')
    const a = seq(20000, 33)
    writeAt(fs, fda, a, 0)
    fs.close(fda)
    await fs.checkpointState()
    await fs.closeFs()

    fs = await openFs(root, { extentSize: 8192 })
    expect(fs.lstat('/a').size).toBe(20000)
    const fda2 = fs.open('/a')
    expect(readAt(fs, fda2, 20000, 0).buf).toEqual(a)
    fs.close(fda2)
    await fs.closeFs()
  })

  it('honours an existing state extentSize over the option on reopen', async () => {
    const root = new MockDirectoryHandle('')
    let fs = await openFs(root, { extentSize: 16384 })
    fs.writeFile('/a', '')
    const fda = fs.open('/a')
    writeAt(fs, fda, seq(20000, 3), 0)
    fs.close(fda)
    expect(fs.state.extentSize).toBe(16384)
    await fs.closeFs()

    // Reopen requesting a different extentSize - state value wins
    fs = await openFs(root, { extentSize: 8192 })
    expect(fs.state.extentSize).toBe(16384)
    expect(fs.lstat('/a').size).toBe(20000)
    await fs.closeFs()
  })

  it('tail-trim shrinks totalExtents and the data file on checkpoint', async () => {
    const root = new MockDirectoryHandle('')
    const fs = await openFs(root, { extentSize: 8192 })
    fs.writeFile('/a', '')
    const fda = fs.open('/a')
    writeAt(fs, fda, seq(20000, 1), 0) // 3 extents
    fs.close(fda)
    expect(fs.state.totalExtents).toBe(3)
    expect(root._fileData(['base', 'data.bin']).length).toBe(3 * 8192)

    fs.unlink('/a') // frees extents 0,1,2 (the whole tail)
    await fs.checkpointState()
    expect(fs.state.totalExtents).toBe(0)
    expect(fs.state.freeExtents.length).toBe(0)
    expect(root._fileData(['base', 'data.bin']).length).toBe(0)

    await fs.closeFs()
  })

  it('never opens more than 2 sync access handles', async () => {
    const root = new MockDirectoryHandle('')
    let fs = await openFs(root, { extentSize: 8192 })
    fs.writeFile('/a', '')
    const fda = fs.open('/a')
    for (let i = 0; i < 20; i++) {
      writeAt(fs, fda, seq(9000, i), i * 3000)
    }
    fs.close(fda)
    fs.mkdir('/d')
    fs.writeFile('/d/b', 'hello world')
    fs.unlink('/a')
    await fs.checkpointState()
    await fs.closeFs()

    fs = await openFs(root, { extentSize: 8192 })
    await fs.closeFs()

    expect(maxOpenHandles).toBe(2)
    expect(openHandles).toBe(0)
  })
})
