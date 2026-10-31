/**
 * 职责
 *   对单个工具的 `parameters` JSON Schema 做一次确定性瘦身：删注解、按深度截
 *   description、遍历 schema 关键字、在预算内选候选、必要时收紧到 skeleton，
 *   最后用 `selfcheck` 兜底。
 *
 * 依赖的 DSH 契约（DSH 0.2.1-rc.2）
 *   - 无 DSH API：纯函数，只 import 同目录纯函数，不读文件/网络/环境。
 *   - 产物要满足宿主对工具 `parameters` 的要求：对象根、可调用、无损 JSON 可序列化。
 *     宿主只校验「parameters 是 lossless JSON」，schema 子集合法性由本模块的
 *     `selfcheck` 负责，不能指望 core 拦。
 *
 * 关键决策与依据
 *   - 注解丢弃依据 JSON Schema 2020-12 的 annotation 概念：`title`、`examples`、
 *     `deprecated`、`readOnly`、`writeOnly` 可删；`$comment` 是可丢弃的 core 注释，
 *     不属于 annotation。`description` 单独截断，`default` 保持不删。
 *   - `$anchor` / `$id` / `$schema` 不是注解，不进入删除集合：2020-12 Core
 *     §8.2.2 定义锚点，§8.2.1 定义资源标识与相对 `$ref` 的解析基准，§8.1.1
 *     用 `$schema` 声明方言/元 schema；删掉它们可能改变引用解析或关键字语义。
 *     普通遍历原样保留；skeleton / collapse 的整块替换仍有下述引用边界。
 *   - `prefixItems` 永不截断：元组按位置约束参数，删尾部会丢掉第 N 个参数的类型。
 *     skeleton 分别保留 `prefixItems` 与 `items`：2020-12 中后者约束前缀之外的元素，
 *     两者可共存，不是互斥的数组表示。
 *   - 联合类型默认不截断（`truncateUnions: false`）：截分支省几十字节，却可能让
 *     模型按被删分支组织参数；打开时硬下限 2（《整合实现方案》§6.2）。
 *   - `required` 修剪到仍存在于 `properties` 的名字：坍缩/删键后若不修剪，schema
 *     会要求一个不存在的字段。
 *   - 预算循环从 `maxDepth` 高到低试，取第一个 ≤ `maxSchemaChars` 的候选；
 *     都超预算时用 `skeletonRoot`（顶层名字 + 粗类型 + **最小调用约束**）。
 *   - 只有严格更小且 `selfcheck` 通过才采用，否则返回 `undefined` 让调用方保留原值。
 *   - 深度坍缩成 `{ type: 'object', additionalProperties: true }` 是接受的旧风险：
 *     严格 provider 可能 400，等真实证据再改（《变更说明》§5.1 R3）。
 *   - **最小调用约束优先于预算（0.6.0）**：skeleton / collapse 这两条整块替换节点的
 *     路径不再静默丢 `enum` / `items`，而是保留最小约束；代价是候选可能超
 *     `maxSchemaChars`（该值本来就不是硬上限，见《007》§3.1），最坏由「严格变小」
 *     检查退回原 schema。依据：`enum` 被删会让模型发明非法取值，`items` 被删会让
 *     字符串数组/对象数组填错（《007》§3.3）。两条路径都给数组元素保留一层
 *     对象字段与 `required`，collapse 仍不恢复被坍缩对象自身的字段。
 *   - 行为与默认值源自 dsh-cache-saver（MIT,
 *     Copyright (c) 2026 dsh-cache-saver contributors；
 *     https://github.com/ium9khbep8834-maker/dsh-cache-saver）。
 *     本实现已重写并修改，不是逐行复制；差异见 NOTICE.md。
 *
 * 已知边界
 *   - skeleton / collapse 现在保留 `enum` 全集与 `items` 最小结构，但**不保留**
 *     `$ref` / 组合分支 / 复杂对象元素的深层字段；这些无法安全简化，不做猜测式重写。
 *   - 坍缩把 `additionalProperties: false` 放宽成 `true`，模型可能编造字段（R3）。
 *   - 只做一次遍历，不证明语义等价；`selfcheck` 只保证形状与 JSON 合法性。
 *   - `not` / `if` / `then` 等条件 schema 只递归、不做逻辑改写。
 *   - 旧草案的数组式 `items`（非对象、非布尔）仍按非法 schema 丢弃，不尝试修复。
 */

