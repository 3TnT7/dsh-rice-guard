/**
 * 职责
 *   配置默认值与规范化。`normalizeConfig` 负责：未知键丢弃、非法值回退、数字
 *   clamp、旧扁平键映射、深度冻结；**永不抛**。默认值集中在本文件，别处不重复定义。
 *
 * 依赖的 DSH 契约（DSH 0.2.1-rc.2）
 *   - 不导出 cordis `Config` schema：宿主在 `apply()` 之前用 `Config["~standard"].validate`
 *     校验，失败只把 fiber 记为 error、插件不启动；没有「校验失败回退默认值」的通道。
 *     缓存优化属于锦上添花，配置笔误不该让插件消失（《整合实现方案》§6.1）。
 *   - `debug.logLevel` 的 `'warn' / 'info' / 'silent'` 与 `ctx.logger` 的级别语义对齐
 *     （DSH 0.2.1-rc.2 的 Logger 提供 error/info/warn/debug，级别数值递增）。
 *
 * 关键决策与依据
 *   - 默认值逐项对齐前身插件：`@local/dsh-cache-saver@0.3.1`（截断/瘦身参数）与
 *     `dsh-cache-stabilizer@0.1.1`（键排序）；profile 里两个旧插件都没有覆盖配置，
 *     所以这些默认值就是迁移前的线上行为（《整合实现方案》§1.4.1）。
 *   - 改掉的默认行为一：`truncateUnions` 默认 false。旧实现把 `oneOf`/`anyOf`/`allOf`
 *     截到 4 个分支；分支截断省几十字节，却可能让模型按被删分支组织参数，
 *     收益小于风险（《整合实现方案》§6.2）。`maxBranches: 4` 原样保留，只在开关
 *     打开时生效，且硬下限 2。
 *   - 改掉的默认行为二：`shadowPrefixes` 默认 `['mcp__']`：匹配所有 MCP 工具（命名形如
 *     `mcp__<server>__<tool>`），core 工具不在其中。上游默认是作者私有环境专用的
 *     `['mcp__rea__']`（只匹配那一套逆向分析 MCP），已改为通用前缀。本机未连接
 *     MCP 时该配置零命中，属于空转，不改变任何行为。
 *   - `shadowPrefixes: []` 保留旧语义「处理全部工具」：`stringListField` 不会把
 *     空数组当非法值；但「非空数组里没有一个可用字符串」按笔误回退默认，
 *     避免静默瘦身整个注册表。
 *   - visibility 独立默认关，空前缀永不匹配；沿用列表过滤/去重与 256 条上限。
 *   - 扁平旧键只做迁移便利，分组配置优先；顺序让新名字先于旧名字（§1.4.2）。
 *   - 结果深度冻结：后续模块（reporting / UI）拿到的是同一个对象，冻结可挡住
 *     运行期误改；模块内部读取从不依赖可变状态。
 *
 * 已知边界
 *   - 未知键静默丢弃、超界数字静默 clamp、非法值静默回退：配置写错不会报错，
 *     只会「按默认值跑」。这是「永不抛」的代价，靠 README 的配置表暴露。
 *   - 不导出 `Config`，所以设置页/宿主看不到本插件的结构；未知键也不会被提示。
 *   - 列表上限 256 条（`MAX_LIST_ENTRIES`）：只防超大数组，不校验前缀语义。
 */

/**
 * 用户可给的前缀 / keepFull 列表的硬上限：只防「塞 1e6 条」把每次 assemble
 * 拖慢，不改变匹配语义（精确前缀、大小写敏感）。
 */
const MAX_LIST_ENTRIES = 256

/** 数值区间，与《整合实现方案》§1.4.2 一致；先截断为整数再 clamp。 */
const NUMBER_RULES = Object.freeze({
  truncation: Object.freeze({
    minSchemaChars: [0, 1_000_000],
    maxSchemaChars: [200, 1_000_000],
    maxDepth: [0, 6],
    topDescriptionChars: [0, 4000],
    nestedDescriptionChars: [0, 4000],
    descriptionDepth: [0, 6],
    maxDescriptionChars: [0, 8000],
    maxBranches: [1, 64],
  }),
  ordering: Object.freeze({
    maxDepth: [0, 512],
    circuitBreaker: [0, 1000],
  }),
  debug: Object.freeze({
    maxLoggedTools: [0, 1000],
  }),
  storage: Object.freeze({
    maxBackups: [0, 100],
  }),
})

/**
 * 规范化默认值。刻意逐项对齐被替换的两个插件
 * （`dsh-cache-saver` + `dsh-cache-stabilizer`）：profile 没有覆盖配置时，
 * 迁移后的线上行为应保持不变（差异与署名见 NOTICE.md）。
 */
