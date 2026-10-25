/**
 * 职责：验证官方价表解析、模型映射、峰谷判断、省钱估算与累计 token 账。
 * 依赖的 DSH 契约：无（纯函数 + 内存里的 pipeline 实例）。
 * 关键决策与依据：解析测试用**手工构造的最小夹具** `test/fixtures/pricing-cny.html`——结构仿官方定价页，
 *   价格数值取自公开价目；不转载第三方页面，同时固定住解析器依赖的结构形状。
 * 已知边界：解析器只认第一张 `<table>`；官方改版时应先跑 `scripts/update-pricing.mjs`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  hourRanges,
  isPeakAt,
  parsePeakWindow,
  parsePricingDocument,
  pricingSnapshot,
  resolveModel,
  savingsOf,
  textOf,
} from '../src/pricing.js'
import { normalizeConfig } from '../src/config.js'
import { createCachePipeline } from '../src/cache-pipeline.js'

const fixturePath = fileURLToPath(new URL('./fixtures/pricing-cny.html', import.meta.url))
const fixture = readFileSync(fixturePath, 'utf8')

const near = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`)
}

test('定价页夹具：解析出两个模型与完整三组价', () => {
  const parsed = parsePricingDocument(fixture)
  assert.ok(parsed)
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.models.length, 2)
  const flash = parsed.models.find((model) => model.id === 'deepseek-flash')
  const pro = parsed.models.find((model) => model.id === 'deepseek-v4-pro')
  assert.deepEqual(flash, {
    id: 'deepseek-flash',
    label: 'DeepSeek-V4.1-Flash-1017',
    hit: { off: 0.02, peak: 0.04 },
    miss: { off: 1, peak: 2 },
    out: { off: 4, peak: 8 },
  })
  assert.deepEqual(pro, {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek-V4-Pro-0813',
    hit: { off: 0.15, peak: 0.3 },
    miss: { off: 4.5, peak: 9 },
    out: { off: 13.5, peak: 27 },
  })
})

test('页脚脚注：峰谷窗口解析为 UTC 01–04、06–10，周一至周五', () => {
  const pageText = textOf(fixture)
  assert.deepEqual(parsePeakWindow(pageText), { days: [1, 2, 3, 4, 5], hoursUtc: [[1, 4], [6, 10]] })
  const parsed = parsePricingDocument(fixture)
  assert.equal(parsed.peakParsed, true)
  assert.deepEqual(parsed.peak, { days: [1, 2, 3, 4, 5], hoursUtc: [[1, 4], [6, 10]] })
})

test('时段换算：北京时间 09:00–12:00 / 14:00–18:00 → UTC 01–04 / 06–10', () => {
  assert.deepEqual(hourRanges('周一至周五 9:00 - 12:00、14:00 - 18:00', 8), [[1, 4], [6, 10]])
  assert.deepEqual(hourRanges('09:00–12:00', 0), [[9, 12]])
  assert.deepEqual(hourRanges('没有时间', 8), [])
})

test('损坏输入永不抛，返回 null', () => {
  assert.equal(parsePricingDocument(''), null)
  assert.equal(parsePricingDocument('<html><body>no table</body></html>'), null)
  assert.equal(parsePricingDocument('<table><tr><td>模型</td></tr></table>'), null)
  assert.equal(parsePricingDocument('<table><tr><td>模型</td><td>flash</td></tr><tr><td>价格</td><td>空闲时段</td><td>元</td></tr></table>'), null)
  assert.equal(parsePricingDocument(null), null)
  assert.equal(parsePricingDocument(undefined), null)
})

test('峰谷判断：UTC 周一 01 点为峰、04 点为谷、周六 02 点为谷', () => {
  const peak = { days: [1, 2, 3, 4, 5], hoursUtc: [[1, 4], [6, 10]] }
  // 2026-10-26 是周一，2026-10-31 是周六。
  assert.equal(isPeakAt(Date.UTC(2026, 9, 26, 1, 0), peak), true)
  assert.equal(isPeakAt(Date.UTC(2026, 9, 26, 4, 0), peak), false)
  assert.equal(isPeakAt(Date.UTC(2026, 9, 26, 6, 30), peak), true)
  assert.equal(isPeakAt(Date.UTC(2026, 9, 31, 2, 0), peak), false)
  assert.equal(isPeakAt('not-a-date', peak), false)
})

test('模型映射：旧名归并、非 deepseek 排除、未知 deepseek 不猜价', () => {
  assert.equal(resolveModel('deepseek-flash').id, 'deepseek-flash')
  assert.equal(resolveModel('deepseek-v4-flash').id, 'deepseek-flash')
  assert.equal(resolveModel('deepseek-v4-flash-vision-exp').id, 'deepseek-flash')
  assert.equal(resolveModel('deepseek-v4-pro').id, 'deepseek-v4-pro')
  assert.equal(resolveModel('openai/gpt-x').status, 'excluded')
  assert.equal(resolveModel('deepseek-unknown').status, 'unmatched')
  assert.equal(resolveModel('').status, 'excluded')
})

test('省钱估算：四个数（峰/谷 × 命中/未命中）', () => {
  const entry = { hit: { off: 0.02, peak: 0.04 }, miss: { off: 1, peak: 2 }, out: { off: 4, peak: 8 } }
  const result = savingsOf(10637, entry)
  near(result.off.hit, 0.00021274, 'off.hit')
  near(result.off.miss, 0.010637, 'off.miss')
  near(result.peak.hit, 0.00042548, 'peak.hit')
  near(result.peak.miss, 0.021274, 'peak.miss')
  assert.equal(savingsOf(undefined, entry).off.hit, 0)
  assert.equal(savingsOf(-5, entry).off.hit, 0)
  assert.equal(savingsOf(1000, null), null)
})

test('pricing 快照：默认 priced、未定价 entry 为 null、覆盖价生效', () => {
  const fallback = pricingSnapshot(normalizeConfig({}).pricing)
  assert.equal(fallback.status, 'priced')
  assert.equal(fallback.resolvedId, 'deepseek-flash')
  assert.equal(fallback.override, false)
  assert.equal(fallback.entry.hit.off, 0.02)

  const unmatched = pricingSnapshot(normalizeConfig({ pricing: { model: 'deepseek-unknown' } }).pricing)
  assert.equal(unmatched.status, 'unmatched')
  assert.equal(unmatched.entry, null)

  const overridden = pricingSnapshot(normalizeConfig({ pricing: { override: { hit: 0.01, miss: 0.5, out: 2 } } }).pricing)
  assert.equal(overridden.override, true)
  assert.equal(overridden.entry.hit.off, 0.01)
  assert.equal(overridden.entry.miss.peak, 0.5)

  const invalid = pricingSnapshot(normalizeConfig({ pricing: { override: { hit: -1, miss: 0, out: 2 } } }).pricing)
  assert.equal(invalid.override, false)
})

test('累计 token 账：两次 assemble 累加，inspect 无 undefined', async () => {
  const pipeline = createCachePipeline(normalizeConfig({}))
  const tools = [
    { name: 'mcp__a__big', description: '描述'.repeat(300), parameters: { type: 'object', properties: { a: { type: 'string', description: '内容'.repeat(200) } } } },
    { name: 'core_tool', description: '短', parameters: { type: 'object', properties: {} } },
  ]
  const run = async () => pipeline.hooks[0].handler({ tools }, {}, async () => ({ tools }))
  await run()
  const first = pipeline.inspect()
  await run()
  const second = pipeline.inspect()
  assert.equal(second.assembleCalls, 2)
  assert.equal(second.tokensBeforeTotal, first.tokensBeforeTotal * 2)
  assert.equal(second.tokensAfterTotal, first.tokensAfterTotal * 2)
  assert.equal(second.tokensSavedTotal, first.tokensSavedTotal * 2)
  assert.ok(second.pricing && second.pricing.status === 'priced')
  assert.deepEqual(second, JSON.parse(JSON.stringify(second)))
  assert.equal(Object.hasOwn(second, 'lastError'), false)
})