import { truncateDescription } from './truncate.js'
import { isPlainObject, jsonLength } from './canonical.js'

/**
 * 规则默认值，与 `DEFAULTS.truncation` 中 slim 用到的字段一一对应；
 * 改一处必须同步另一处，否则「配置默认值」与「直接调用默认值」会漂移。
 */
export const SLIM_RULE_DEFAULTS = Object.freeze({
  minSchemaChars: 700,
  maxSchemaChars: 800,
  maxDepth: 3,
  topDescriptionChars: 140,
  nestedDescriptionChars: 60,
  descriptionDepth: 1,
  maxDescriptionChars: 260,
  maxBranches: 4,
  truncateUnions: false,
  dropAnnotations: true,
})

/**
 * 可丢弃的注解与注释：`$comment` 属 core 注释，不是 annotation。
 * `example`（单数）不是标准关键字，但旧插件也删，保持一致。
 * `description` 单独截断（不在本集合）；`default` 不在删除集合里（见文件头）。
 */
const ANNOTATION_KEYS = new Set([
  'examples',
  'example',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
  'title',
])

/** 值是一组「名字 -> 子 schema」的映射关键字。 */
const MAP_SCHEMA_KEYS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas'])

/** 值是单个子 schema（或布尔 schema）的关键字。 */
const SINGLE_SCHEMA_KEYS = new Set([
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
])

/** 值是子 schema 数组、且分支顺序无位置语义的关键字（可截断，默认不截）。 */
const UNION_SCHEMA_KEYS = new Set(['oneOf', 'anyOf', 'allOf'])

/**
 * 瘦身单个工具的 `parameters`。
 *
 * 返回 `undefined` 表示保留原值：不是 plain object、根不是可调用对象 schema、
 * 小于 `minSchemaChars`、瘦身后没有严格变小、或 `selfcheck` 拒绝。
 *
 * @param {unknown} parameters
 * @param {Partial<typeof SLIM_RULE_DEFAULTS>} [rules]
 * @param {{ onReject?: (reason: 'invalid' | 'root' | 'small' | 'not-smaller' | 'selfcheck') => void }} [options]
 *   可选的拒绝回调（pipeline 用它做统计；测试通常不传）。
 * @returns {{ parameters: Record<string, unknown>, charsBefore: number, charsAfter: number, collapsedNodes: number, droppedDescriptionKeys: number } | undefined}
 */
export function slimParameters(parameters, rules, options) {
  try {
    return slimUnsafe(parameters, resolveRules(rules), isPlainObject(options) ? options : {})
  } catch {
    // 瘦身失败只能退回原值，绝不能让异常冒进 assemble（§4.5 失败隔离）。
    return undefined
  }
}

