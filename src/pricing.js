/**
 * 职责
 *   DeepSeek 官方价表的「解析 + 查询 + 估算」纯函数层：
 *   ① 解析定价页（只给维护脚本与测试用，运行时不会被调用）；
 *   ② 把本地模型名映射到官方条目；
 *   ③ 用「省下的 token」按官价算钱（峰/谷 × 缓存命中/未命中 四个数）；
 *   ④ 产出 `inspect()` 里的 `pricing` 快照。
 *
 * 依赖的 DSH 契约
 *   - 无 DSH API：纯函数、零 import 外部依赖、不读时间（`isPeakAt` 的入参由调用方给）、
 *     不发网络、不写文件。
 *   - 运行时要的价表来自 `./pricing-data.js`（快照）；本文件不抓网页。
 *
 * 关键决策与依据
 *   - 价格页的读取与解析逻辑**改编自** dsh-token-use@0.3.4（MIT，Copyright (c) huangyuheng）
 *     的 `lib/pricing.js`：同样是「取第一张 table → 按 rowspan 语义继承字段名 →
 *     按 `空闲时段/高峰时段` 分档 → 取每行最后 N 列作价」。本实现已重写：改为返回
 *     `null` 而不是抛错、峰谷时段用整句兜底解析、不维护快照历史、不联网。
 *     见 NOTICE.md。
 *   - **运行时绝不联网**：抓页面只在 `scripts/update-pricing.mjs` 里做（维护者手动跑），
 *     抓完生成 `pricing-data.js`。这样插件本身仍然「零依赖、不发网络请求」。
 *   - 省钱必须给四个数：峰时/谷时、缓存命中/未命中各成一档，单价不同；只报
 *     一个数一定是误导。`savingsOf` 因此返回 `{off:{hit,miss},peak:{hit,miss}}`。
 *   - 峰谷判断**不含中国法定节假日**：假日表在 dsh-session-guard，本插件不重复维护；
 *     面板只让用户选「谷时/峰时」，不自动按钟点切（《竞品对比》§5-2：配置与口径都要
 *     单一事实源）。
 *   - 未定价（模型不在官方表里）返回 `status: 'unmatched'`，不猜价格。
 *
 * 已知边界
 *   - 官方改版可能导致解析失败：`parsePricingDocument` 会返回 `null`，脚本据此退出，
 *     不会写出半份价表；此时运行时继续用 `pricing-data.js` 里的旧快照。
 *   - 只解析「第一张 table」。官方页目前只有一张价格表；出现第二张时必须回到这里改。
 *   - `savingsOf` 是「token × 官价」的替代口径，不是账单（provider 按 usage 计费）。
 */

import {
  PRICING_AS_OF,
  PRICING_CURRENCY,
  PRICING_MODELS,
  PRICING_PEAK,
  PRICING_SOURCE,
} from './pricing-data.js'

/** HTML 实体白名单；未知实体原样保留，避免把正常文本改坏。 */
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })

/** 默认高峰窗口的深拷贝（避免调用方改到冻结常量）。 */
function defaultPeak() {
  return { days: [...PRICING_PEAK.days], hoursUtc: PRICING_PEAK.hoursUtc.map((range) => [...range]) }
}

/** 把一段 HTML 变成纯文本：去脚本/样式/标签，解实体，压空白。 */
export function textOf(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === '#') {
        const code = entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
      }
      return ENTITIES[entity.toLowerCase()] ?? match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** 文本里第一个数（容忍千分位逗号与货币符号）；没有则 undefined。 */
export function numberIn(text) {
  const match = /-?\d+(?:\.\d+)?/.exec(String(text ?? '').replace(/,/g, ''))
  if (match === null) return undefined
  const value = Number(match[0])
  return Number.isFinite(value) ? value : undefined
}

/**
 * 从一句时段描述里抠出 `[from, to)` 的 UTC 小时区间。
 * @param {string} clause 例如 `9:00 - 12:00、14:00 - 18:00`
 * @param {number} shift 本地时区相对 UTC 的小时偏移（北京时间 −8 → 传 8）
 */
export function hourRanges(clause, shift) {
  const ranges = []
  for (const match of String(clause ?? '').matchAll(/(\d{1,2}):(\d{2})\s*[-–~至]\s*(\d{1,2}):(\d{2})/g)) {
    const from = (Number(match[1]) - shift + 24) % 24
    const to = (Number(match[3]) - shift + 24) % 24
    if (!(to > from)) continue
    ranges.push([from, to])
  }
  return ranges
}

