/**
 * 职责
 *   精调存档层（0.7.0）：把「面板/精调页保存的整份配置」写到
 *   `<dir>/config.json`，每次保存前把**上一份生效配置**复制到
 *   `<dir>/backups/<id>.json`，支持还原到某个备份或恢复默认。
 *
 * 依赖的 DSH 契约
 *   - `dir` 由 `index.js` 注入（`$DSH_HOME/storages/dsh-rice-guard`）；本模块
 *     不解析家目录、不读环境变量，单测直接给临时目录。
 *   - 配置结构由 `normalizeConfig` 定义；本模块永不信任磁盘内容，读进来一律再过
 *     一次 normalize（未知键丢弃、非法值回退、数字 clamp）。
 *
 * 关键决策与依据
 *   - **存档 = 整份规范化配置**，不是 diff：还原语义简单（一份文件回去就行），
 *     代价是 profile 里的同名配置会被存档覆盖——面板会明示「来源」并给
 *     「恢复默认（删档）」，这比维护逐字段 patch 的优先级规则更不容易出错。
 *   - 备份是「保存前快照」，不是操作日志：每次保存/还原/恢复默认都先备份当前
 *     生效配置；份数由 `storage.maxBackups` 控制（0=不备份）。
 *   - `storage.enabled=false` **不阻止精调存档本身写入**：否则「关掉落盘」这个
 *     动作无法持久，重启会自动开回来。它停统计 JSONL；自动备份目前仍会写，
 *     与 config-meta 的文案不一致，列为待定问题。
 *   - 存档自行递归创建目录，不依赖备份；写入用「临时文件 + rename」原子替换，避免半截 JSON。
 *
 * 已知边界
 *   - 没有跨进程文件锁；宿主单实例运行，面板写入不会并发（路由是单线程顺序处理）。
 *   - 备份 id 用本地时间 + 随机后缀；同一秒内多次保存由随机后缀保证唯一。
 *   - 不保留「谁改的」以外的人为审计信息（只有 source / note）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeConfig } from './config.js'

const ARCHIVE_VERSION = 1
const BACKUP_ID = /^\d{8}-\d{6}-[a-f0-9]{4}$/
const MAX_NOTE_CHARS = 200

/**
 * @param {object} options
 * @param {string} options.dir 数据根目录
 * @param {object} options.baseConfig profile 传入的配置（已规范化）
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @param {() => number} [options.now]
 */