function slimUnsafe(parameters, rules, options) {
  if (!isPlainObject(parameters)) return reject(options, 'invalid')
  if (!hasCallableRoot(parameters)) return reject(options, 'root')

  const before = jsonLength(parameters)
  if (before < 0) return reject(options, 'invalid')
  // 小 schema 不值得动：省不了多少字节，还增加模型看到不一致定义的面。
  if (before < rules.minSchemaChars) return reject(options, 'small')

  let chosen
  let chosenStats
  // 从高到低试深度：先尽量保留结构，超预算再收紧，直到满足 maxSchemaChars。
  for (let depth = rules.maxDepth; depth >= 0; depth -= 1) {
    const attemptStats = newSlimStats()
    const candidate = normalizeRoot(walk(parameters, 0, { ...rules, maxDepth: depth }, attemptStats))
    const size = jsonLength(candidate)
    if (size >= 0 && size <= rules.maxSchemaChars) {
      chosen = candidate
      chosenStats = attemptStats
      break
    }
  }

  if (chosen === undefined) {
    // 所有深度都超预算：退到顶层名字 + 粗类型 + 最小调用约束的 skeleton。
    chosenStats = newSlimStats()
    chosen = skeletonRoot(parameters, rules, chosenStats)
  }

  // 只有严格更小才采用；否则不如保留完整定义（§3.5 的 not-smaller）。
  const after = jsonLength(chosen)
  if (after < 0 || after >= before) return reject(options, 'not-smaller')
  // 形状/JSON 合法性兜底：不通过就不采用，调用方保留原值。
  if (!selfcheck(chosen)) return reject(options, 'selfcheck')

  return {
    parameters: chosen,
    charsBefore: before,
    charsAfter: after,
    collapsedNodes: chosenStats.collapsedNodes,
    droppedDescriptionKeys: chosenStats.droppedDescriptionKeys,
    enumsKept: chosenStats.enumsKept,
    itemsKept: chosenStats.itemsKept,
    // 保留约束后仍超 maxSchemaChars = 语义优先于预算的有意超界，单独计数。
    overBudget: after > rules.maxSchemaChars,
  }
}

function newSlimStats() {
  return { collapsedNodes: 0, droppedDescriptionKeys: 0, enumsKept: 0, itemsKept: 0 }
}

function reject(options, reason) {
  try {
    if (typeof options.onReject === 'function') options.onReject(reason)
  } catch {
    /* 诊断回调不能改变决定 */
  }
  return undefined
}

function resolveRules(rules) {
  const source = isPlainObject(rules) ? rules : {}
  // 越界值 clamp、非数字回退默认；区间与 config.js 的 NUMBER_RULES 一致。
  return {
    minSchemaChars: bound(source.minSchemaChars, 0, 1_000_000, SLIM_RULE_DEFAULTS.minSchemaChars),
    maxSchemaChars: bound(source.maxSchemaChars, 200, 1_000_000, SLIM_RULE_DEFAULTS.maxSchemaChars),
    maxDepth: bound(source.maxDepth, 0, 6, SLIM_RULE_DEFAULTS.maxDepth),
    topDescriptionChars: bound(source.topDescriptionChars, 0, 4000, SLIM_RULE_DEFAULTS.topDescriptionChars),
    nestedDescriptionChars: bound(
      source.nestedDescriptionChars,
      0,
      4000,
      SLIM_RULE_DEFAULTS.nestedDescriptionChars,
    ),
    descriptionDepth: bound(source.descriptionDepth, 0, 6, SLIM_RULE_DEFAULTS.descriptionDepth),
    maxDescriptionChars: bound(source.maxDescriptionChars, 0, 8000, SLIM_RULE_DEFAULTS.maxDescriptionChars),
    maxBranches: bound(source.maxBranches, 1, 64, SLIM_RULE_DEFAULTS.maxBranches),
    truncateUnions: source.truncateUnions === true,
    dropAnnotations: source.dropAnnotations !== false,
  }
}