/**
 * 解析官方的峰谷时段：先看英文 `Peak hours are …`，再看中文含「高峰时段」的整句。
 * @returns {{days: number[], hoursUtc: number[][]} | undefined}
 */
export function parsePeakWindow(pageText) {
  const text = String(pageText ?? '')
  // 英文页：`Peak hours are 09:00–12:00 and 14:00–18:00 Beijing time, Monday through Friday.`
  for (const match of text.matchAll(/Peak hours are ([^.]+)/gi)) {
    const hoursUtc = hourRanges(match[1], 0)
    if (hoursUtc.length > 0) {
      return { days: /Monday\s+through\s+Friday/i.test(match[1]) ? [1, 2, 3, 4, 5] : [], hoursUtc }
    }
  }
  // 中文页：时段描述在脚注句里。注意「高峰时段」在价格表里也会出现（无时间区间），
  // 所以要遍历所有候选句，取第一句真的含 `9:00-12:00` 这种区间的。
  for (const match of text.matchAll(/([^。；]{0,120}高峰时段[^。；]{0,120})/g)) {
    const clause = match[1]
    const hoursUtc = hourRanges(clause, 8)
    if (hoursUtc.length > 0) {
      return { days: /周一至周五/.test(clause) ? [1, 2, 3, 4, 5] : [], hoursUtc }
    }
  }
  return undefined
}

/**
 * 解析官方定价页。**永不抛**：任何结构问题都返回 `null`。
 *
 * @param {string} html 页面 HTML
 * @param {{ currency?: 'CNY'|'USD', source?: string }} [options]
 * @returns {{ currency: string, source: string, peak: object, peakParsed: boolean, models: object[] } | null}
 */
export function parsePricingDocument(html, options = {}) {
  try {
    const pageText = textOf(html)
    const table = /<table[\s\S]*?<\/table>/i.exec(String(html ?? ''))
    if (table === null) return null
    const rows = table[0]
      .split(/<tr[^>]*>/i)
      .slice(1)
      .map((row) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => textOf(cell[1])))
    const header = rows.find((cells) => /^(MODEL|模型)$/i.test(String(cells[0] ?? '').trim()))
    if (header === undefined) return null
    const ids = header.slice(1)
      .map((cell) => String(cell).replace(/\(\d+\)/g, '').trim())
      .filter((id) => id.length > 0)
    if (ids.length === 0) return null
    const versionRow = rows.find((cells) => /^(MODEL VERSION|模型版本)$/i.test(String(cells[0] ?? '').trim()))
    const labels = versionRow === undefined ? [] : versionRow.slice(1).map((label) => String(label).trim())
    const models = ids.map((id, index) => ({ id, label: labels[index] ?? id, hit: {}, miss: {}, out: {} }))

    // 官方表格用 rowspan 合并「字段名」列：只有每组第一行写「缓存命中/未命中/输出」，
    // 后续行沿用上一行的字段名；`tier` 每行都写。
    let field
    for (const cells of rows) {
      const joined = cells.join(' ')
      const tier = /OFF-?\s?PEAK|空闲时段/i.test(joined) ? 'off'
        : /PEAK|高峰时段/i.test(joined) ? 'peak'
          : undefined
      if (tier === undefined) continue
      if (/CACHE\s+MISS|缓存未命中/i.test(joined)) field = 'miss'
      else if (/CACHE\s+HIT|缓存命中/i.test(joined)) field = 'hit'
      else if (/OUTPUT|输出/i.test(joined)) field = 'out'
      if (field === undefined) continue
      const values = cells.slice(cells.length - ids.length).map(numberIn)
      if (values.length !== ids.length || values.some((value) => value === undefined)) continue
      values.forEach((value, index) => {
        models[index][field][tier] = value
      })
    }

    const complete = models.filter((model) => ['hit', 'miss', 'out'].every((key) =>
      typeof model[key].off === 'number' && typeof model[key].peak === 'number'))
    if (complete.length === 0) return null

    const currency = options.currency === 'USD' || pageText.includes('$') ? 'USD' : 'CNY'
    const peak = parsePeakWindow(pageText)
    return {
      currency,
      source: options.source ?? (currency === 'USD'
        ? 'https://api-docs.deepseek.com/quick_start/pricing'
        : PRICING_SOURCE),
      peak: peak ?? defaultPeak(),
      peakParsed: peak !== undefined,
      models: complete,
    }
  } catch {
    return null
  }
}

