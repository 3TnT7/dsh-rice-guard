/**
 * 职责
 *   统计持久层：两条记录通道，同一个按月 JSONL、同一套日/会话索引。
 *   - **assemble 通道**（0.7.0）：每次 `system-prompt/assemble` 的收益增量；
 *   - **usage 通道**（0.8.0）：每次 `assistant/message` 的 provider 实测用量，
 *     用来回答「前缀缓存实际命中多少」——这是估算口径无法证明的事。
 *   本模块只回答数字，不碰投影、不碰 ctx、不注册任何东西。
 *
 * 依赖的 DSH 契约
 *   - 由 `index.js` 注入 `dir`（`$DSH_HOME/storages/dsh-rice-guard`），本模块
 *     不解析家目录、不读环境变量，单测可直接给临时目录。
 *   - 记录内容只来自两个回调：`records.record()`（assemble 估算）与
 *     `recordUsage()`（provider 实报用量）；**不含任何 prompt / tool 内容**。
 *
 * 关键决策与依据
 *   - **JSONL 追加写是唯一事实源**，内存索引只做读缓存：启动时扫最近两个月重建，
 *     重启不丢数；写失败（只读盘/沙箱）只置 `error`，不影响投影主链路。
 *   - 两种行用 `k` 区分（`'a'` = assemble、`'u'` = usage）；旧行没有 `k`，按
 *     assemble 处理，所以 0.7.x 的日志能直接接着读。`v` 接受 1 与 2。
 *   - **usage 行只记数字**：input/cacheRead/output/cacheWrite/reasoning，外加两个
 *     布尔标记（`first` = 本会话首条、`paired` = 配到了一次紧邻的 assemble）。
 *   - 每条记录一个文件句柄、同步 write（约 0.1ms），不开 fsync：进程被杀
 *     （`self_restart`）时数据已交给 OS，仍会落盘；真正的掉电级一致性不在本插件
 *     的责任范围（它不是账本）。
 *   - 按**本地时区自然日**切，不写死时区；`timezone()` 只用于面板文案。
 *   - 内存只保留 62 天（`KEEP_DAYS`），够 30 天窗口 + 跨月边界；更早的月份文件
 *     原样留在磁盘（老板要求「更早的也保存 log」）。
 *   - 会话数上限 2000（按 lastAt 淘汰），防止长期运行被大量一次性子代理撑爆。
 *
 * 已知边界
 *   - assemble 通道是「估算口径」：token = floor(bytes/4)，且**只统计 tools 投影**
 *     （`bytesBefore = jsonLength(assembled.tools)`），不是整份 prompt；金额由面板
 *     用当前价表折算，历史记录不保存时点价格。
 *   - usage 通道的 `first` 标记依赖进程内记忆：重启后每个活跃会话的第一条会被
 *     再标一次「首条」，稳态命中率因此少算一条（偏保守，不会虚高）。
 *   - 同一进程内切换存档目录不支持：目录在 `configure` 首次调用后固定。
 *   - 文件损坏行只计数并跳过，不做自动修复。
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** 内存保留天数：30 天窗口 + 一个月的边界余量。 */
const KEEP_DAYS = 62
/** 会话索引上限；超出按 lastAt 淘汰。 */
const MAX_SESSIONS = 2000
/** 面板「按对话」最多返回多少条。 */
const MAX_CONVERSATIONS = 200
/** 记录格式版本，将来改字段时用来兼容旧行。 */
const RECORD_VERSION = 2
/** assemble 与 usage 的最大配对间隔。 */
const PAIR_WINDOW = 10 * 60 * 1000

/** 窗口定义；顺序就是前端切换条的顺序。 */
export const WINDOWS = Object.freeze({
  today: Object.freeze({ label: '今天', days: 1 }),
  d7: Object.freeze({ label: '最近 7 天', days: 7 }),
  d30: Object.freeze({ label: '最近 30 天', days: 30 }),
})

/** 合法窗口 id 集合，路由用它做白名单。 */
export const WINDOW_IDS = Object.freeze(Object.keys(WINDOWS))

