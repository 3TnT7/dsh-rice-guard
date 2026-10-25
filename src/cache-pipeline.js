/**
 * 职责
 *   cache-pipeline 模块门面（v2）。唯一监听器 + 一条确定性流水线：
 *     ① 消隐：显式名单移除工具，`keepFull` 优先，空名单不删除；
 *     ② 瘦身：截断 `description`、压缩 `parameters`（逐工具隔离）；
 *     ③ 排序：对整份工具列表逐工具做对象键排序，数组保序。
 *   模块只产出数据与 handler，不认识 `ctx`；装配由 `src/index.js` 完成。
 *
 * 依赖的 DSH 契约（DSH 0.2.1-rc.2）
 *   - `system-prompt/assemble`（waterfall）：handler 形如 `(assembly, context, next)`。
 *     core 在 waterfall 之前把每个工具投影成
 *     `{ name, description, parameters: structuredClone(parameters), deferLoading? }`，
 *     不含 `execute` / `output`；返回 `{ ...assembly, tools }` 即被模型请求采用。
 *   - 本模块不依赖 `tools` / `systemPrompt` 服务，不调用 `tools.schemas/get/register`：
 *     host 级插件看到的工具注册表只有 3 个工具，模型真实请求有 36 个（实测），
 *     注册式瘦身拿不到目标工具（《cache-pipeline v4 变更说明》§1.1）；
 *     `system-prompt/assemble` 是模型可见工具列表的唯一投影点（同上 §1.3）。
 *   - `assembly.sections` / `contexts` / `variables` 原引用透传，只替换 `tools`。
 *
 * 关键决策与依据
 *   - 缓存动机：DeepSeek「上下文硬盘缓存」要求后续请求完整复用已落盘的缓存前缀单元
 *     才能命中，固定前缀逐字节稳定是命中的前提。
 *     来源：DeepSeek API 文档《上下文硬盘缓存》
 *     https://api-docs.deepseek.com/zh-cn/guides/kv_cache/
 *   - 行为对齐：默认值原样继承前身插件 `@local/dsh-cache-saver@0.3.1`（截断/瘦身参数：
 *     `shadowPrefixes`、8 个 `keepFull`、700/800/3/140/60/1/260/4）与
 *     `dsh-cache-stabilizer@0.1.1`（键排序：`enabled`、`maxDepth: 64`、
 *     `verify: 'length'`、`circuitBreaker: 5`）。唯一改掉的默认值是 `truncateUnions`
 *     （默认 false；旧实现把 `oneOf`/`anyOf`/`allOf` 截到 4 个分支）：分支截断省下的
 *     字节远小于模型按被删分支传参的风险（《整合实现方案》§6.2）。另有一处硬编码
 *     行为变化：`prefixItems` 从旧实现的「截到 4 个分支」改为永不截断（位置语义）。
 *   - 处理顺序固定：先消隐、再瘦身、后排序（《变更说明》§9 D3）；verify 基线只能是
 *     「已瘦身 → 排序后」，拿原始列表当基线会把预期收益误判成吃键（§4.1）。
 *   - 排序失败保留瘦身结果、不回退原始列表（§4.1 第 3 条 / D5）。
 *   - 熔断只停排序、不停瘦身（§4.5 / D6），避免一个排序 bug 连带关掉截断。
 *   - `await next()` 放在所有 `try`/`catch` 之外（§2.2 纪律 1）：内层异常原样上抛。
 *   - 每次 assemble 现算、不缓存（§4.5）：core 每次都 `structuredClone`，
 *     按对象身份缓存命中率为 0；按内容哈希缓存会引入内存增长与旧 schema 残留。
 *   - JSON 序列化语义按 ECMA-262 `JSON.stringify`：对象里 `undefined` 被省略、
 *     数组里变 `null`、`-0` 变 `0`；本模块用同一函数测长度，并且从不写
 *     `undefined` 字段（需要省略时就不赋该键）。
 *   - 会话冻结（v0.4.0）：运行期开关按 `context.agent.session.id` 快照，改动只影响
 *     之后的新会话。投影改前缀会击穿前缀缓存（总纲 §10.20），会话中途换投影的
 *     重建成本远大于收益；`freeze.enabled: false` 退回「切开关立刻生效」。
 *
 * 已知边界
 *   - 模型看到瘦身 schema，执行期仍用注册表完整定义；模型可能生成「瘦身版允许、
 *     完整版拒绝」的参数（§5.1 R1）。
 *   - 深度坍缩成 `{ type: 'object', additionalProperties: true }`，严格 provider 可能
 *     400（§5.1 R3，保留旧行为）。
 *   - 数组一律不排序：MCP 源重启后若改变 `enum` / `required` 顺序，字节仍会变（§4.2）。
 *   - 不保证不动点：截断不是 `f(f(x)) = f(x)`，也不加「已截断」标记（§4.2）。
 *   - 快照只活在进程内：插件重载后全部作废，会话按当时的 live 配置重新冻结；
 *     超出 128 个会话按 LRU 淘汰，被淘汰的会话会在下次 assemble 重新快照。
 */