export function createConfigStore(options = {}) {
  const dir = typeof options.dir === 'string' ? options.dir : ''
  const baseConfig = options.baseConfig && typeof options.baseConfig === 'object' ? options.baseConfig : normalizeConfig({})
  const logger = options.logger
  const now = typeof options.now === 'function' ? options.now : Date.now

  const archivePath = dir === '' ? '' : join(dir, 'config.json')
  const backupsDir = dir === '' ? '' : join(dir, 'backups')

  /** @type {object | null} 最近一次读/写成功的规范化配置 */
  let stored = null
  let savedAt = null
  /** 谁写入了当前存档（panel / tuning / restore）；对外只暴露 profile/store。 */
  let origin = 'profile'
  let lastNote = ''
  let error = null

  load()

  // ---------------------------------------------------------------- reading
  /** 从磁盘读存档；损坏/不存在都返回 null，并记 `error`。 */
  function load() {
    if (archivePath === '' || !existsSync(archivePath)) return null
    try {
      const payload = JSON.parse(readFileSync(archivePath, 'utf8'))
      const candidate = payload && typeof payload === 'object' && payload.config ? payload.config : payload
      stored = normalizeConfig(candidate)
      savedAt = Number.isFinite(payload && payload.savedAt) ? payload.savedAt : statSync(archivePath).mtimeMs
      origin = typeof (payload && payload.source) === 'string' && payload.source !== '' ? payload.source : 'store'
      lastNote = typeof (payload && payload.note) === 'string' ? payload.note : ''
      error = null
      return stored
    } catch (cause) {
      error = describe(cause)
      warn(`精调存档读取失败（${archivePath}）：${error}`)
      stored = null
      return null
    }
  }

  /** profile 配置 + 存档覆盖后的生效配置（永不为空）。 */
  function effective() {
    return normalizeConfig(mergeConfig(baseConfig, stored === null ? {} : stored))
  }

  /** 当前存档（null = 还没保存过）。 */
  function storedConfig() {
    return stored === null ? null : normalizeConfig(stored)
  }

  function status() {
    let bytes = 0
    let exists = false
    try {
      if (archivePath !== '' && existsSync(archivePath)) {
        exists = true
        bytes = statSync(archivePath).size
      }
    } catch {
      /* 读不到就是没有 */
    }
    return {
      dir,
      path: archivePath,
      exists,
      savedAt,
      source: stored === null ? 'profile' : 'store',
      origin,
      note: lastNote,
      bytes,
      error,
    }
  }

  // ---------------------------------------------------------------- writing
  /**
   * 保存一份配置补丁（或整份配置）。返回 `{ config, backupId, changed, error }`。
   * 写盘失败不回滚内存值：本次仍然生效，但 `error` 会告诉面板「重启会丢」。
   */
  function save(input, meta = {}) {
    const previous = effective()
    const next = normalizeConfig(mergeConfig(previous, input && typeof input === 'object' ? input : {}))
    const changed = diffPaths(previous, next)
    const note = clipNote(meta.note)
    const backupId = createBackup(previous, {
      source: 'before-save',
      note: note === '' ? '保存前快照' : note,
      limit: next.storage.maxBackups,
    })
    const writeError = writeArchive(next, {
      source: typeof meta.source === 'string' && meta.source !== '' ? meta.source : 'panel',
      note,
    })
    stored = next
    savedAt = now()
    origin = typeof meta.source === 'string' && meta.source !== '' ? meta.source : 'panel'
    lastNote = note
    if (writeError !== null) error = writeError
    return { config: next, backupId, changed, error: writeError }
  }

  /** 还原到指定备份；先给当前生效配置留一份备份。 */
  function restoreBackup(id) {
    if (typeof id !== 'string' || !BACKUP_ID.test(id)) {
      return { config: effective(), backupId: null, changed: [], error: 'invalid backup id' }
    }
    const file = join(backupsDir, `${id}.json`)
    let payload
    try {
      payload = JSON.parse(readFileSync(file, 'utf8'))
    } catch (cause) {
      error = describe(cause)
      return { config: effective(), backupId: null, changed: [], error: `无法读取备份 ${id}` }
    }
    const previous = effective()
    const next = normalizeConfig(payload && typeof payload === 'object' && payload.config ? payload.config : payload)
    const changed = diffPaths(previous, next)
    const backupId = createBackup(previous, {
      source: 'before-restore',
      note: `还原 ${id} 前快照`,
      limit: next.storage.maxBackups,
    })
    const writeError = writeArchive(next, { source: 'restore', note: `restored ${id}` })
    stored = next
    savedAt = now()
    origin = 'restore'
    lastNote = `restored ${id}`
    if (writeError !== null) error = writeError
    return { config: next, backupId, changed, error: writeError }
  }

  /** 删除存档，回到 profile 配置；先备份当前值。 */
  function resetDefaults() {
    const previous = effective()
    const backupId = createBackup(previous, {
      source: 'before-reset',
      note: '恢复默认前快照',
      limit: previous.storage.maxBackups,
    })
    let writeError = null
    try {
      if (archivePath !== '' && existsSync(archivePath)) rmSync(archivePath, { force: true })
    } catch (cause) {
      writeError = describe(cause)
    }
    stored = null
    savedAt = null
    origin = 'profile'
    lastNote = ''
    if (writeError !== null) error = writeError
    return { config: effective(), backupId, changed: diffPaths(previous, effective()), error: writeError }
  }

  /** 备份列表，按时间倒序；损坏文件跳过。 */
  function listBackups() {
    if (backupsDir === '' || !existsSync(backupsDir)) return []
    const rows = []
    let names
    try {
      names = readdirSync(backupsDir)
    } catch {
      return []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!BACKUP_ID.test(id)) continue
      const file = join(backupsDir, name)
      try {
        const payload = JSON.parse(readFileSync(file, 'utf8'))
        rows.push({
          id,
          at: Number.isFinite(payload && payload.savedAt) ? payload.savedAt : statSync(file).mtimeMs,
          bytes: statSync(file).size,
          source: typeof (payload && payload.source) === 'string' ? payload.source : 'unknown',
          note: typeof (payload && payload.note) === 'string' ? payload.note : '',
        })
      } catch {
        /* 坏备份不阻塞列表 */
      }
    }
    rows.sort((a, b) => b.at - a.at)
    return rows
  }

  function writeArchive(config, meta) {
    if (archivePath === '') return 'no store directory'
    try {
      const payload = {
        version: ARCHIVE_VERSION,
        savedAt: now(),
        source: meta.source,
        note: clipNote(meta.note),
        config,
      }
      mkdirSync(dir, { recursive: true })
      writeJsonAtomic(archivePath, payload)
      error = null
      return null
    } catch (cause) {
      const message = describe(cause)
      warn(`精调存档写入失败（${archivePath}）：${message}`)
      return message
    }
  }

  function createBackup(config, meta) {
    if (backupsDir === '' || meta.limit === 0) return null
    try {
      mkdirSync(backupsDir, { recursive: true })
      const id = makeBackupId(now())
      const payload = {
        version: ARCHIVE_VERSION,
        savedAt: now(),
        source: meta.source,
        note: clipNote(meta.note),
        config,
      }
      writeJsonAtomic(join(backupsDir, `${id}.json`), payload)
      pruneBackups(meta.limit)
      return id
    } catch (cause) {
      warn(`自动备份失败：${describe(cause)}`)
      return null
    }
  }

  function pruneBackups(limit) {
    const keep = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 20
    if (keep === 0) return
    const rows = listBackups()
    for (let index = keep; index < rows.length; index += 1) {
      try {
        rmSync(join(backupsDir, `${rows[index].id}.json`), { force: true })
      } catch {
        /* 删不掉就下次再删 */
      }
    }
  }

  function warn(message) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message)
    } catch {
      /* 日志失败不影响存档 */
    }
  }

  return {
    load,
    effective,
    storedConfig,
    save,
    restoreBackup,
    resetDefaults,
    listBackups,
    status,
  }
}