/**
 * @param {object} [options]
 * @param {string} options.dir 数据根目录（stats/ 子目录）
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @param {() => number} [options.now] 注入时钟（测试用）
 */
export function createStatsStore(options = {}) {
  const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : ''
  const logger = options.logger
  const now = typeof options.now === 'function' ? options.now : Date.now

  /** @type {Map<string, object>} 本地日 -> 聚合 */
  const days = new Map()
  /** @type {Map<string, { id: string, firstAt: number, lastAt: number, days: Map<string, object> }>} */
  const sessions = new Map()
  /** 实测通道单独的日桶与会话桶。 */
  const usageDays = new Map()
  const usageSessions = new Map()
  const firstUsage = new Set()
  const pendingAssembles = new Map()

  let enabled = true
  let loaded = false
  let error = null
  let recordsLoaded = 0
  let usageRecords = 0
  let corruptLines = 0
  let fd = null
  let fdMonth = null
  let lastPruneDay = ''

  // ------------------------------------------------------------- lifecycle
  /**
   * 应用当前配置。目录固定（由 index.js 传入）；只切换「是否写盘」。
   * 幂等：每次保存配置都会调用。
   */
  function configure(config) {
    const storage = config && typeof config === 'object' ? config.storage : undefined
    enabled = !(storage && storage.enabled === false)
    if (!loaded) load()
    if (!enabled) closeFd()
  }

  /** 启动时重建索引；失败只降级为「从零开始」，不抛。 */
  function load() {
    if (loaded) return
    loaded = true
    const at = now()
    for (const month of loadMonths(at)) {
      const file = join(dir, 'stats', `${month}.jsonl`)
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line === '') continue
        try {
          const record = JSON.parse(line)
          const ts = record && record.ts
          if (![1, RECORD_VERSION].includes(record.v) || typeof ts !== 'number' || !Number.isFinite(ts) || (record.k !== undefined && record.k !== 'a' && record.k !== 'u')) {
            corruptLines += 1
            continue
          }
          if (record.k === 'u') {
            addUsage(record)
            usageRecords += 1
          } else {
            const aggregate = aggregateOf(record)
            addInto(dayBucket(ts), aggregate)
            if (typeof record.sid === 'string' && record.sid !== '') addSession(ts, record.sid, aggregate)
            recordsLoaded += 1
          }
        } catch {
          corruptLines += 1
        }
      }
    }
    prune(at, true)
    if (corruptLines > 0) {
      warn(`统计日志有 ${corruptLines} 行损坏，已跳过（不影响新记录）`)
    }
  }

  // ---------------------------------------------------------------- record
  /**
   * 记一次 assemble。同步、永不抛；写盘失败只记录错误。
   * @param {{ sessionId?: string, processed?: boolean|number, failed?: number,
   *   bytesBefore?: number, bytesAfter?: number, bytesSaved?: number, tokensSaved?: number,
   *   shadowed?: number, hidden?: number, enumsKept?: number, itemsKept?: number,
   *   oversizeSlims?: number }} input
   */
  function record(input) {
    try {
      const source = input && typeof input === 'object' ? input : {}
      const ts = Number.isFinite(source.ts) ? source.ts : now()
      const sessionId = typeof source.sessionId === 'string' && source.sessionId !== '' ? source.sessionId : null
      const aggregate = aggregateOf({ ...source, processed: source.processed ? 1 : 0 })
      addInto(dayBucket(ts), aggregate)
      if (sessionId !== null) {
        addSession(ts, sessionId, aggregate)
        if (aggregate.tokensBefore > 0) {
          pendingAssembles.set(sessionId, { at: ts, tokensBefore: aggregate.tokensBefore })
        } else {
          // 没有工具估算就不可比，同时清掉更早步骤留下的待配对记录。
          pendingAssembles.delete(sessionId)
        }
      }
      prune(ts)
      if (!enabled || dir === '') return
      appendLine({
        v: RECORD_VERSION,
        k: 'a',
        ts,
        sid: sessionId,
        processed: aggregate.calls,
        bytesBefore: aggregate.bytesBefore,
        bytesAfter: aggregate.bytesAfter,
        bytesSaved: aggregate.bytesSaved,
        tokensBefore: aggregate.tokensBefore,
        tokensAfter: aggregate.tokensAfter,
        tokensSaved: aggregate.tokensSaved,
        shadowed: aggregate.shadowed,
        hidden: aggregate.hidden,
        enumsKept: aggregate.enumsKept,
        itemsKept: aggregate.itemsKept,
        oversizeSlims: aggregate.oversizeSlims,
        failed: aggregate.failed,
      })
    } catch (cause) {
      // 统计是旁路：任何失败都不能冒泡到 assemble。
      error = describe(cause)
    }
  }

  /** 记录 provider 实测用量；与投影主链路隔离，任何异常都不外抛。 */
  function recordUsage(input) {
    try {
      const source = input && typeof input === 'object' ? input : {}
      const usage = source.usage && typeof source.usage === 'object' ? source.usage : {}
      const values = {
        input: positiveInt(usage.inputTokens), output: positiveInt(usage.outputTokens),
        cacheRead: positiveInt(usage.cacheReadTokens), cacheWrite: positiveInt(usage.cacheWriteTokens),
        reasoning: positiveInt(usage.reasoningTokens),
      }
      if (values.input + values.output + values.cacheRead === 0) return
      const ts = Number.isFinite(source.ts) ? source.ts : now()
      const sid = typeof source.sessionId === 'string' && source.sessionId !== '' ? source.sessionId : null
      const pending = pendingAssembles.get(sid)
      // 取用即删除，过期或时序倒置也不能留给后续消息误配。
      pendingAssembles.delete(sid)
      const paired = pending !== undefined && ts >= pending.at && ts - pending.at <= PAIR_WINDOW ? 1 : 0
      const first = sid !== null && !firstUsage.has(sid) ? 1 : 0
      if (sid !== null) firstUsage.add(sid)
      const line = { v: RECORD_VERSION, k: 'u', ts, sid, ...values, first, paired,
        estTokens: paired ? pending.tokensBefore : 0 }
      addUsage(line)
      prune(ts)
      if (enabled && dir !== '') appendLine(line)
    } catch (cause) {
      error = describe(cause)
    }
  }

  /** 写入实测通道的两层内存索引，加载日志也走同一条路径。 */
  function addUsage(line) {
    const aggregate = usageAggregateOf(line)
    const key = dayKey(line.ts)
    if (!usageDays.has(key)) usageDays.set(key, emptyUsageAggregate())
    addInto(usageDays.get(key), aggregate)
    if (typeof line.sid !== 'string' || line.sid === '') return
    // 复用会话元数据；空估算增量不增加 assemble 次数。
    addSession(line.ts, line.sid, emptyAggregate())
    if (!usageSessions.has(line.sid)) usageSessions.set(line.sid, new Map())
    const buckets = usageSessions.get(line.sid)
    if (!buckets.has(key)) buckets.set(key, emptyUsageAggregate())
    addInto(buckets.get(key), aggregate)
  }

  function usageTotals(buckets, startKey) {
    const totals = emptyUsageAggregate()
    if (buckets) for (const [key, aggregate] of buckets) {
      if (key >= startKey) addInto(totals, aggregate)
    }
    return totals
  }

  // --------------------------------------------------------------- reading
  /**
   * 聚合一个窗口。`at` 可注入，便于测试与跨日边界。
   * @param {'today'|'d7'|'d30'} windowId
   * @param {number} [at]
   */
  function summary(windowId, at) {
    const window = WINDOWS[windowId] || WINDOWS.today
    const atTs = Number.isFinite(at) ? at : now()
    const start = startOfWindow(atTs, window.days)
    const startKey = dayKey(start)
    const totals = emptyAggregate()
    for (const [key, aggregate] of days) {
      if (key >= startKey) addInto(totals, aggregate)
    }
    return {
      label: window.label,
      days: window.days,
      start: start.getTime(),
      assembleRequests: totals.requests,
      assembleCalls: totals.calls,
      bytesBefore: totals.bytesBefore,
      bytesAfter: totals.bytesAfter,
      bytesSaved: totals.bytesSaved,
      tokensBefore: totals.tokensBefore,
      tokensAfter: totals.tokensAfter,
      tokensSaved: totals.tokensSaved,
      shadowed: totals.shadowed,
      hidden: totals.hidden,
      enumsKept: totals.enumsKept,
      itemsKept: totals.itemsKept,
      oversizeSlims: totals.oversizeSlims,
      failed: totals.failed,
      sessions: sessionsIn(startKey),
      usage: usageView(usageTotals(usageDays, startKey)),
    }
  }

  /**
   * 窗口内的按会话聚合，按最后活动倒序。
   * @param {'today'|'d7'|'d30'} windowId
   * @param {number} [at]
   */
  function conversations(windowId, at) {
    const window = WINDOWS[windowId] || WINDOWS.today
    const atTs = Number.isFinite(at) ? at : now()
    const startKey = dayKey(startOfWindow(atTs, window.days))
    const rows = []
    for (const session of sessions.values()) {
      const totals = emptyAggregate()
      let touched = false
      for (const [key, aggregate] of session.days) {
        if (key < startKey) continue
        touched = true
        addInto(totals, aggregate)
      }
      const measured = usageView(usageTotals(usageSessions.get(session.id), startKey))
      if (!touched || (totals.requests === 0 && measured.calls === 0)) continue
      rows.push({
        usage: { calls: measured.calls, promptTokens: measured.promptTokens,
          hitTokens: measured.hitTokens, hitRate: measured.hitRate, toolsShare: measured.toolsShare },
        sessionId: session.id,
        short: shortId(session.id),
        firstAt: session.firstAt,
        lastAt: session.lastAt,
        calls: totals.requests,
        processed: totals.calls,
        bytesBefore: totals.bytesBefore,
        bytesAfter: totals.bytesAfter,
        bytesSaved: totals.bytesSaved,
        tokensSaved: totals.tokensSaved,
        shadowed: totals.shadowed,
        hidden: totals.hidden,
      })
    }
    rows.sort((a, b) => b.lastAt - a.lastAt)
    return rows.slice(0, MAX_CONVERSATIONS)
  }

  /** 存储状态；面板用来解释「为什么没有历史」。 */
  function info() {
    let months = []
    let bytes = 0
    try {
      for (const name of readdirSync(join(dir, 'stats'))) {
        if (!name.endsWith('.jsonl')) continue
        months.push(name.slice(0, -'.jsonl'.length))
        try {
          bytes += statSync(join(dir, 'stats', name)).size
        } catch {
          /* 文件刚好被删：忽略 */
        }
      }
    } catch {
      /* 目录不存在 = 还没写过任何记录 */
    }
    months.sort()
    return {
      enabled,
      dir,
      error,
      recordsLoaded,
      usageRecords,
      corruptLines,
      months,
      bytes,
      sessions: sessions.size,
      days: days.size,
      timezone: timezone(),
    }
  }

  /** 宿主进程解析出的系统时区（IANA 名）；取不到就退回 `local`。 */
  function timezone() {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      return typeof zone === 'string' && zone !== '' ? zone : 'local'
    } catch {
      return 'local'
    }
  }

  function close() {
    closeFd()
  }

  // -------------------------------------------------------------- internals
  function dayBucket(ts) {
    const key = dayKey(ts)
    let bucket = days.get(key)
    if (bucket === undefined) {
      bucket = emptyAggregate()
      days.set(key, bucket)
    }
    return bucket
  }

  function addSession(ts, sessionId, aggregate) {
    let session = sessions.get(sessionId)
    if (session === undefined) {
      session = { id: sessionId, firstAt: ts, lastAt: ts, days: new Map() }
      sessions.set(sessionId, session)
    }
    if (ts < session.firstAt) session.firstAt = ts
    if (ts > session.lastAt) session.lastAt = ts
    const key = dayKey(ts)
    let bucket = session.days.get(key)
    if (bucket === undefined) {
      bucket = emptyAggregate()
      session.days.set(key, bucket)
    }
    addInto(bucket, aggregate)
  }

  function sessionsIn(startKey) {
    let count = 0
    for (const session of sessions.values()) {
      for (const key of session.days.keys()) {
        if (key >= startKey) {
          count += 1
          break
        }
      }
    }
    return count
  }

  /** 丢太老的日桶与会话；只在跨日时跑一次。 */
  function prune(at, force = false) {
    const today = dayKey(at)
    if (!force && today === lastPruneDay) return
    lastPruneDay = today
    const cutoffKey = dayKey(startOfWindow(at, KEEP_DAYS))
    for (const key of days.keys()) {
      if (key < cutoffKey) days.delete(key)
    }
    for (const key of usageDays.keys()) {
      if (key < cutoffKey) usageDays.delete(key)
    }
    for (const [id, buckets] of usageSessions) {
      for (const key of buckets.keys()) if (key < cutoffKey) buckets.delete(key)
      if (buckets.size === 0) usageSessions.delete(id)
    }
    for (const [id, pending] of pendingAssembles) {
      if (at - pending.at > PAIR_WINDOW) pendingAssembles.delete(id)
    }
    for (const [id, session] of sessions) {
      for (const key of session.days.keys()) {
        if (key < cutoffKey) session.days.delete(key)
      }
      if (session.days.size === 0 || session.lastAt < startOfWindow(at, KEEP_DAYS).getTime()) {
        sessions.delete(id)
      }
    }
    if (sessions.size > MAX_SESSIONS) {
      const ordered = [...sessions.values()].sort((a, b) => a.lastAt - b.lastAt)
      const drop = sessions.size - MAX_SESSIONS
      for (let index = 0; index < drop; index += 1) sessions.delete(ordered[index].id)
    }
    for (const id of usageSessions.keys()) {
      if (!sessions.has(id)) usageSessions.delete(id)
    }
  }

  function appendLine(line) {
    try {
      const month = monthKey(line.ts)
      if (fd === null || fdMonth !== month) {
        closeFd()
        mkdirSync(join(dir, 'stats'), { recursive: true })
        fd = openSync(join(dir, 'stats', `${month}.jsonl`), 'a')
        fdMonth = month
      }
      writeSync(fd, `${JSON.stringify(line)}\n`)
      error = null
    } catch (cause) {
      error = describe(cause)
      closeFd()
      warn(`统计写盘失败（目录 ${dir}）：${error}`)
    }
  }

  function closeFd() {
    if (fd === null) return
    try {
      closeSync(fd)
    } catch {
      /* 已经关了就算了 */
    }
    fd = null
    fdMonth = null
  }

  function warn(message) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message)
    } catch {
      /* 日志失败不影响统计 */
    }
  }

  function loadMonths(at) {
    const current = monthKey(at)
    const earliest = monthKey(startOfWindow(at, WINDOWS.d30.days))
    // 30 天窗口可能跨两个自然月边界（例如 3 月 1 日要回看 1 月 31 日），
    // 所以必须把 earliest 到 current 之间的每个月都扫一遍，不能只取首尾。
    const months = []
    const cursor = new Date(`${earliest}-01T00:00:00`)
    const end = new Date(`${current}-01T00:00:00`)
    while (cursor.getTime() <= end.getTime()) {
      months.push(monthKey(cursor.getTime()))
      cursor.setMonth(cursor.getMonth() + 1)
    }
    return months
  }

  return { configure, record, recordUsage, summary, conversations, info, timezone, close }
}