import { DEFAULTS } from './config.js'
import { pricingSnapshot } from './pricing.js'
import { truncateDescription } from './cache-pipeline/truncate.js'
import { slimParameters } from './cache-pipeline/slim.js'
import { canonicalizeTools, isPlainObject, jsonLength } from './cache-pipeline/canonical.js'

export { DEFAULT_BOUNDARY_MARKERS, DEFAULT_SUFFIX, codePointLength, truncateDescription } from './cache-pipeline/truncate.js'
export { SLIM_RULE_DEFAULTS, slimParameters, selfcheck } from './cache-pipeline/slim.js'
export { canonicalizeValue, canonicalizeTools, isPlainObject, jsonLength } from './cache-pipeline/canonical.js'

/**
 * 模块身份（供后续 status/UI 模块使用）。
 * v2 把钩子集合从两个事件收敛到一个，统计口径从「按 agent / 按注册」变成
 * 「按 assemble」，属于契约变更而不是实现细节（《变更说明》§9 D11）。
 * v3（0.4.0）加入会话冻结：运行期开关按 session 快照，`setConfig` 不再是
 * 「立刻影响所有请求」；调用方读 `inspect().sessionsFrozen` / `freeze` 判断。
 */
export const CACHE_PIPELINE = Object.freeze({ id: 'cache-pipeline', version: 3 })

/**
 * 本次 gauge 字段（§4.3 的口径）：每次真正后处理的 assemble 开头清零，
 * 保证「本次」不会泄漏上一轮的值；累计值走 `*Total` 字段，两者不混。
 */
const GAUGE_FIELDS = Object.freeze([
  'shadowed',
  'wouldShadow',
  'skippedByPrefix',
  'skippedByKeepFull',
  'skippedBySize',
  'skippedByInvalid',
  'collapsedNodesLast',
  'rejectedBySelfcheckLast',
  'bytesBefore',
  'bytesAfter',
  'bytesSaved',
  'wouldSaveBytes',
  'hidden', 'wouldHide', 'hiddenBytes', 'wouldHideBytes', 'bytesAfterVisibility',
  'tokensBefore', 'tokensAfter', 'tokensSaved',
  'enumsKept', 'itemsKept', 'oversizeSlims',
])

/**
 * 进程内保留的会话快照上限。`Map` 按「最近使用」重排，超限时淘汰最久未
 * assemble 的那个会话；被淘汰的会话下次 assemble 会按当前 live 配置重新快照
 * （语义退化为「那一刻起冻结」）。128 对单进程的会话数足够宽。
 */
const SESSION_SNAPSHOT_LIMIT = 128

/**
 * 创建模块实例：只产出数据与 handler，不碰 `ctx`、不自己注册任何东西。
 *
 * @param {unknown} config 规范化后的配置（也可以是部分配置，缺项用默认值补齐）
 * @param {{ logger?: object, diag?: { count?: Function, once?: Function } }} [deps]
 * @returns {{ id: 'cache-pipeline', hooks: readonly object[], inspect: () => object }}
 */
