import { BaseFilesystem, ERRNO_CODES, type FsStats } from './base.js'
import type { PostgresMod } from '../postgresMod.js'
import type { PGlite } from '../pglite.js'
import type { FileSystemSyncAccessHandle } from './opfs-ahp.js'

export interface OpfsPackedOptions {
  extentSize?: number
  debug?: boolean
}

// State

const STATE_FILE = 'state.txt'
const DATA_FILE = 'data.bin'
const DEFAULT_EXTENT_SIZE = 65536
// Postgres block size - extents must be a multiple of this
const PG_BLOCK_SIZE = 8192
const INITIAL_MODE = {
  DIR: 16384,
  FILE: 32768,
}

export interface PackedState {
  extentSize: number
  totalExtents: number
  freeExtents: number[]
  root: DirectoryNode
}

// WAL

export interface WALEntry {
  opp: string
  args: any[]
}

// Node tree

export type NodeType = 'file' | 'directory'

interface BaseNode {
  type: NodeType
  lastModified: number
  mode: number
}

export interface FileNode extends BaseNode {
  type: 'file'
  size: number
  extents: number[]
}

export interface DirectoryNode extends BaseNode {
  type: 'directory'
  children: { [filename: string]: Node }
}

export type Node = FileNode | DirectoryNode

/**
 * PGlite OPFS packed extent filesystem.
 * Stores all virtual files as fixed-size extents inside a single OPFS data
 * file, using exactly two sync access handles (state and data). This avoids
 * the per-file sync access handle used by the OPFS AHP FS, which exceeds
 * WebKit's ~252 open handle limit for a standard Postgres data dir.
 */
export class OpfsPackedFS extends BaseFilesystem {
  declare readonly dataDir: string

  #extentSize: number

  #opfsRootAh!: FileSystemDirectoryHandle
  #rootAh!: FileSystemDirectoryHandle

  #stateFH!: FileSystemFileHandle
  #stateSH!: FileSystemSyncAccessHandle
  #dataFH!: FileSystemFileHandle
  #dataSH!: FileSystemSyncAccessHandle

  #handleIdCounter = 0
  #openHandlePaths: Map<number, string> = new Map()
  #openHandleIds: Map<string, number> = new Map()

  state!: PackedState
  lastCheckpoint = 0
  checkpointInterval = 1000 * 60 // 1 minute

  // One preallocated zero buffer reused to zero extents on allocation
  #zeroExtent!: Uint8Array

  #dirty = new Set<FileSystemSyncAccessHandle>()

  constructor(
    dataDir: string,
    { extentSize = DEFAULT_EXTENT_SIZE, debug = false }: OpfsPackedOptions = {},
  ) {
    super(dataDir, { debug })
    if (
      !Number.isInteger(extentSize) ||
      extentSize <= 0 ||
      extentSize % PG_BLOCK_SIZE !== 0
    ) {
      throw new Error(
        `Invalid extentSize ${extentSize}, must be a positive multiple of ${PG_BLOCK_SIZE}`,
      )
    }
    this.#extentSize = extentSize
  }

  async init(pg: PGlite, opts: Partial<PostgresMod>) {
    await this.#init()
    return super.init(pg, opts)
  }

  async syncToFs(relaxedDurability = false) {
    await this.maybeCheckpointState()
    if (!relaxedDurability) {
      this.flush()
    }
  }

  async closeFs(): Promise<void> {
    this.#stateSH.flush()
    this.#dataSH.flush()
    this.#stateSH.close()
    this.#dataSH.close()
    this.pg!.Module.FS.quit()
  }