// ------------------------------------------------------------------ helpers

/** 内部聚合量保留稳态及配对分母，不泄露到 HTTP 契约。 */
function emptyUsageAggregate() {
  return { calls: 0, promptTokens: 0, hitTokens: 0, missTokens: 0, outputTokens: 0,
    reasoningTokens: 0, steadyPrompt: 0, steadyHit: 0, zeroHitCalls: 0, firstCalls: 0,
    pairedCalls: 0, pairedPrompt: 0, estTokens: 0 }
}

function usageAggregateOf(source) {
  const hit = positiveInt(source.cacheRead)
  const miss = positiveInt(source.input)
  const prompt = hit + miss
  const first = source.first === 1 ? 1 : 0
  const paired = source.paired === 1 ? 1 : 0
  return { calls: 1, promptTokens: prompt, hitTokens: hit, missTokens: miss,
    outputTokens: positiveInt(source.output), reasoningTokens: positiveInt(source.reasoning),
    steadyPrompt: first ? 0 : prompt, steadyHit: first ? 0 : hit,
    zeroHitCalls: prompt > 0 && hit === 0 ? 1 : 0, firstCalls: first, pairedCalls: paired,
    pairedPrompt: paired ? prompt : 0, estTokens: paired ? positiveInt(source.estTokens) : 0 }
}