export const DEFAULTS = deepFreeze({
  /** 模型可见投影的截断 / 瘦身（来自 cache-saver）。 */
  truncation: {
    /**
     * 是否替换 `system-prompt/assemble` 投影里命中 `shadowPrefixes` 且不在
     * `keepFull` 的工具的 `description` / `parameters`。
     */
    enabled: true,
    /**
     * 只处理名字以这些前缀开头的工具：
     *   - `['mcp__']` = 匹配所有 MCP 工具（命名形如 `mcp__<server>__<tool>`）；
     *   - core 工具（`read` / `write` / `pwsh` 等）不以该前缀开头，永不被处理；
     *   - 未连接 MCP 时零命中，本配置是空转，不影响任何行为；
     *   - `[]` = 全部工具（旧语义，README 标红）。
     * 上游默认 `['mcp__rea__']` 是作者私有环境（只匹配那套 rea 工具），已改成通用前缀。
     */
    shadowPrefixes: ['mcp__'],
    /**
     * 永不瘦身的精确名单。这 8 个名字是上游作者环境的 rea 工具，只为兼容而保留：
     * 它们同样命中 `mcp__` 前缀，但名字匹配即跳过，所以仍会被完整保留；
     * 本机不接 rea 时它们不命中任何工具，可以安全清空。
     */
    keepFull: [
      'mcp__rea__inspect_web_page',
      'mcp__rea__list_names',
      'mcp__rea__list_procedures',
      'mcp__rea__procedure_pseudo_code',
      'mcp__rea__procedure_assembly',
      'mcp__rea__analyze_function',
      'mcp__rea__search_procedures',
      'mcp__rea__search_strings',
    ],
    /** 小于此值的 schema 不动（JSON 字符数）。 */
    minSchemaChars: 700,
    /** 瘦身目标上限（JSON 字符数）。 */
    maxSchemaChars: 800,
    /** 保留的最深嵌套层级；更深的对象坍缩。 */
    maxDepth: 3,
    /** 根层 description 上限（码点）。 */
    topDescriptionChars: 140,
    /** 第 1 层起 description 上限（码点）。 */
    nestedDescriptionChars: 60,
    /** 超过此深度的 description 直接丢弃。 */
    descriptionDepth: 1,
    /** 投影里工具 description 上限（码点）；0 = 关闭截断。 */
    maxDescriptionChars: 260,
    /** 联合类型分支上限，仅在 `truncateUnions: true` 时生效。 */
    maxBranches: 4,
    /** 本模块新增：`oneOf`/`anyOf`/`allOf` 默认不截断（《整合实现方案》§6.2）。 */
    truncateUnions: false,
    /** 丢弃编辑期注解（`examples` / `title` / `$comment` / ...）。 */
    dropAnnotations: true,
    /**
     * 只统计、不替换：照常计算，但返回原始 tools（排序仍由 `ordering.enabled`
     * 独立控制，见《变更说明》§4.3）。
     */
    dryRun: false,
  },
  /** 显式工具消隐，默认关；空名单永远不隐藏任何工具。 */
  visibility: { enabled: false, dryRun: false, exact: [], prefixes: [] },
  /**
   * 会话冻结（v0.4.0）：运行期配置按会话快照，改动从**下一个新会话**开始生效。
   * 依据是压缩/投影改前缀会击穿前缀缓存（总纲 §10.20）；会话中途换投影的
   * 重建成本远大于收益。`enabled: false` 退回旧行为（切开关立刻生效）。
   */
  freeze: { enabled: true },
  /** 确定性键排序（来自 cache-stabilizer）。 */
  ordering: {
    enabled: true,
    /** 排序递归上限，超限原样返回（防环）。 */
    maxDepth: 64,
    /** 排序后的长度自检：'length' | 'none'（基线是已瘦身列表，见 §4.1）。 */
    verify: 'length',
    /** 连续失败达到此数后本进程停用排序；<= 0 表示关闭熔断。 */
    circuitBreaker: 5,
  },
  debug: {
    /** 'warn' | 'info' | 'silent'。 */
    logLevel: 'warn',
    /** 同一 (reason, toolName) 只记一次。 */
    logOnce: true,
    /** 去重后的工具级日志条数上限。 */
    maxLoggedTools: 20,
  },
  /**
   * 持久化（0.7.0）：统计按对话落盘、精调存档与自动备份。
   * 关闭后停止新增统计与自动备份，已有存档仍会加载；「关掉」这次保存本身
   * 仍写进存档（否则重启又会自动打开）。目录固定 `$DSH_HOME/storages/dsh-rice-guard`，
   * 不做配置项：存档位置可配会引出「要读配置先知道配置在哪」的自举矛盾。
   */
  storage: {
    /** 是否把统计与精调存档写到磁盘。 */
    enabled: true,
    /** 精调自动备份保留份数；0 = 不备份（不建议）。 */
    maxBackups: 20,
  },
  /**
   * 省钱估算用的价表选择（只影响展示，不影响任何请求）。
   * 价表本体在 `src/pricing-data.js`（官方快照），运行时零网络。
   */
  pricing: {
    /** 官方在售模型之一；旧名（`deepseek-v4-flash` 等）会被 `resolveModel` 归并。 */
    model: 'deepseek-flash',
    /** 面板默认高亮时段；不参与任何自动判断（节假日表在 dsh-session-guard）。 */
    period: 'off-peak',
    /** 覆盖官方单价（元/百万 token）；三项都必须是有限正数，否则回退官方值。 */
    override: null,
  },
})

