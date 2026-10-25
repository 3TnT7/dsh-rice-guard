/**
 * 职责
 *   把 JSON-like 值里的对象键排成确定顺序（“canonical” 形式），数组一律保序；
 *   可选做序列化长度自检。工具列表入口 `canonicalizeTools` 是 cache-pipeline
 *   阶段 B 的唯一调用点。
 *
 * 依赖的 DSH 契约（DSH 0.2.1-rc.2）
 *   - 无 DSH API：纯函数，不 import 任何包、不读文件/网络/环境；裸 `node --test` 可跑。
 *   - 输出必须能被 `JSON.stringify` 无损序列化：调用方把它放进模型请求的
 *     `tools` 投影，宿主按 lossless JSON 处理。
 *
 * 关键决策与依据
 *   - 键排序依据 RFC 8785（JSON Canonicalization Scheme）：成员名按 UTF-16 code unit
 *     升序排列（默认 `Array.prototype.sort()` 正是这个顺序，locale 无关）。
 *     **我们不是 JCS 合规实现**，差异是刻意的：
 *       · 丢弃值为 `undefined` 的键（与 `JSON.stringify` 的输出等价）；
 *       · 不做数字规范化（不处理 1e21 / -0 / 精度）；
 *       · 数组保持源顺序，不排序。
 *   - `undefined` / 序列化语义按 ECMA-262 `JSON.stringify`：对象里 `undefined` 被省略、
 *     数组里变 `null`、`-0` 变 `0`。本模块的 `jsonLength` 与输出都遵循同一语义。
 *   - `__proto__` 用 `Object.defineProperty` 写成自有数据属性：普通对象、`Object.keys`
 *     可见、`JSON.stringify` 正常输出，且不触发原型 setter（《整合实现方案》§6.3）。
 *   - `verify: 'length'` 只比较「入参列表」与「本函数产出的列表」，长度变化证明吃键。
 *     调用方必须传入「已瘦身」列表：瘦身省下的字节是预期收益，不是损坏（§4.1）。
 *   - 非 plain object 原样返回、超过 `maxDepth` 的值原样返回、环安全：宁可少排，
 *     不抛错、不破坏结构。
 *   - 行为来源：键排序思路源自 dsh-cache-stabilizer（MIT,
 *     Copyright (c) 2026 hfshfg；https://github.com/dongsheng123132/dsh-cache-stabilizer）。
 *     本实现已重写并修改（落点、verify 基线、`__proto__` 处理），不是逐行复制；
 *     差异见 NOTICE.md。
 *
 * 已知边界
 *   - 不是 RFC 8785 实现：数字不做规范化、字符串不保证 JCS 的转义形式；
 *     需要与外部 JCS 实现逐字节互操作时不能直接用本模块。
 *   - 排序按 UTF-16 code unit，不按 Unicode code point：BMP 之外字符的键序与
 *     「码点序」不同（RFC 8785 本身也是 UTF-16 code unit 序）。
 *   - `maxDepth` 之外不排序、非 plain object 不排序：输出仍是合法 JSON，
 *     但「确定性」只对实际排到的层级成立。
 *   - 带 `toJSON` / getter 的输入可能让长度自检不稳定；此时按 `length-mismatch`
 *     或 `threw` 拒绝，调用方保留自己的列表。
 *   - `jsonLength` 用的是 `String.length`（UTF-16 单元），不是 UTF-8 字节数；
 *     DeepSeek 按 token 计费，这里只用于「同输入同输出」的相对比较。
 */

/** 默认递归上限与自检开关，与 dsh-cache-stabilizer 的默认值一致（见 NOTICE.md）。 */
export const DEFAULT_LIMITS = Object.freeze({ maxDepth: 64, verify: 'length' })

/**
 * 只认 `Object.prototype` / `null` 原型：Date、Map、class 实例一律不排序，
 * 避免把非 JSON 结构的内部状态复制出来。
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * `JSON.stringify(value).length`；无法序列化时返回 -1（BigInt、环等）。
 * 长度按 UTF-16 单元计，只用于同一进程内「同输入同输出」的相对比较。
 * 导出给 slim 模块做同一把尺子的测量，也给确定性测试用。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function jsonLength(value) {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : -1
  } catch {
    return -1
  }
}

/**
 * 返回键序确定的等价 JSON-like 值。永不抛：内部异常时原样返回入参。
 *
 * @param {unknown} value
 * @param {{ maxDepth?: number, verify?: 'length' | 'none' }} [limits]
 * @returns {unknown}
 */