function bound(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 根必须仍是可调用的对象 schema。布尔 schema、`type: 'array'`、坏掉的 `properties`
 * 一律不动：把它们改写成模型无法调用的形状，比不瘦身更糟。
 */
function hasCallableRoot(parameters) {
  if (parameters.type !== undefined && parameters.type !== 'object') return false
  if (parameters.properties !== undefined && !isPlainObject(parameters.properties)) return false
  return true
}

/** 保证根是对象 schema（旧行为），不改变已有形状；缺的键才补。 */
function normalizeRoot(schema) {
  const out = { ...schema }
  out.type = 'object'
  if (out.properties === undefined) out.properties = {}
  if (out.additionalProperties === undefined) out.additionalProperties = false
  return out
}

/**
 * 最后手段：只保留顶层参数名 + 粗类型 + **最小调用约束**。
 * 0.6.0 起 `enum` / `items` 不再被静默丢掉（《007》§3.3）：保留枚举全集、
 * 数组元素的最小类型/枚举、对象元素一层字段与 required；预算让位于语义，
 * 最终仍由「严格变小」检查兜底。`required` 按新 `properties` 修剪，保证自洽。
 */
function skeletonRoot(parameters, rules, stats) {
  const sourceProperties = isPlainObject(parameters.properties) ? parameters.properties : {}
  const properties = {}
  for (const name of Object.keys(sourceProperties)) {
    const child = sourceProperties[name]
    if (typeof child === 'boolean') {
      setKey(properties, name, child)
      continue
    }
    // 顶层参数给两层：数组元素（items）还能再保留一层对象字段。
    const minimal = minimalConstraint(child, 2, stats)
    setKey(properties, name, minimal === undefined ? { type: 'string' } : minimal)
  }

  const out = { type: 'object', properties, additionalProperties: false }

  if (typeof parameters.description === 'string' && rules.topDescriptionChars > 0) {
    const text = truncateDescription(parameters.description, rules.topDescriptionChars).text
    if (text !== '') out.description = text
  }

  if (Array.isArray(parameters.required)) {
    const names = Object.keys(properties)
    const required = parameters.required.filter(
      (name) => typeof name === 'string' && names.includes(name),
    )
    if (required.length > 0) out.required = required
  }

  return out
}

/**
 * 最小调用约束：`type` + `enum` 全集 + `items`（元素类型/枚举；对象元素再保留
 * 一层字段与 `required`） + `prefixItems` 各位置的最小类型（保序，不截尾）。
 * 只用于 skeleton / collapse 这两条整块替换节点的路径；不猜测 `$ref` / 组合分支。
 *
 * @param {unknown} node
 * @param {number} depth 还可以向下展开几层（0 = 只保留本节点）
 * @param {{ enumsKept: number, itemsKept: number }} stats
 * @param {Set<object>} [seen] 防环
 * @returns {object|boolean|undefined}
 */
function minimalConstraint(node, depth, stats, seen = new Set()) {
  if (typeof node === 'boolean') return node
  if (!isPlainObject(node) || stats === undefined) return undefined
  if (seen.has(node)) return undefined
  seen.add(node)
  try {
    const declared = typeof node.type === 'string' ? node.type : undefined
    const arrayish = node.items !== undefined || Array.isArray(node.prefixItems)
    const type = declared ?? (isPlainObject(node.properties) ? 'object' : arrayish ? 'array' : undefined)

    const out = {}
    if (type !== undefined) out.type = type

    if (Array.isArray(node.enum) && node.enum.length > 0) {
      setKey(out, 'enum', node.enum.slice())
      stats.enumsKept += 1
    }

    if (node.items !== undefined) {
      const items = minimalConstraint(node.items, depth - 1, stats, seen)
      if (items !== undefined) {
        setKey(out, 'items', items)
        stats.itemsKept += 1
      }
    }
    if (Array.isArray(node.prefixItems) && node.prefixItems.length > 0 && depth > 0) {
      // 与 items 独立：prefixItems 约束前缀，items 约束剩余元素；保序不截尾（§6.2）。
      setKey(out, 'prefixItems', node.prefixItems.map((entry) => minimalConstraint(entry, 0, stats, seen) ?? {}))
      stats.itemsKept += 1
    }

    if (type === 'object' && depth > 0 && isPlainObject(node.properties)) {
      const properties = {}
      for (const name of Object.keys(node.properties)) {
        const child = node.properties[name]
        const minimal = minimalConstraint(child, depth - 1, stats, seen)
        setKey(properties, name, minimal === undefined ? { type: 'string' } : minimal)
      }
      setKey(out, 'properties', properties)
      if (Array.isArray(node.required)) {
        const required = node.required.filter(
          (name) => typeof name === 'string' && Object.hasOwn(properties, name),
        )
        if (required.length > 0) out.required = required
      }
    }

    return out
  } finally {
    seen.delete(node)
  }
}

/**
 * 对 `depth` 处的一个 schema 节点做一次压缩。
 * `stats` 只累计本次候选的诊断，供选中的那次回传。
 */
function walk(node, depth, settings, stats) {
  if (Array.isArray(node)) return node.map((item) => walk(item, depth, settings, stats))
  if (!isPlainObject(node)) return node
  // 超深节点坍缩成可调用 stub，保住「是个对象」这个最小信息（R3 的已知风险）。
  if (depth > settings.maxDepth) return collapse(node, settings, stats)

  const out = {}
  const notes = []

  for (const key of Object.keys(node)) {
    const value = node[key]

    // 注解不参与校验，直接删（JSON Schema 2020-12 的 annotation 概念）。
    if (ANNOTATION_KEYS.has(key)) {
      if (settings.dropAnnotations) continue
      setKey(out, key, value)
      continue
    }

    if (key === 'description') {
      // 根层用 topDescriptionChars；深度 1..descriptionDepth 用 nestedDescriptionChars；
      // 更深直接丢弃（descriptionDepth 默认 1）。
      const limit =
        depth === 0
          ? settings.topDescriptionChars
          : depth <= settings.descriptionDepth
            ? settings.nestedDescriptionChars
            : -1
      const text = limit > 0 ? truncateDescription(value, limit).text : ''
      if (text !== '') out.description = text
      else stats.droppedDescriptionKeys += 1
      continue
    }

    if (MAP_SCHEMA_KEYS.has(key)) {
      if (!isPlainObject(value)) continue
      const mapped = {}
      for (const name of Object.keys(value)) {
        setKey(mapped, name, walk(value[name], depth + 1, settings, stats))
      }
      setKey(out, key, mapped)
      continue
    }

    if (SINGLE_SCHEMA_KEYS.has(key)) {
      // 布尔 schema 是合法 JSON Schema，原样保留；对象才递归。
      if (typeof value === 'boolean') {
        setKey(out, key, value)
        continue
      }
      if (isPlainObject(value)) {
        setKey(out, key, walk(value, depth + 1, settings, stats))
      }
      continue
    }

    if (key === 'prefixItems') {
      // 元组按位置约束参数：截尾部会丢掉第 N 个参数的类型，所以永不截断（§6.2）。
      if (Array.isArray(value)) {
        setKey(out, key, value.map((entry) => walk(entry, depth + 1, settings, stats)))
      }
      continue
    }

    if (UNION_SCHEMA_KEYS.has(key)) {
      if (!Array.isArray(value)) continue
      let branches = value.map((branch) => walk(branch, depth + 1, settings, stats))
      // 默认 false；打开时也绝不允许只剩 0/1 个分支（硬下限 2，§6.2）。
      if (settings.truncateUnions && branches.length > settings.maxBranches) {
        const keep = Math.max(2, settings.maxBranches)
        branches = branches.slice(0, keep)
        notes.push('variants truncated')
      }
      setKey(out, key, branches)
      continue
    }

    if (key === 'required') {
      if (Array.isArray(value)) out.required = value.filter((item) => typeof item === 'string')
      continue
    }

    setKey(out, key, value)
  }

  // required 必须指向仍存在的 properties：坍缩/删键后不修剪，schema 会要求
  // 一个不存在的字段，模型永远无法满足。
  if (Array.isArray(out.required)) {
    const names = isPlainObject(out.properties) ? Object.keys(out.properties) : []
    out.required = out.required.filter((name) => names.includes(name))
    if (out.required.length === 0) delete out.required
  }

  if (notes.length > 0) {
    // 分支被截断时在 description 里留一句提示，避免模型以为只有这些分支。
    const note = notes.join('; ')
    const prior = typeof out.description === 'string' ? out.description : ''
    out.description = prior === '' ? `(${note})` : `${prior} (${note})`
  }

  return out
}

/**
 * 把超深节点坍缩成可调用 stub。对象放宽成 `additionalProperties: true` 是
 * 已知语义风险（§5.1 R3）。0.6.0 起 `enum`（全集，不再限 ≤12）与 `items`
 * 的最小型通过 `minimalConstraint` 保留，避免把受约束参数静默放宽。
 */
function collapse(node, settings, stats) {
  stats.collapsedNodes += 1
  const declared = typeof node.type === 'string' ? node.type : undefined
  const kind = declared ?? (isPlainObject(node.properties) ? 'object' : undefined)

  let out
  if (kind === 'object') out = { type: 'object', additionalProperties: true }
  else if (kind) out = { type: kind } // additionalProperties 只对 object 有意义
  else out = { type: 'object', additionalProperties: true }

  const description =
    typeof node.description === 'string' && settings.nestedDescriptionChars > 0
      ? truncateDescription(node.description, settings.nestedDescriptionChars).text
      : ''
  out.description = description === '' ? 'Nested fields omitted by rice-guard.' : `${description} (nested fields omitted)`

  // 两层预算：items 元素再保留一层对象字段与 required；不复制本节点的 properties。
  const minimal = minimalConstraint(node, 2, stats)
  if (isPlainObject(minimal)) {
    if (minimal.enum !== undefined) out.enum = minimal.enum
    if (minimal.items !== undefined) out.items = minimal.items
  }
  return out
}

/**
 * 产物自检：宿主只校验 `output.schema` 与「parameters 是 lossless JSON」，
 * 瘦身结果的 schema 形状由我们自己负责（§3.5）。
 *
 * @param {unknown} schema
 * @returns {boolean}
 */
export function selfcheck(schema) {
  if (!isPlainObject(schema)) return false
  if (schema.type !== undefined && schema.type !== 'object') return false
  if (!isPlainObject(schema.properties)) return false
  if (!propertySubschemasOk(schema.properties)) return false

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) return false
    const names = Object.keys(schema.properties)
    for (const name of schema.required) {
      if (typeof name !== 'string' || !names.includes(name)) return false
    }
  }

  if (!jsonValuesOk(schema, new Set())) return false
  return roundTripOk(schema)
}