/**
 * 旧插件顶层扁平键 -> `truncation.*` 的映射。分组配置始终优先，扁平键只是
 * 迁移便利（§1.4.2）。顺序有意义：先落地的映射获胜，所以新名
 * `minSchemaChars` 必须排在旧名 `minChars` 前面。
 */
const LEGACY_FLAT_KEYS = Object.freeze([
  ['shadowPrefixes', 'shadowPrefixes'],
  ['keepFull', 'keepFull'],
  ['minSchemaChars', 'minSchemaChars'],
  ['minChars', 'minSchemaChars'],
  ['maxSchemaChars', 'maxSchemaChars'],
  ['maxDepth', 'maxDepth'],
  ['topDescriptionChars', 'topDescriptionChars'],
  ['nestedDescriptionChars', 'nestedDescriptionChars'],
  ['descriptionDepth', 'descriptionDepth'],
  ['maxDescriptionChars', 'maxDescriptionChars'],
  ['maxBranches', 'maxBranches'],
  ['truncateUnions', 'truncateUnions'],
  ['dropAnnotations', 'dropAnnotations'],
  ['dryRun', 'dryRun'],
])

/**
 * 规范化原始配置：未知键丢弃、非法值回退默认、数字 clamp、结果深度冻结。
 * 永不抛：敌意或损坏的 `raw` 直接得到一份默认值。
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  try {
    return normalizeConfigUnsafe(raw)
  } catch {
    return cloneDefaults()
  }
}

function normalizeConfigUnsafe(raw) {
  const source = isPlainObject(raw) ? raw : {}

  // 分组配置优先：先展开分组，再用扁平旧键补空缺（已有键不覆盖）。
  const truncationSource = { ...readGroup(source, 'truncation') }
  for (const [flatKey, groupKey] of LEGACY_FLAT_KEYS) {
    if (groupKey in truncationSource) continue
    const value = source[flatKey]
    if (value !== undefined) truncationSource[groupKey] = value
  }

  const orderingSource = { ...readGroup(source, 'ordering') }
  // 旧插件的顶层 `canonicalizeTools: false` 映射成排序总开关（§1.4.2）。
  if (!('enabled' in orderingSource) && typeof source.canonicalizeTools === 'boolean') {
    orderingSource.enabled = source.canonicalizeTools
  }

  const visibilitySource = { ...readGroup(source, 'visibility') }
  for (const [flat, key] of [['visibilityEnabled', 'enabled'], ['hiddenExact', 'exact'], ['hiddenPrefixes', 'prefixes']]) {
    if (!(key in visibilitySource) && source[flat] !== undefined) visibilitySource[key] = source[flat]
  }
  const visibility = {
    enabled: boolField(visibilitySource.enabled, DEFAULTS.visibility.enabled),
    dryRun: boolField(visibilitySource.dryRun, DEFAULTS.visibility.dryRun),
    exact: stringListField(visibilitySource.exact, DEFAULTS.visibility.exact),
    prefixes: stringListField(visibilitySource.prefixes, DEFAULTS.visibility.prefixes),
  }

  const debugSource = { ...readGroup(source, 'debug') }

  const truncation = {
    enabled: boolField(truncationSource.enabled, DEFAULTS.truncation.enabled),
    shadowPrefixes: stringListField(truncationSource.shadowPrefixes, DEFAULTS.truncation.shadowPrefixes),
    keepFull: stringListField(truncationSource.keepFull, DEFAULTS.truncation.keepFull),
    minSchemaChars: numberField('truncation', 'minSchemaChars', truncationSource.minSchemaChars),
    maxSchemaChars: numberField('truncation', 'maxSchemaChars', truncationSource.maxSchemaChars),
    maxDepth: numberField('truncation', 'maxDepth', truncationSource.maxDepth),
    topDescriptionChars: numberField('truncation', 'topDescriptionChars', truncationSource.topDescriptionChars),
    nestedDescriptionChars: numberField('truncation', 'nestedDescriptionChars', truncationSource.nestedDescriptionChars),
    descriptionDepth: numberField('truncation', 'descriptionDepth', truncationSource.descriptionDepth),
    maxDescriptionChars: numberField('truncation', 'maxDescriptionChars', truncationSource.maxDescriptionChars),
    maxBranches: numberField('truncation', 'maxBranches', truncationSource.maxBranches),
    truncateUnions: boolField(truncationSource.truncateUnions, DEFAULTS.truncation.truncateUnions),
    dropAnnotations: boolField(truncationSource.dropAnnotations, DEFAULTS.truncation.dropAnnotations),
    dryRun: boolField(truncationSource.dryRun, DEFAULTS.truncation.dryRun),
  }

  const ordering = {
    enabled: boolField(orderingSource.enabled, DEFAULTS.ordering.enabled),
    maxDepth: numberField('ordering', 'maxDepth', orderingSource.maxDepth),
    verify: verifyField(orderingSource.verify, DEFAULTS.ordering.verify),
    circuitBreaker: numberField('ordering', 'circuitBreaker', orderingSource.circuitBreaker),
  }

  const freeze = {
    enabled: boolField(readGroup(source, 'freeze').enabled, DEFAULTS.freeze.enabled),
  }

  const debug = {
    logLevel: logLevelField(debugSource.logLevel, DEFAULTS.debug.logLevel),
    logOnce: boolField(debugSource.logOnce, DEFAULTS.debug.logOnce),
    maxLoggedTools: numberField('debug', 'maxLoggedTools', debugSource.maxLoggedTools),
  }

  const pricingSource = { ...readGroup(source, 'pricing') }
  const pricing = {
    model: modelField(pricingSource.model, DEFAULTS.pricing.model),
    period: periodField(pricingSource.period, DEFAULTS.pricing.period),
    override: overrideField(pricingSource.override),
  }

  const storageSource = { ...readGroup(source, 'storage') }
  const storage = {
    enabled: boolField(storageSource.enabled, DEFAULTS.storage.enabled),
    maxBackups: numberField('storage', 'maxBackups', storageSource.maxBackups),
  }

  return deepFreeze({ truncation, visibility, ordering, freeze, debug, storage, pricing })
}

/** 模型名：非空字符串才采用；长度截到 120，防止配置里塞长文本。 */
function modelField(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed.slice(0, 120)
}