function usageView(totals) {
  return { calls: totals.calls, promptTokens: totals.promptTokens, hitTokens: totals.hitTokens,
    missTokens: totals.missTokens, outputTokens: totals.outputTokens, reasoningTokens: totals.reasoningTokens,
    hitRate: totals.promptTokens > 0 ? totals.hitTokens / totals.promptTokens : null,
    steadyHitRate: totals.steadyPrompt > 0 ? totals.steadyHit / totals.steadyPrompt : null,
    zeroHitCalls: totals.zeroHitCalls, firstCalls: totals.firstCalls, pairedCalls: totals.pairedCalls,
    toolsShare: totals.pairedCalls > 0 ? totals.estTokens / totals.pairedPrompt : null }
}

function emptyAggregate() {
  return {
    requests: 0,
    calls: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    shadowed: 0,
    hidden: 0,
    enumsKept: 0,
    itemsKept: 0,
    oversizeSlims: 0,
    failed: 0,
  }
}

/** 把一条记录（或加载到的旧行）折算成聚合增量；所有数字非负有限。 */
function aggregateOf(source) {
  const bytesBefore = positiveInt(source.bytesBefore)
  const bytesAfter = positiveInt(source.bytesAfter)
  return {
    requests: 1,
    calls: positiveInt(source.processed),
    bytesBefore,
    bytesAfter,
    bytesSaved: positiveInt(source.bytesSaved),
    // 0.7.0 早期行没有 tokensBefore/After；按同一 floor(bytes/4) 口径回填，
    // 保证旧日志也能算窗口百分比。
    tokensBefore: Number.isFinite(source.tokensBefore) ? positiveInt(source.tokensBefore) : Math.floor(bytesBefore / 4),
    tokensAfter: Number.isFinite(source.tokensAfter) ? positiveInt(source.tokensAfter) : Math.floor(bytesAfter / 4),
    tokensSaved: positiveInt(source.tokensSaved),
    shadowed: positiveInt(source.shadowed),
    hidden: positiveInt(source.hidden),
    enumsKept: positiveInt(source.enumsKept),
    itemsKept: positiveInt(source.itemsKept),
    oversizeSlims: positiveInt(source.oversizeSlims),
    failed: positiveInt(source.failed),
  }
}

function addInto(target, aggregate) {
  for (const key of Object.keys(target)) target[key] += aggregate[key]
  return target
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function shortId(id) {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** 本地时区自然日键 `YYYY-MM-DD`（字典序即时间序）。 */
export function dayKey(ts) {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地时区月份键 `YYYY-MM`。 */
export function monthKey(ts) {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

/** 窗口起点：本地时区当天 0 点往前推 days-1 天。 */
export function startOfWindow(ts, days) {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - (days - 1))
  return date
}

function pad(value) {
  return value < 10 ? `0${value}` : String(value)
}

function describe(error) {
  if (error instanceof Error) return error.message || String(error)
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