/** `properties` 的每个值都必须是 plain-object 或布尔子 schema，递归检查。 */
function propertySubschemasOk(properties, seen = new Set()) {
  if (!isPlainObject(properties)) return false
  for (const name of Object.keys(properties)) {
    const child = properties[name]
    if (typeof child === 'boolean') continue
    if (!isPlainObject(child)) return false
    if (seen.has(child)) continue
    seen.add(child)
    if (child.properties !== undefined && !propertySubschemasOk(child.properties, seen)) return false
    seen.delete(child)
  }
  return true
}

/** 拒绝 undefined / function / symbol / bigint / 非有限数字 / 环。 */
function jsonValuesOk(value, seen) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (type !== 'object') return false
  if (seen.has(value)) return false

  seen.add(value)
  let ok = true
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!jsonValuesOk(item, seen)) {
        ok = false
        break
      }
    }
  } else {
    for (const key of Object.keys(value)) {
      if (!jsonValuesOk(value[key], seen)) {
        ok = false
        break
      }
    }
  }
  seen.delete(value)
  return ok
}

/** 序列化冒烟测试：`JSON.stringify` 不抛，且 parse 再 stringify 字节一致。 */
function roundTripOk(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return false
  }
  if (typeof text !== 'string') return false
  try {
    return JSON.stringify(JSON.parse(text)) === text
  } catch {
    return false
  }
}

/**
 * 赋值自有数据属性。`__proto__` 例外：普通赋值会命中原型访问器并静默丢键，
 * 必须用 `defineProperty`（《整合实现方案》§6.3）。
 */
function setKey(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  } else {
    target[key] = value
  }
}