/** 时段：只接受 `off-peak` / `peak`，其余回退默认。 */
function periodField(value, fallback) {
  return value === 'off-peak' || value === 'peak' ? value : fallback
}

/** 覆盖价：要么 null，要么 `{ hit, miss, out }` 三项有限非负数；否则回退 null。 */
function overrideField(value) {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return null
  const numbers = ['hit', 'miss', 'out'].map((key) => value[key])
  if (!numbers.every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0)) return null
  const [hit, miss, out] = numbers
  return Object.freeze({ hit, miss, out })
}

function readGroup(source, key) {
  const value = source[key]
  return isPlainObject(value) ? value : {}
}

function numberField(group, key, value) {
  const fallback = DEFAULTS[group][key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const [min, max] = NUMBER_RULES[group][key]
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function boolField(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function verifyField(value, fallback) {
  return value === 'length' || value === 'none' ? value : fallback
}

function logLevelField(value, fallback) {
  return value === 'silent' || value === 'warn' || value === 'info' ? value : fallback
}

/**
 * 只保留非空字符串，保序、去重、封顶长度。空数组**故意保留**：
 * `shadowPrefixes: []` 表示「全部工具」，是旧插件写进文档的语义（§4.4）。
 */
function stringListField(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice()
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string' || item === '') continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= MAX_LIST_ENTRIES) break
  }
  // 非空数组里一个可用字符串都没有，是笔误。回退默认胜过把它当成
  // 「空 = 全部」——那会静默瘦身整个工具注册表（§1.4.2）。
  if (out.length === 0 && value.length > 0) return fallback.slice()
  return out
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Object.keys(value)) deepFreeze(value[key], seen)
  return Object.freeze(value)
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key])
    return out
  }
  return value
}

function cloneDefaults() {
  return deepFreeze(cloneValue(DEFAULTS))
}