  async #init() {
    this.#opfsRootAh = await navigator.storage.getDirectory()
    this.#rootAh = await this.#resolveOpfsDirectory(this.dataDir!, {
      create: true,
    })

    this.#stateFH = await this.#rootAh.getFileHandle(STATE_FILE, {
      create: true,
    })
    this.#stateSH = await (this.#stateFH as any).createSyncAccessHandle()

    const stateAB = new ArrayBuffer(this.#stateSH.getSize())
    this.#stateSH.read(stateAB, { at: 0 })
    let state: PackedState
    const stateLines = new TextDecoder().decode(stateAB).split('\n')
    // Line 1 is a base state object.
    // Lines 1+n are WAL entries.

    try {
      state = JSON.parse(stateLines[0])
    } catch (e) {
      state = {
        extentSize: this.#extentSize,
        totalExtents: 0,
        freeExtents: [],
        root: {
          type: 'directory',
          lastModified: Date.now(),
          mode: INITIAL_MODE.DIR,
          children: {},
        },
      }
      // write new state to file
      this.#stateSH.truncate(0)
      this.#stateSH.write(new TextEncoder().encode(JSON.stringify(state)), {
        at: 0,
      })
    }
    this.state = state
    // An existing state's extentSize is authoritative - it was frozen at creation
    this.#extentSize = state.extentSize
    this.#zeroExtent = new Uint8Array(this.#extentSize)

    // Apply WAL entries
    const wal = stateLines
      .slice(1)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    for (const entry of wal) {
      const methodName = `_${entry.opp}State`
      if (typeof this[methodName as keyof this] === 'function') {
        try {
          const method = this[methodName as keyof this] as any
          method.bind(this)(...entry.args)
        } catch (e) {
          console.warn('Error applying OPFS packed WAL entry', entry, e)
        }
      }
    }

    // Open the single data file
    this.#dataFH = await this.#rootAh.getFileHandle(DATA_FILE, {
      create: true,
    })
    this.#dataSH = await (this.#dataFH as any).createSyncAccessHandle()
    const expectedSize = this.state.totalExtents * this.#extentSize
    if (this.#dataSH.getSize() < expectedSize) {
      // Recover from a crash between a WAL append and the data file growth
      this.#dataSH.truncate(expectedSize)
    }
  }

  async maybeCheckpointState() {
    if (Date.now() - this.lastCheckpoint > this.checkpointInterval) {
      await this.checkpointState()
    }
  }

  async checkpointState() {
    // Tail-trim compaction: drop free extents at the end of the data file
    let trimmed = false
    while (
      this.state.totalExtents > 0 &&
      this.state.freeExtents.includes(this.state.totalExtents - 1)
    ) {
      const index = this.state.freeExtents.indexOf(this.state.totalExtents - 1)
      this.state.freeExtents.splice(index, 1)
      this.state.totalExtents--
      trimmed = true
    }
    if (trimmed) {
      this.#dataSH.truncate(this.state.totalExtents * this.#extentSize)
    }

    const stateAB = new TextEncoder().encode(JSON.stringify(this.state))
    this.#stateSH.truncate(0)
    this.#stateSH.write(stateAB, { at: 0 })
    this.#stateSH.flush()
    this.lastCheckpoint = Date.now()
  }

  flush() {
    for (const sh of this.#dirty) {
      try {
        sh.flush()
      } catch (e) {
        // The file may have been closed if it was deleted
      }
    }
    this.#dirty.clear()
  }

  // Filesystem API:

  chmod(path: string, mode: number): void {
    this.#tryWithWAL({ opp: 'chmod', args: [path, mode] }, () => {
      this._chmodState(path, mode)
    })
  }

  _chmodState(path: string, mode: number): void {
    const node = this.#resolvePath(path)
    node.mode = mode
  }

  close(fd: number): void {
    const path = this.#getPathFromFd(fd)
    this.#openHandlePaths.delete(fd)
    this.#openHandleIds.delete(path)
  }

  fstat(fd: number): FsStats {
    const path = this.#getPathFromFd(fd)
    return this.lstat(path)
  }

  lstat(path: string): FsStats {
    const node = this.#resolvePath(path)
    const size = node.type === 'file' ? node.size : 0
    const blksize = 4096
    return {
      dev: 0,
      ino: 0,
      mode: node.mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      blksize,
      blocks: Math.ceil(size / blksize),
      atime: node.lastModified,
      mtime: node.lastModified,
      ctime: node.lastModified,
    }
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    this.#tryWithWAL({ opp: 'mkdir', args: [path, options] }, () => {
      this._mkdirState(path, options)
    })
  }

  _mkdirState(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): void {
    const parts = this.#pathParts(path)
    const newDirName = parts.pop()!
    const currentPath: string[] = []
    let node = this.state.root
    for (const part of parts) {
      currentPath.push(path)
      if (!Object.prototype.hasOwnProperty.call(node.children, part)) {
        if (options?.recursive) {
          this.mkdir(currentPath.join('/'))
        } else {
          throw new FsError('ENOENT', 'No such file or directory')
        }
      }
      if (node.children[part].type !== 'directory') {
        throw new FsError('ENOTDIR', 'Not a directory')
      }
      node = node.children[part] as DirectoryNode
    }
    if (Object.prototype.hasOwnProperty.call(node.children, newDirName)) {
      throw new FsError('EEXIST', 'File exists')
    }
    const newDir: DirectoryNode = {
      type: 'directory',
      lastModified: Date.now(),
      mode: options?.mode || INITIAL_MODE.DIR,
      children: {},
    }
    node.children[newDirName] = newDir
  }

  open(path: string, _flags?: string, _mode?: number): number {
    const node = this.#resolvePath(path)
    if (node.type !== 'file') {
      throw new FsError('EISDIR', 'Is a directory')
    }
    const handleId = this.#nextHandleId()
    this.#openHandlePaths.set(handleId, path)
    this.#openHandleIds.set(path, handleId)
    return handleId
  }

  readdir(path: string): string[] {
    const node = this.#resolvePath(path)
    if (node.type !== 'directory') {
      throw new FsError('ENOTDIR', 'Not a directory')
    }
    return Object.keys(node.children)
  }

  read(
    fd: number,
    buffer: Uint8Array, // Buffer to read into
    offset: number, // Offset in buffer to start writing to
    length: number, // Number of bytes to read
    position: number, // Position in file to read from
  ): number {
    const path = this.#getPathFromFd(fd)
    const node = this.#resolvePath(path)
    if (node.type !== 'file') {
      throw new FsError('EISDIR', 'Is a directory')
    }
    if (position >= node.size) {
      return 0
    }
    const toRead = Math.min(length, node.size - position)
    const dst = new Uint8Array(buffer.buffer, offset, toRead)
    let done = 0
    while (done < toRead) {
      const pos = position + done
      const extentIndex = Math.floor(pos / this.#extentSize)
      const within = pos % this.#extentSize
      const chunk = Math.min(this.#extentSize - within, toRead - done)
      this.#dataSH.read(dst.subarray(done, done + chunk), {
        at: node.extents[extentIndex] * this.#extentSize + within,
      })
      done += chunk
    }
    return done
  }

  rename(oldPath: string, newPath: string): void {
    this.#tryWithWAL({ opp: 'rename', args: [oldPath, newPath] }, () => {
      this._renameState(oldPath, newPath)
    })
  }

  _renameState(oldPath: string, newPath: string): void {
    const oldPathParts = this.#pathParts(oldPath)
    const oldFilename = oldPathParts.pop()!
    const oldParent = this.#resolvePath(oldPathParts.join('/')) as DirectoryNode
    if (
      !Object.prototype.hasOwnProperty.call(oldParent.children, oldFilename)
    ) {
      throw new FsError('ENOENT', 'No such file or directory')
    }
    const newPathParts = this.#pathParts(newPath)
    const newFilename = newPathParts.pop()!
    const newParent = this.#resolvePath(newPathParts.join('/')) as DirectoryNode
    if (Object.prototype.hasOwnProperty.call(newParent.children, newFilename)) {
      // Overwrite, so return the target file's extents to the free list
      const node = newParent.children[newFilename]!
      if (node.type === 'file') {
        for (const ext of node.extents) {
          this.state.freeExtents.push(ext)
        }
      }
    }
    newParent.children[newFilename] = oldParent.children[oldFilename]!
    delete oldParent.children[oldFilename]
  }

  rmdir(path: string): void {
    this.#tryWithWAL({ opp: 'rmdir', args: [path] }, () => {
      this._rmdirState(path)
    })
  }

  _rmdirState(path: string): void {
    const pathParts = this.#pathParts(path)
    const dirName = pathParts.pop()!
    const parent = this.#resolvePath(pathParts.join('/')) as DirectoryNode
    if (!Object.prototype.hasOwnProperty.call(parent.children, dirName)) {
      throw new FsError('ENOENT', 'No such file or directory')
    }
    const node = parent.children[dirName]!
    if (node.type !== 'directory') {
      throw new FsError('ENOTDIR', 'Not a directory')
    }
    if (Object.keys(node.children).length > 0) {
      throw new FsError('ENOTEMPTY', 'Directory not empty')
    }
    delete parent.children[dirName]
  }

  truncate(path: string, len = 0): void {
    const node = this.#resolvePath(path)
    if (node.type !== 'file') {
      throw new FsError('EISDIR', 'Is a directory')
    }
    this.#tryWithWAL({ opp: 'truncate', args: [path, len] }, () => {
      this._truncateState(path, len, true)
    })
    this.#dirty.add(this.#dataSH)
  }

  _truncateState(path: string, len: number, doFileOps = false): void {
    const node = this.#resolvePath(path) as FileNode
    const oldSize = node.size
    const newCount = Math.ceil(len / this.#extentSize)
    const oldCount = node.extents.length
    if (newCount < oldCount) {
      const freed = node.extents.splice(newCount)
      for (const ext of freed) {
        this.state.freeExtents.push(ext)
      }
    } else if (newCount > oldCount) {
      const needed = newCount - oldCount
      const { newExtents, grownTotalExtents } = this.#planExtents(needed)
      if (doFileOps) {
        this.#allocFileOps(newExtents, grownTotalExtents)
      }
      this.#applyAllocState(node, newExtents, grownTotalExtents)
    }
    // Zero the tail of the boundary extent so re-extension reads zeros (POSIX)
    if (doFileOps && len < oldSize && len % this.#extentSize !== 0) {
      const within = len % this.#extentSize
      const boundaryExtent = node.extents[Math.floor(len / this.#extentSize)]
      this.#dataSH.write(
        this.#zeroExtent.subarray(0, this.#extentSize - within),
        {
          at: boundaryExtent * this.#extentSize + within,
        },
      )
    }
    node.size = len
  }

  unlink(path: string): void {
    this.#tryWithWAL({ opp: 'unlink', args: [path] }, () => {
      this._unlinkState(path, true)
    })
  }

  _unlinkState(path: string, doFileOps = false): void {
    const pathParts = this.#pathParts(path)
    const filename = pathParts.pop()!
    const dir = this.#resolvePath(pathParts.join('/')) as DirectoryNode
    if (!Object.prototype.hasOwnProperty.call(dir.children, filename)) {
      throw new FsError('ENOENT', 'No such file or directory')
    }
    const node = dir.children[filename]!
    if (node.type !== 'file') {
      throw new FsError('EISDIR', 'Is a directory')
    }
    delete dir.children[filename]
    for (const ext of node.extents) {
      this.state.freeExtents.push(ext)
    }
    if (doFileOps) {
      if (this.#openHandleIds.has(path)) {
        this.#openHandlePaths.delete(this.#openHandleIds.get(path)!)
        this.#openHandleIds.delete(path)
      }
    }
  }

  utimes(path: string, atime: number, mtime: number): void {
    this.#tryWithWAL({ opp: 'utimes', args: [path, atime, mtime] }, () => {
      this._utimesState(path, atime, mtime)
    })
  }

  _utimesState(path: string, _atime: number, mtime: number): void {
    const node = this.#resolvePath(path)
    node.lastModified = mtime
  }

  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: string; mode?: number; flag?: string },
  ): void {
    const pathParts = this.#pathParts(path)
    const filename = pathParts.pop()!
    const parent = this.#resolvePath(pathParts.join('/')) as DirectoryNode

    if (!Object.prototype.hasOwnProperty.call(parent.children, filename)) {
      const node: FileNode = {
        type: 'file',
        lastModified: Date.now(),
        mode: options?.mode || INITIAL_MODE.FILE,
        size: 0,
        extents: [],
      }
      this.#logWAL({
        opp: 'createFileNode',
        args: [path, node],
      })
      this._createFileNodeState(path, node)
    } else {
      const node = parent.children[filename] as FileNode
      node.lastModified = Date.now()
      this.#logWAL({
        opp: 'setLastModified',
        args: [path, node.lastModified],
      })
    }
    const node = parent.children[filename] as FileNode
    const bytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data)
    if (bytes.length > 0) {
      this.#ensureCapacity(path, node, bytes.length)
      this.#writeExtents(node, bytes, 0)
      if (path.startsWith('/pg_wal')) {
        this.#dirty.add(this.#dataSH)
      }
    }
  }

  _createFileNodeState(path: string, node: FileNode): FileNode {
    const pathParts = this.#pathParts(path)
    const filename = pathParts.pop()!
    const parent = this.#resolvePath(pathParts.join('/')) as DirectoryNode
    parent.children[filename] = node
    return node
  }

  _setLastModifiedState(path: string, lastModified: number): void {
    const node = this.#resolvePath(path)
    node.lastModified = lastModified
  }

  _extendFileState(
    path: string,
    newExtents: number[],
    grownTotalExtents: number,
    size: number,
  ): void {
    const node = this.#resolvePath(path) as FileNode
    this.#applyAllocState(node, newExtents, grownTotalExtents)
    node.size = size
  }

  _setSizeState(path: string, size: number): void {
    const node = this.#resolvePath(path) as FileNode
    node.size = size
  }

  write(
    fd: number,
    buffer: Uint8Array, // Buffer to read from
    offset: number, // Offset in buffer to start reading from
    length: number, // Number of bytes to write
    position: number, // Position in file to write to
  ): number {
    const path = this.#getPathFromFd(fd)
    const node = this.#resolvePath(path)
    if (node.type !== 'file') {
      throw new FsError('EISDIR', 'Is a directory')
    }
    this.#ensureCapacity(path, node, position + length)
    const src = new Uint8Array(buffer, offset, length)
    this.#writeExtents(node, src, position)
    if (path.startsWith('/pg_wal')) {
      this.#dirty.add(this.#dataSH)
    }
    return length
  }

  // Internal methods:

  // Grow a file so [0, end) is backed by extents, logging the allocation (or a
  // bare size change) so replay is exact - allocation is never re-run on replay.
  #ensureCapacity(path: string, node: FileNode, end: number): void {
    const capacity = node.extents.length * this.#extentSize
    if (end > capacity) {
      const needed = Math.ceil(end / this.#extentSize) - node.extents.length
      const { newExtents, grownTotalExtents } = this.#planExtents(needed)
      this.#allocFileOps(newExtents, grownTotalExtents)
      this.#logWAL({
        opp: 'extendFile',
        args: [path, newExtents, grownTotalExtents, end],
      })
      this._extendFileState(path, newExtents, grownTotalExtents, end)
    } else if (end > node.size) {
      this.#logWAL({ opp: 'setSize', args: [path, end] })
      this._setSizeState(path, end)
    }
  }

  // Decide which extents to allocate without mutating state, so the live path
  // can record the result in the WAL before applying it.
  #planExtents(count: number): {
    newExtents: number[]
    grownTotalExtents: number
  } {
    const free = [...this.state.freeExtents]
    let total = this.state.totalExtents
    const newExtents: number[] = []
    for (let i = 0; i < count; i++) {
      if (free.length > 0) {
        newExtents.push(free.pop()!)
      } else {
        newExtents.push(total)
        total++
      }
    }
    return { newExtents, grownTotalExtents: total }
  }

  // Zero reused extents and truncate-grow the data file to cover new extents.
  // Reused extents are zeroed on allocation (not on free) so holes read zeros.
  #allocFileOps(newExtents: number[], grownTotalExtents: number): void {
    const origTotal = this.state.totalExtents
    for (const ext of newExtents) {
      if (ext < origTotal) {
        this.#dataSH.write(this.#zeroExtent, { at: ext * this.#extentSize })
      }
    }
    if (grownTotalExtents > origTotal) {
      this.#dataSH.truncate(grownTotalExtents * this.#extentSize)
    }
  }

  #applyAllocState(
    node: FileNode,
    newExtents: number[],
    grownTotalExtents: number,
  ): void {
    for (const ext of newExtents) {
      const index = this.state.freeExtents.indexOf(ext)
      if (index > -1) {
        this.state.freeExtents.splice(index, 1)
      }
    }
    this.state.totalExtents = grownTotalExtents
    node.extents.push(...newExtents)
  }

  #writeExtents(node: FileNode, src: Uint8Array, position: number): void {
    const length = src.length
    let done = 0
    while (done < length) {
      const pos = position + done
      const extentIndex = Math.floor(pos / this.#extentSize)
      const within = pos % this.#extentSize
      const chunk = Math.min(this.#extentSize - within, length - done)
      this.#dataSH.write(src.subarray(done, done + chunk), {
        at: node.extents[extentIndex] * this.#extentSize + within,
      })
      done += chunk
    }
  }

  #tryWithWAL(entry: WALEntry, fn: () => void) {
    const offset = this.#logWAL(entry)
    try {
      fn()
    } catch (e) {
      // Rollback WAL entry
      this.#stateSH.truncate(offset)
      throw e
    }
  }

  #logWAL(entry: WALEntry) {
    const entryJSON = JSON.stringify(entry)
    const stateAB = new TextEncoder().encode(`\n${entryJSON}`)
    const offset = this.#stateSH.getSize()
    this.#stateSH.write(stateAB, { at: offset })
    this.#dirty.add(this.#stateSH)
    return offset
  }

  #pathParts(path: string): string[] {
    return path.split('/').filter(Boolean)
  }

  #resolvePath(path: string, from?: DirectoryNode): Node {
    const parts = this.#pathParts(path)
    let node: Node = from || this.state.root
    for (const part of parts) {
      if (node.type !== 'directory') {
        throw new FsError('ENOTDIR', 'Not a directory')
      }
      if (!Object.prototype.hasOwnProperty.call(node.children, part)) {
        throw new FsError('ENOENT', 'No such file or directory')
      }
      node = node.children[part]!
    }
    return node
  }

  #getPathFromFd(fd: number): string {
    const path = this.#openHandlePaths.get(fd)
    if (!path) {
      throw new FsError('EBADF', 'Bad file descriptor')
    }
    return path
  }

  #nextHandleId(): number {
    const id = ++this.#handleIdCounter
    while (this.#openHandlePaths.has(id)) {
      this.#handleIdCounter++
    }
    return id
  }

  async #resolveOpfsDirectory(
    path: string,
    options?: {
      from?: FileSystemDirectoryHandle
      create?: boolean
    },
  ): Promise<FileSystemDirectoryHandle> {
    const parts = this.#pathParts(path)
    let ah = options?.from || this.#opfsRootAh
    for (const part of parts) {
      ah = await ah.getDirectoryHandle(part, { create: options?.create })
    }
    return ah
  }
}

class FsError extends Error {
  code?: number
  constructor(code: number | keyof typeof ERRNO_CODES | null, message: string) {
    super(message)
    if (typeof code === 'number') {
      this.code = code
    } else if (typeof code === 'string') {
      this.code = ERRNO_CODES[code]
    }
  }
}