/**
 * 该时刻是否落在高峰时段（UTC 判断，**不含中国法定节假日**）。
 * @param {number|string|Date} time
 * @param {{days: number[], hoursUtc: number[][]}} [peak]
 */
export function isPeakAt(time, peak = PRICING_PEAK) {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return false
  const days = Array.isArray(peak?.days) ? peak.days : []
  const ranges = Array.isArray(peak?.hoursUtc) ? peak.hoursUtc : []
  if (!days.includes(date.getUTCDay())) return false
  const hour = date.getUTCHours()
  return ranges.some(([from, to]) => hour >= from && hour < to)
}

/** 模型名里的「家族词」：小写、去版本号、去厂商名，用于宽松匹配。 */
function familyTokens(name) {
  return String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !/^\d/.test(token) && token !== 'deepseek')
}

/**
 * 把本地配置的模型名映射到官方条目。
 * - 非 deepseek → `excluded`；deepseek 但匹配不到 → `unmatched`（都不猜价格）。
 * - 旧名归并：`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` → `deepseek-flash`。
 *
 * @param {unknown} name
 * @param {readonly object[]} [models]
 */
export function resolveModel(name, models = PRICING_MODELS) {
  if (name === undefined || name === null || String(name).trim() === '') {
    return { status: 'excluded', reason: 'no model configured' }
  }
  const base = String(name).toLowerCase().trim().split('/').pop() ?? ''
  if (!base.includes('deepseek')) return { status: 'excluded', reason: 'not a DeepSeek model' }
  const tokens = familyTokens(base)
  let best
  let bestScore = 0
  for (const model of models) {
    const entryTokens = familyTokens(`${model.id} ${model.label ?? ''}`)
    const score = entryTokens.filter((token) => tokens.includes(token)).length
    if (score > bestScore) {
      bestScore = score
      best = model
    }
  }
  if (best === undefined) return { status: 'unmatched', reason: 'no official price entry matches this model name' }
  return { status: 'priced', id: best.id, label: best.label, entry: { hit: best.hit, miss: best.miss, out: best.out } }
}

/**
 * 省下的 token 折算成钱（元）。四个数：峰/谷 × 缓存命中/未命中。
 * @param {unknown} tokens
 * @param {{hit: {off: number, peak: number}, miss: {off: number, peak: number}}} entry
 * @returns {{off: {hit: number, miss: number}, peak: {hit: number, miss: number}} | null}
 */
export function savingsOf(tokens, entry) {
  if (entry === undefined || entry === null) return null
  const count = typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : 0
  const amount = (price) => (typeof price === 'number' && Number.isFinite(price) ? (count * price) / 1e6 : 0)
  return {
    off: { hit: amount(entry.hit?.off), miss: amount(entry.miss?.off) },
    peak: { hit: amount(entry.hit?.peak), miss: amount(entry.miss?.peak) },
  }
}

/** 覆盖价是否合法：三项都要有限正数。 */
function normalizeOverride(override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return null
  const numbers = ['hit', 'miss', 'out'].map((key) => override[key])
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null
  const [hit, miss, out] = numbers
  return { hit, miss, out }
}

/**
 * 给 `inspect()` 用的价表快照：配置的模型 → 解析结果 → 生效价（含覆盖）→ 面板默认高亮时段。
 * @param {{model?: string, period?: string, override?: object} | undefined} config
 */
export function pricingSnapshot(config) {
  const source = config && typeof config === 'object' ? config : {}
  const model = typeof source.model === 'string' && source.model.trim() !== '' ? source.model.trim() : 'deepseek-flash'
  const period = source.period === 'peak' ? 'peak' : 'off-peak'
  const override = normalizeOverride(source.override)
  const resolved = resolveModel(model)
  const entry = override === null
    ? (resolved.entry ?? null)
    : {
        hit: { off: override.hit, peak: override.hit },
        miss: { off: override.miss, peak: override.miss },
        out: { off: override.out, peak: override.out },
      }
  return {
    status: resolved.status,
    asOf: PRICING_AS_OF,
    source: PRICING_SOURCE,
    currency: PRICING_CURRENCY,
    model,
    resolvedId: resolved.id ?? null,
    label: resolved.label ?? null,
    period,
    override: override !== null,
    entry,
  }
}