export function createCachePipeline(config, deps) {
  let settings = resolveConfig(config)
  const depsObject = isPlainObject(deps) ? deps : {}
  const logger = resolveLogger(depsObject.logger)
  const stats = createStats()
  const ledger = []
  let sequence = 0

  // 去重范围与环形窗口一致：不保留无界历史索引，重载时自然清空。
  function decision(tool, action, reason) {
    if (ledger.some((entry) => entry.tool === tool && entry.reason === reason)) return
    ledger.push({ seq: ++sequence, tool, action, reason })
    if (ledger.length > 32) ledger.shift()
  }
  let keepFull = new Set(stringArray(settings.truncation.keepFull))
  let prefixes = stringArray(settings.truncation.shadowPrefixes)
  // 会话冻结：sessionId -> 快照视图（`{ settings, keepFull, prefixes }`）。
  // 快照只持有当日 live 对象的引用；live 侧每次换配置都换成新对象，从不原地改，
  // 所以快照天然不可变，不需要深拷贝。
  const sessions = new Map()
  let live = { settings, keepFull, prefixes }
  const loggedKeys = new Set()
  let consecutiveFailures = 0
  let circuitOpen = false

  /**
   * 运行期只接受三组里的布尔开关，其余配置保持原样，不写盘。
   * v0.4.0 起这些开关**按会话冻结**：改动写进 live 配置，已快照的会话继续用
   * 自己的旧视图，新会话才拿新值；`freeze.enabled: false` 退回旧行为（立即生效）。
   *
   * @param {{ visibility?: object, truncation?: object, ordering?: object }} partial
   * @returns {object} the resolved settings after the merge
   */
  function applyRuntimeConfig(partial) {
    const source = isPlainObject(partial) ? partial : {}
    const next = {
      truncation: { ...settings.truncation, ...pickSwitches(source.truncation, ['enabled', 'dryRun']) },
      visibility: { ...settings.visibility, ...pickSwitches(source.visibility, ['enabled', 'dryRun']) },
      ordering: { ...settings.ordering, ...pickSwitches(source.ordering, ['enabled']) },
      // 运行期接口不能开/关冻结本身：它决定的是「投影怎么换」，不是投影内容。
      freeze: { ...settings.freeze },
      // 价表只影响面板展示，运行期开关不该把它重置回默认（否则配置覆盖会被悄悄冲掉）。
      pricing: { ...settings.pricing },
      // 持久化目录同理：运行期开关不能把「精调存档」相关设置冲掉。
      storage: { ...settings.storage },
      debug: { ...settings.debug },
    }
    settings = resolveConfig(next)
    keepFull = new Set(stringArray(settings.truncation.keepFull))
    prefixes = stringArray(settings.truncation.shadowPrefixes)
    live = { settings, keepFull, prefixes }
    return settings
  }

  /**
   * 应用一整份配置（来自精调存档 / 还原）。与 `applyRuntimeConfig` 的区别：
   * 这里接受任意配置段（含 freeze / pricing / debug / storage），由存档层负责
   * 校验；失败时抛错，调用方决定是否回滚。
   *
   * 与运行期开关一样，**不改已有会话的快照**：改了投影参数的会话继续用旧视图，
   * 新会话才拿新值（§10.20 的前缀缓存账）。
   */
  function applyFullConfig(rawConfig) {
    settings = resolveConfig(rawConfig)
    keepFull = new Set(stringArray(settings.truncation.keepFull))
    prefixes = stringArray(settings.truncation.shadowPrefixes)
    live = { settings, keepFull, prefixes }
    return settings
  }

  // ------------------------------------------------------- session freezing
  /**
   * 选出本次 assemble 使用的视图。
   *
   * - 冻结关闭：直接用 live 视图（旧行为，切开关立刻生效）；
   * - 没有 session id（单测、非 agent 调用）：同样用 live，保证兼容；
   * - 首次见到某个 session：把当前 live 视图挂到该 session（快照）；
   * - 之后同一个 session：永远拿快照，运行期改配置只影响新会话。
   *
   * 依据：投影改前缀会击穿前缀缓存（总纲 §10.20），会话中途换投影的重建成本
   * 远大于收益；`freeze.enabled: false` 是显式退路。
   *
   * @param {unknown} context waterfall 第二参数，真实调用形如 `{ agent, scope, signal? }`
   * @returns {{ settings: object, keepFull: Set<string>, prefixes: string[] }}
   */
  function resolveView(context) {
    if (!settings.freeze.enabled) return live
    const id = sessionIdOf(context)
    if (id === undefined) return live
    const hit = sessions.get(id)
    if (hit !== undefined) {
      // 重新插入 = 刷新 LRU 顺序；淘汰时优先丢掉最久没 assemble 的会话。
      sessions.delete(id)
      sessions.set(id, hit)
      count('frozenAssembles')
      return hit
    }
    const snapshot = live
    sessions.set(id, snapshot)
    count('sessionSnapshots')
    evictSessions()
    return snapshot
  }

  /** 永不抛：`context.agent` 也可能是敌意对象上的 accessor。 */
  function sessionIdOf(context) {
    try {
      const agent = context !== null && typeof context === 'object' ? context.agent : undefined
      if (agent === null || typeof agent !== 'object') return undefined
      const session = agent.session
      if (session === null || typeof session !== 'object') return undefined
      const id = session.id
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  function evictSessions() {
    while (sessions.size > SESSION_SNAPSHOT_LIMIT) {
      const oldest = sessions.keys().next().value
      sessions.delete(oldest)
      count('sessionSnapshotsEvicted')
    }
  }

  // ------------------------------------------------------------------ logging
  function count(name, delta = 1) {
    if (typeof stats[name] === 'number') stats[name] += delta
    const sink = depsObject.diag
    if (sink && typeof sink.count === 'function') {
      try {
        sink.count(name, delta)
      } catch {
        /* 观测失败不允许影响钩子 */
      }
    }
  }

  function once(key, level, message) {
    const sink = depsObject.diag
    if (sink && typeof sink.once === 'function') {
      try {
        sink.once(key, level, message)
        return
      } catch {
        /* 落回本地 sink */
      }
    }
    if (settings.debug.logOnce !== false) {
      if (loggedKeys.has(key)) return
      // 与配置默认值一致：去重后的工具级日志最多 20 条，防止一个坏输入刷屏
      // （§4.5 N7 的日志纪律）。
      const cap = Number.isFinite(settings.debug.maxLoggedTools) ? settings.debug.maxLoggedTools : 20
      if (cap >= 0 && loggedKeys.size >= cap) return
      loggedKeys.add(key)
    }
    writeLog(logger, level, message)
  }

  function fail(label, error) {
    count('failed')
    stats.lastError = describe(error)
    once(`fail:${label}`, 'warn', `${label} failed: ${describe(error)}`)
  }

  // ------------------------------------------------------- the only handler
  /**
   * 把本次 assemble 的增量交给持久层（`index.js` 注入）。全同步、永不抛：
   * 统计落盘失败绝不能让投影变形失败。
   */
  function statsRecord(sessionId, processed, failedBefore) {
    const sink = depsObject.recordAssemble
    if (typeof sink !== 'function') return
    try {
      sink({
        sessionId,
        processed,
        failed: Math.max(0, stats.failed - failedBefore),
        bytesBefore: processed ? stats.bytesBefore : 0,
        bytesAfter: processed ? stats.bytesAfter : 0,
        bytesSaved: processed ? stats.bytesSaved : 0,
        tokensBefore: processed ? stats.tokensBefore : 0,
        tokensAfter: processed ? stats.tokensAfter : 0,
        tokensSaved: processed ? stats.tokensSaved : 0,
        shadowed: processed ? stats.shadowed : 0,
        hidden: processed ? stats.hidden : 0,
        enumsKept: processed ? stats.enumsKept : 0,
        itemsKept: processed ? stats.itemsKept : 0,
        oversizeSlims: processed ? stats.oversizeSlims : 0,
      })
    } catch {
      /* 观测失败不允许影响钩子 */
    }
  }

  async function handleAssemble(assembly, context, next) {
    resetGauges()
    const sessionId = sessionIdOf(context)
    const failedBefore = stats.failed
    // 先定视图再判空：即使三个开关全关，这个会话也要在此刻冻结，
    // 否则之后打开的开关会改到已经在跑的老会话（§10.20）。
    const view = resolveView(context)
    const current = view.settings
    // 三个开关都关：不测长、不遍历，直接交回内层结果（§2.2 第 0 步）。
    if (!current.visibility.enabled && !current.truncation.enabled && !current.ordering.enabled) {
      const passed = await next()
      statsRecord(sessionId, 0, failedBefore)
      return passed
    }

    // 内层的失败由调用方看见，不能被我们吞掉。这一行必须在所有 try/catch 之外
    // （§2.2 实现纪律 1）。
    const assembled = await next()

    // 结构兜底：内层返回非对象 = 没有可用结果，退回入参；`tools` 不是数组时只放弃
    // 后处理，不放弃整个 assembly（§2.2 第 2 步）。
    if (!isPlainObject(assembled)) {
      statsRecord(sessionId, 0, failedBefore)
      return assembly
    }
    if (!Array.isArray(assembled.tools)) {
      statsRecord(sessionId, 0, failedBefore)
      return assembled
    }

    try {
      count('assembleCalls')

      let shaped = assembled.tools
      let bytesBefore = -1

      // 消隐和瘦身共享原始测量；消隐关闭时不增加序列化次数。
      const measuring = current.truncation.enabled || current.visibility.enabled
      if (measuring) {
        bytesBefore = jsonLength(assembled.tools)
        stats.bytesBefore = bytesBefore
        stats.bytesAfterVisibility = bytesBefore
      }
      if (current.visibility.enabled) {
        try {
          const result = hideTools(shaped, current.visibility, view.keepFull)
          shaped = result.tools
          stats.bytesAfterVisibility = shaped === assembled.tools ? bytesBefore : jsonLength(shaped)
          stats.hidden = current.visibility.dryRun ? 0 : result.hidden
          stats.wouldHide = current.visibility.dryRun ? result.hidden : 0
          stats.hiddenBytes = measuredDelta(bytesBefore, stats.bytesAfterVisibility)
          stats.wouldHideBytes = current.visibility.dryRun ? measuredDelta(bytesBefore, result.projectedBytes) : 0
          count('hiddenTotal', stats.hidden)
          count('toolsSeen', assembled.tools.length)
          for (const entry of result.decisions) decision(...entry)
        } catch (error) {
          // 列表级失败必须撤销整个消隐阶段，不把部分删除发出去。
          fail('visibility', error)
          statsRecord(sessionId, 1, failedBefore)
          return assembled
        }
      }
      const visible = shaped
      // ---- 阶段 A：过滤 + 截断/瘦身（逐工具隔离） --------------------------
      if (current.truncation.enabled) {

        let projectedBytes = -1
        try {
          const shadow = shapeTools(visible, current.truncation, view)
          shaped = shadow.tools
          projectedBytes = shadow.projectedBytes
          recordShapeCounters(shadow.counters, current.visibility.enabled)
        } catch (error) {
          // 只兜列表级失败：保留原列表让阶段 B 继续跑。单工具失败在
          // `shapeTool` 那一层就隔离了，不会到这里。
          fail('shape', error)
          shaped = visible
          projectedBytes = -1
        }

        // `projectedBytes` 只在 dryRun 路径由 `shapeTools` 产出：非 dryRun 下
        // `wouldSaveBytes` 按契约恒为 0，再测一遍瘦身后列表就是白做一次全列表
        // 序列化（§4.3 / §4.5）。`resetGauges` 已经把该 gauge 清零。
        if (current.truncation.dryRun) {
          const wouldSave = projectedBytes >= 0 ? Math.max(0, stats.bytesAfterVisibility - projectedBytes) : 0
          stats.wouldSaveBytes = wouldSave
          if (stats.wouldShadow > 0) {
            once(
              'dry-run',
              'info',
              `dryRun: ${stats.wouldShadow} tool projection(s) would be shadowed, about ${wouldSave} byte(s) saved`,
            )
          }
        }
      }

      // ---- 阶段 B：对象键排序（工具列表顺序永远不动） ----------------------
      if (current.ordering.enabled && !circuitOpen) {
        try {
          const report = canonicalizeTools(shaped, {
            maxDepth: current.ordering.maxDepth,
            verify: current.ordering.verify,
          })

          if (report.protoKeysSeen > 0) {
            count('protoKeysSeen', report.protoKeysSeen)
            once('proto-key', 'warn', 'a tool schema declares "__proto__"; kept as an own data property')
          }

          if (Array.isArray(report.tools)) {
            shaped = report.tools
            consecutiveFailures = 0
          } else {
            // 保留 `shaped`（已瘦身、未排序）：verify 失败可能已经吃掉了键，
            // 绝不能把 `report.tools` 发出去；也不能退回原始列表，那会把唯一的
            // 瘦身收益一起丢掉（§4.1 第 3 条 / D5）。
            count('canonicalFallbacks')
            const reason = report.reason || 'unknown'
            if (reason === 'length-mismatch') {
              once(
                'length-mismatch',
                'error',
                'canonical ordering changed serialized length; kept the shaped tool list (unsorted)',
              )
            } else if (reason === 'threw') {
              once('canonical-threw', 'warn', 'canonical ordering threw; kept the shaped tool list (unsorted)')
            }
            recordOrderingFailure(reason, current)
          }
        } catch (error) {
          count('canonicalFallbacks')
          once(
            'canonical-threw',
            'warn',
            `canonical ordering threw; kept the shaped tool list (unsorted): ${describe(error)}`,
          )
          recordOrderingFailure('threw', current)
        }
      }

      if (measuring) {
        const bytesAfter = jsonLength(shaped)
        stats.bytesAfter = bytesAfter
        stats.bytesSaved = measuredDelta(stats.bytesAfterVisibility, bytesAfter)
        // 启发式估算，不是 tokenizer/provider 实报；统一按 4 个 UTF-16 单元/token 向下取整。
        stats.tokensBefore = bytesBefore >= 0 ? Math.floor(bytesBefore / 4) : 0
        stats.tokensAfter = bytesAfter >= 0 ? Math.floor(bytesAfter / 4) : 0
        stats.tokensSaved = bytesBefore >= 0 && bytesAfter >= 0 ? Math.floor((bytesBefore - bytesAfter) / 4) : 0
        count('tokensSavedTotal', stats.tokensSaved)
        if (bytesBefore >= 0) count('tokensBeforeTotal', stats.tokensBefore)
        if (bytesAfter >= 0) count('tokensAfterTotal', stats.tokensAfter)
      }

      // 只有产出确实不同的列表时才造新 assembly；没变就原样返回，
      // 保证「没命中任何工具」时零对象分配（§4.6）。
      if (shaped === assembled.tools) {
        statsRecord(sessionId, 1, failedBefore)
        return assembled
      }
      statsRecord(sessionId, 1, failedBefore)
      return { ...assembled, tools: shaped }
    } catch (error) {
      // 我们自己的意外异常的最后兜底。`next()` 不在这个作用域里；
      // 最差退回内层刚产出的完整 assembly（§2.2 第 5 步）。
      fail('unexpected', error)
      statsRecord(sessionId, 1, failedBefore)
      return assembled
    }
  }

  /** 保序过滤；单工具坏输入保留原引用，列表异常由调用方整段回退。 */
  function hideTools(tools, rules, keepFullNames) {
    const exact = new Set(stringArray(rules.exact))
    const hiddenPrefixes = stringArray(rules.prefixes)
    const keepFullSet = keepFullNames instanceof Set ? keepFullNames : keepFull
    const candidate = []
    // 暂存决定，列表完整成功后才提交，避免失败时出现伪 hidden 留痕。
    const decisions = []
    let hidden = 0
    for (const tool of tools) {
      let reason
      let name = '?'
      try {
        if (!isPlainObject(tool) || typeof tool.name !== 'string' || tool.name === '') {
          reason = 'invalid'
        } else {
          name = tool.name
          if (keepFullSet.has(name)) reason = 'keepFull'
          else if (exact.has(name)) reason = 'exact'
          else if (hiddenPrefixes.some((prefix) => name.startsWith(prefix))) reason = 'prefix'
          else reason = 'prefix-miss'
        }
      } catch (error) {
        fail('visibility-tool', error)
        reason = 'tool-error'
      }
      const match = reason === 'exact' || reason === 'prefix'
      if (match) hidden += 1
      else candidate.push(tool)
      // dryRun 不伪称实际移除：kept + 命中原因，预计数另记。
      // prefix-miss 是常态（名单通常只覆盖少数工具），只计数不写 ledger。
      if (reason !== 'prefix-miss') decisions.push([name, match && !rules.dryRun ? 'hidden' : 'kept', reason])
    }
    return {
      tools: hidden > 0 && !rules.dryRun ? candidate : tools,
      hidden, decisions,
      projectedBytes: rules.dryRun && hidden > 0 ? jsonLength(candidate) : -1,
    }
  }

  // ------------------------------------------------------- stage A internals
  /**
   * 只遍历工具列表一次。每个元素单独过滤、单独瘦身：某个元素坏了就保留它的
   * 原引用，不中断其余元素（§4.5 失败隔离矩阵）。
   *
   * @returns {{ tools: unknown[], changed: boolean, counters: object, projectedBytes: number }}
   *   `projectedBytes` 只在 dryRun 路径上是「瘦身后候选列表」的序列化长度；
   *   非 dryRun 返回 `-1`，且不做这次测量。
   */
  function shapeTools(tools, rules, view) {
    const counters = createShapeCounters()
    const candidate = []
    let changed = false

    for (const tool of tools) {
      counters.toolsSeen += 1
      let result
      try {
        result = shapeTool(tool, rules, counters, view)
      } catch (error) {
        decision(safeToolName(tool), 'kept', 'tool-error')
        fail(`tool:${safeToolName(tool)}`, error)
        candidate.push(tool)
        continue
      }
      if (result.tool !== tool) changed = true
      candidate.push(result.tool)
      if (result.action === 'shadowed') {
        // 正常瘦身是常态（本机一次 assemble 就有 39 个），只记计数，不进 ledger：
        // 否则 32 条窗口会被它挤满，异常与被保护原因反而看不见。
        if (rules.dryRun) counters.wouldShadow += 1
        else counters.shadowed += 1
      }
    }

    const projected = changed ? candidate : tools

    // dryRun 照常算完，但生效列表仍是入参引用：调用方看到原始字节，
    // 之后只有排序可能改变键序（§4.3 dryRun 定义第 2 条）。
    //
    // `projectedBytes` 只为 dryRun 的「预计省多少」服务；非 dryRun 调用方从不读它
    // （那条路径上 wouldSaveBytes 恒为 0），所以不在那里多做一次全列表 `JSON.stringify`。
    if (rules.dryRun) {
      return { tools, changed: false, counters, projectedBytes: jsonLength(projected) }
    }
    return { tools: projected, changed, counters, projectedBytes: -1 }
  }

  /**
   * 单个工具。过滤顺序固定：`keepFull` -> 前缀 -> 瘦身；没有实际变化就返回原引用
   * （§4.4 的过滤顺序，不能反过来，否则 `keepFull` 会被前缀逻辑架空）。
   */
  function shapeTool(tool, rules, counters, view) {
    if (!isPlainObject(tool)) {
      decision('?', 'kept', 'invalid')
      return { tool, action: 'kept' }
    }

    const name = tool.name
    if (typeof name !== 'string' || name === '') {
      decision('?', 'kept', 'invalid')
      return { tool, action: 'kept' }
    }

    // `keepFull` 优先于一切，包括 `shadowPrefixes: []`（§4.4）。
    // 名单来自会话视图：已冻结的会话不会被运行期名单改动波及。
    if (view.keepFull.has(name)) {
      decision(name, 'kept', 'keepFull')
      counters.skippedByKeepFull += 1
      return { tool, action: 'kept' }
    }
    if (!matchesPrefix(name, view.prefixes)) {
      // 最常见、最没有信息量的默认分支：只计数，不进 ledger，
      // 否则一次 assemble 就能用前缀未命中的工具把 32 条窗口刷满。
      counters.skippedByPrefix += 1
      return { tool, action: 'kept' }
    }

    const originalDescription = tool.description
    const description = clampToolDescription(originalDescription, rules.maxDescriptionChars)
    // `clampToolDescription` 对字符串输入永远不会产出 ''/undefined，对非字符串
    // 原样返回，所以这里只需要比较是否真的变了。
    const descriptionChanged = typeof description === 'string' && description !== originalDescription

    let slim
    // `parameters` 缺失或不是 plain object 时只处理 description：不新增
    // `parameters` 键，也不覆盖原引用（§4.5 / N12）。
    if (isPlainObject(tool.parameters)) {
      slim = slimParameters(tool.parameters, rules, {
        onReject: (reason) => {
          // 只把「异常/被保护」的原因写进 ledger；small 与 not-smaller 是常态，
          // 计数足够（否则它们会把 32 条窗口挤掉真正要看的原因）。
          if (reason === 'selfcheck') decision(name, 'kept', 'selfcheck')
          else if (reason === 'invalid' || reason === 'root') decision(name, 'kept', 'invalid')
          if (reason === 'selfcheck') {
            counters.rejectedBySelfcheck += 1
            once(`selfcheck:${name}`, 'warn', `slimming "${name}" produced an invalid schema; kept the original`)
          } else if (reason === 'not-smaller') {
            counters.skippedBySize += 1
          } else {
            // invalid / root / small：和「体积不更小」分开统计，
            // 否则一个坏 schema 会看起来像瘦身没收益（§3.5）。
            counters.skippedByInvalid += 1
          }
        },
      })
    }
    if (slim !== undefined) {
      counters.collapsedNodes += slim.collapsedNodes
      // 0.6.0：skeleton / collapse 保留的调用约束与「语义优先、超预算」次数。
      if (slim.enumsKept) counters.enumsKept += slim.enumsKept
      if (slim.itemsKept) counters.itemsKept += slim.itemsKept
      if (slim.overBudget) counters.oversizeSlims += 1
    }

    if (!descriptionChanged && slim === undefined) return { tool, action: 'kept' }

    // 造新对象，只写真正改过的字段：原本没有 `parameters` 的工具永远不会多出
    // 一个 `parameters: undefined`（ECMA-262 会把该键省略，但显式写它就是另一回事）。
    const nextTool = { ...tool }
    if (descriptionChanged) nextTool.description = description
    if (slim !== undefined) nextTool.parameters = slim.parameters
    return { tool: nextTool, action: 'shadowed' }
  }

  function clampToolDescription(value, maxCodePoints) {
    if (typeof value !== 'string') return value
    if (!(maxCodePoints > 0)) return value // 0 = 关闭工具 description 截断（§4.4）
    const result = truncateDescription(value, maxCodePoints)
    // ToolSchema.description 是必填字符串：空结果（空白输入或不可用的 max）
    // 保留原文，绝不产出 '' / `undefined`（N12）。
    return result.text === '' ? value : result.text
  }

  function recordShapeCounters(counters, visibilityEnabled) {
    stats.shadowed = counters.shadowed
    stats.wouldShadow = counters.wouldShadow
    stats.skippedByPrefix = counters.skippedByPrefix
    stats.skippedByKeepFull = counters.skippedByKeepFull
    stats.skippedBySize = counters.skippedBySize
    stats.skippedByInvalid = counters.skippedByInvalid
    stats.collapsedNodesLast = counters.collapsedNodes
    stats.rejectedBySelfcheckLast = counters.rejectedBySelfcheck
    stats.enumsKept = counters.enumsKept
    stats.itemsKept = counters.itemsKept
    stats.oversizeSlims = counters.oversizeSlims

    // 消隐开着时 `toolsSeen` 已由消隐阶段记过一轮，别重复计数。
    if (counters.toolsSeen && !visibilityEnabled) count('toolsSeen', counters.toolsSeen)
    if (counters.shadowed) count('shadowedTotal', counters.shadowed)
    if (counters.skippedByPrefix) count('skippedByPrefixTotal', counters.skippedByPrefix)
    if (counters.skippedByKeepFull) count('skippedByKeepFullTotal', counters.skippedByKeepFull)
    if (counters.skippedBySize) count('skippedBySizeTotal', counters.skippedBySize)
    if (counters.skippedByInvalid) count('skippedByInvalidTotal', counters.skippedByInvalid)
    if (counters.collapsedNodes) count('collapsedNodes', counters.collapsedNodes)
    if (counters.rejectedBySelfcheck) count('rejectedBySelfcheck', counters.rejectedBySelfcheck)
    if (counters.enumsKept) count('enumsKeptTotal', counters.enumsKept)
    if (counters.itemsKept) count('itemsKeptTotal', counters.itemsKept)
    if (counters.oversizeSlims) count('oversizeSlimsTotal', counters.oversizeSlims)
  }

  // --------------------------------------------- ordering failure / circuit
  /**
   * 记录一次阶段 B 失败。熔断故意只盯排序：打开后只停本进程的排序，
   * 不停瘦身（§4.5 熔断语义 / D6）。熔断是进程级安全状态，按会话冻结的
   * 配置不参与它——否则一个会话的坏输入会被另一个会话的阈值掩盖。
   */
  function recordOrderingFailure(reason, current) {
    const threshold = current && current.ordering ? current.ordering.circuitBreaker : settings.ordering.circuitBreaker
    if (typeof threshold !== 'number' || !(threshold > 0)) return
    consecutiveFailures += 1
    if (consecutiveFailures >= threshold && !circuitOpen) {
      circuitOpen = true
      once(
        'circuit-open',
        'error',
        `circuit open (${describe(reason)}): ordering disabled for this process after ${consecutiveFailures} consecutive failure(s)`,
      )
    }
  }

  function resetGauges() {
    for (const name of GAUGE_FIELDS) stats[name] = 0
  }

  // 唯一的 HookSpec（§3.2）：一个事件、waterfall、错误由 handler 自己兜。
  // 数组长度恒为 1；`hooks.js` 是唯一碰 `ctx.on` 的地方。
  const hooks = Object.freeze([
    Object.freeze({
      id: 'shape-and-stabilize-tools',
      event: 'system-prompt/assemble',
      kind: 'waterfall',
      containment: 'own-errors-only',
      handler: handleAssemble,
    }),
  ])

  return {
    id: CACHE_PIPELINE.id,
    hooks,
    inspect() {
      // `circuitOpen` 是状态不是计数器：现场读，后续再失败也立刻可见，
      // 不需要额外记账（§4.3）。`pricing` 是配置派生的快照（不是计数）。
      const snapshot = {
        circuitOpen,
        sessionsFrozen: sessions.size,
        ledger: ledger.map((entry) => ({ ...entry })),
        pricing: pricingSnapshot(settings.pricing),
      }
      for (const [key, value] of Object.entries(stats)) {
        if (value !== undefined) snapshot[key] = value
      }
      return snapshot
    },
    /** Live overrides used by the sidebar switches (never persists on its own). */
    setConfig: applyRuntimeConfig,
    /** Apply a whole config object (tuning store / restore); existing sessions keep their snapshot. */
    applyFullConfig,
    /** Current resolved settings, including live overrides. */
    getConfig() {
      return settings
    },
  }
}

// ---------------------------------------------------------------- small utils

function createShapeCounters() {
  return {
    toolsSeen: 0,
    shadowed: 0,
    wouldShadow: 0,
    skippedByPrefix: 0,
    skippedByKeepFull: 0,
    skippedBySize: 0,
    skippedByInvalid: 0,
    collapsedNodes: 0,
    rejectedBySelfcheck: 0,
    enumsKept: 0,
    itemsKept: 0,
    oversizeSlims: 0,
  }
}

function createStats() {
  return {
    // 进程内累计（插件重载清零）
    hiddenTotal: 0,
    tokensSavedTotal: 0,
    tokensBeforeTotal: 0,
    tokensAfterTotal: 0,
    skippedByInvalidTotal: 0,
    assembleCalls: 0,
    toolsSeen: 0,
    shadowedTotal: 0,
    skippedByPrefixTotal: 0,
    skippedByKeepFullTotal: 0,
    skippedBySizeTotal: 0,
    collapsedNodes: 0,
    rejectedBySelfcheck: 0,
    // 0.6.0：skeleton/collapse 保留的 enum/items 计数与「语义优先、超预算」次数。
    enumsKeptTotal: 0,
    itemsKeptTotal: 0,
    oversizeSlimsTotal: 0,
    canonicalFallbacks: 0,
    protoKeysSeen: 0,
    failed: 0,
    // 会话冻结（v0.4.0）：累计创建的快照数、快照命中数、LRU 淘汰数。
    sessionSnapshots: 0,
    frozenAssembles: 0,
    sessionSnapshotsEvicted: 0,
    lastError: undefined,
    // 本次 gauge（由 `resetGauges` 清零）
    shadowed: 0,
    wouldShadow: 0,
    skippedByPrefix: 0,
    skippedByKeepFull: 0,
    skippedBySize: 0,
    skippedByInvalid: 0,
    collapsedNodesLast: 0,
    rejectedBySelfcheckLast: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    wouldSaveBytes: 0,
    hidden: 0, wouldHide: 0, hiddenBytes: 0, wouldHideBytes: 0, bytesAfterVisibility: 0,
    tokensBefore: 0, tokensAfter: 0, tokensSaved: 0,
    enumsKept: 0, itemsKept: 0, oversizeSlims: 0,
  }
}

/**
 * 模块内再兜一层默认值：`config` 不只来自 `normalizeConfig`，测试或后续模块
 * 也可能直接传部分配置（§3.7 的签名允许）。
 */
function resolveConfig(config) {
  const source = isPlainObject(config) ? config : {}
  return {
    truncation: mergeGroup(DEFAULTS.truncation, source.truncation),
    visibility: mergeGroup(DEFAULTS.visibility, source.visibility),
    ordering: mergeGroup(DEFAULTS.ordering, source.ordering),
    freeze: mergeGroup(DEFAULTS.freeze, source.freeze),
    debug: mergeGroup(DEFAULTS.debug, source.debug),
    storage: mergeGroup(DEFAULTS.storage, source.storage),
    pricing: mergeGroup(DEFAULTS.pricing, source.pricing),
  }
}

function mergeGroup(defaults, value) {
  return isPlainObject(value) ? { ...defaults, ...value } : { ...defaults }
}

/** Keep only the boolean switches the live-config endpoint is allowed to touch. */
function pickSwitches(value, keys) {
  const picked = {}
  if (!isPlainObject(value)) return picked
  for (const key of keys) {
    if (typeof value[key] === 'boolean') picked[key] = value[key]
  }
  return picked
}

function resolveLogger(value) {
  return {
    error: (message) => writeLog(value, 'error', message),
    warn: (message) => writeLog(value, 'warn', message),
    info: (message) => writeLog(value, 'info', message),
    debug: (message) => writeLog(value, 'debug', message),
  }
}

function writeLog(logger, level, message) {
  try {
    const fn = logger && logger[level]
    if (typeof fn === 'function') fn.call(logger, `[cache-pipeline] ${message}`)
  } catch {
    /* 日志永远不能弄坏钩子 */
  }
}

function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item !== '')
}

function matchesPrefix(name, prefixes) {
  if (prefixes.length === 0) return true // 旧语义：空数组 = 处理全部工具（§4.4）
  return prefixes.some((prefix) => name.startsWith(prefix))
}

/** 永不抛：`name` 本身可能是带副作用的 accessor。 */
function safeToolName(tool) {
  try {
    const name = tool && tool.name
    return typeof name === 'string' && name !== '' ? name : '?'
  } catch {
    return '?'
  }
}

function describe(error) {
  if (error instanceof Error) return error.message || String(error)
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/** 无法测量时不虚报收益，沿用 jsonLength 的 -1 哨兵。 */
function measuredDelta(before, after) {
  return before >= 0 && after >= 0 ? before - after : 0
}