// ------------------------------------------------------------------ helpers

/** 写入临时文件再 rename，避免半截 JSON。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 备份 id：本地时间到秒 + 4 位随机后缀，便于人读、又不会同秒冲突。 */
function makeBackupId(ts) {
  const date = new Date(ts)
  const pad = (value) => (value < 10 ? `0${value}` : String(value))
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  let suffix = ''
  for (let index = 0; index < 4; index += 1) suffix += Math.floor(Math.random() * 16).toString(16)
  return `${stamp}-${suffix}`
}

/**
 * 深合并：对象递归、数组/标量整体替换、`null` 显式覆盖。
 * 只处理 plain object，跳 `__proto__` 防污染。
 */
export function mergeConfig(base, patch) {
  if (!isPlainObject(base)) return isPlainObject(patch) ? mergeConfig({}, patch) : {}
  if (!isPlainObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeConfig(out[key], value)
    else if (value !== undefined) out[key] = clone(value)
  }
  return out
}

/** 返回两份配置之间发生变化的叶子路径（稳定排序）。 */
export function diffPaths(before, after) {
  const left = flattenPaths(before)
  const right = flattenPaths(after)
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  const changed = []
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) changed.push(key)
  }
  return changed.sort()
}

/** 把配置展开成 `path -> 叶子值`；对象本身不进入结果。 */
export function flattenPaths(value, prefix = '', out = {}) {
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    if (prefix !== '') out[prefix] = value
    return out
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (isPlainObject(child)) flattenPaths(child, path, out)
    else out[path] = child
  }
  return out
}

export function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const left = Object.keys(a)
    const right = Object.keys(b)
    if (left.length !== right.length) return false
    return left.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value)) out[key] = clone(value[key])
    return out
  }
  return value
}

function clipNote(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_NOTE_CHARS)
}

function describe(error) {
  if (error instanceof Error) return error.message || String(error)
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