export function canonicalizeValue(value, limits) {
  const resolved = resolveLimits(limits)
  try {
    return walk(value, { maxDepth: resolved.maxDepth, seen: new Set(), protoKeysSeen: 0 }, 0)
  } catch {
    return value
  }
}

/**
 * 对列表里每个 plain-object 工具做键排序，列表顺序不动、畸形元素原样保留。
 *
 * `tools` 同时是长度自检的基线：必须传「你真正想排序的列表」（cache-pipeline v2
 * 传的是已瘦身的投影）。长度变了说明有键被吃掉，不是上一阶段省了字节。
 *
 * @param {unknown} tools
 * @param {{ maxDepth?: number, verify?: 'length' | 'none' }} [limits]
 * @returns {{ tools?: unknown[], changed: boolean, reason?: string, protoKeysSeen: number }}
 */
export function canonicalizeTools(tools, limits) {
  const resolved = resolveLimits(limits)
  if (!Array.isArray(tools)) {
    return { changed: false, reason: 'not-array', protoKeysSeen: 0 }
  }

  try {
    const ctx = { maxDepth: resolved.maxDepth, seen: new Set(), protoKeysSeen: 0 }
    // 数组保序：工具列表顺序由 core 的 `orderTools` 决定，这里只逐个处理元素。
    const next = tools.map((tool) => (isPlainObject(tool) ? walk(tool, ctx, 0) : tool))

    if (resolved.verify === 'length') {
      const before = jsonLength(tools)
      const after = jsonLength(next)
      // 任何一侧不可序列化、或长度不等，都视为「可能吃键」：拒绝整份结果。
      if (before < 0 || after < 0 || before !== after) {
        return { changed: false, reason: 'length-mismatch', protoKeysSeen: ctx.protoKeysSeen }
      }
    }

    return { tools: next, changed: true, protoKeysSeen: ctx.protoKeysSeen }
  } catch {
    return { changed: false, reason: 'threw', protoKeysSeen: 0 }
  }
}

function resolveLimits(limits) {
  const source = isPlainObject(limits) ? limits : {}
  const maxDepth = Number.isFinite(source.maxDepth)
    ? Math.max(0, Math.trunc(source.maxDepth))
    : DEFAULT_LIMITS.maxDepth
  // 只有明确写 'none' 才关自检；其它值（含 undefined）一律回到默认 'length'。
  const verify = source.verify === 'none' ? 'none' : 'length'
  return { maxDepth, verify }
}

function walk(value, ctx, depth) {
  // 数组一律 map 重建、不重排：`required` / `enum` / `oneOf` / `prefixItems`
  // 的顺序有语义，排了会改变模型的选择倾向（RFC 8785 也只规范对象成员）。
  if (Array.isArray(value)) return value.map((item) => walk(item, ctx, depth))
  if (!isPlainObject(value)) return value
  if (depth > ctx.maxDepth) return value
  if (ctx.seen.has(value)) return value

  ctx.seen.add(value)
  const out = {}
  // 默认 `Array.prototype.sort()`：UTF-16 code unit 序，locale 无关。
  // 这正是 RFC 8785 §3.2.3 的成员名顺序规则；不用 `localeCompare`。
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    // ECMA-262 `JSON.stringify` 对对象里值为 undefined 的键直接省略；
    // 这里提前跳过，保证输出与 `JSON.stringify` 的字节一致。
    if (item === undefined) continue
    const next = walk(item, ctx, depth + 1)
    if (key === '__proto__') {
      ctx.protoKeysSeen += 1
      // 定义普通对象上的自有数据属性：不触发原型 setter、`Object.keys` 可见、
      // `JSON.stringify` 正常输出，也不会把无原型对象带到下游（《整合实现方案》§6.3）。
      Object.defineProperty(out, key, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    } else {
      out[key] = next
    }
  }
  ctx.seen.delete(value)
  return out
}
