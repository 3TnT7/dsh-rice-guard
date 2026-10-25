/**
 * 职责：验证工具消隐及配置入口。
 * 依赖的 DSH 契约：单 waterfall 只替换 tools。
 * 关键决策与依据：空名单不删、keepFull 优先、显式 dryRun。
 * 已知边界：宿主用最小 fake，不发送网络请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { normalizeConfig } from '../src/config.js'
import { createCachePipeline } from '../src/cache-pipeline.js'
import { apply } from '../src/index.js'

// `apply()` reads the persisted tuning archive; isolate it from the real home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rg-visibility-home-'))

const tool = (name) => ({ name, description: '原始描述', parameters: { type: 'object', properties: {} } })
const make = (visibility = {}, truncation = {}) => createCachePipeline(normalizeConfig({
  visibility, truncation: { enabled: false, ...truncation }, ordering: { enabled: false },
}))
const run = (pipeline, tools) => {
  const assembly = { tools, sections: [], contexts: [], variables: {} }
  return pipeline.hooks[0].handler(assembly, {}, async () => assembly)
}

test('visibility 默认关不改列表', async () => {
  const pipeline = make({ exact: ['a'] })
  const tools = [tool('a')]
  assert.equal((await run(pipeline, tools)).tools, tools)
})
test('visibility exact 精确匹配且大小写敏感', async () => {
  const pipeline = make({ enabled: true, exact: ['a'] })
  assert.deepEqual((await run(pipeline, ['a', 'ab', 'A'].map(tool))).tools.map(t => t.name), ['ab', 'A'])
  assert.equal(pipeline.inspect().hidden, 1)
})
test('visibility prefix 保序移除，独立于另两个开关', async () => {
  const pipeline = make({ enabled: true, prefixes: ['hide_'] })
  const tools = ['z', 'hide_a', 'a', 'hide_b', 'Hide_c'].map(tool)
  const result = await run(pipeline, tools)
  assert.deepEqual(result.tools, [tools[0], tools[2], tools[4]])
  assert.equal(result.tools[0], tools[0])
  assert.equal(pipeline.inspect().hidden, 2)
})
test('visibility keepFull 优先于 exact 和 prefix', async () => {
  const pipeline = make({ enabled: true, exact: ['a'], prefixes: ['a'] }, { keepFull: ['a'] })
  const tools = [tool('a')]
  assert.equal((await run(pipeline, tools)).tools, tools)
  assert.equal(pipeline.inspect().hidden, 0)
})
test('visibility prefixes 空数组和漏配均不删', async () => {
  for (const visibility of [{ enabled: true }, { enabled: true, prefixes: [] }]) {
    const tools = [tool('a')]
    assert.equal((await run(make(visibility), tools)).tools, tools)
  }
})
test('visibility dryRun 只计预计，使用整份候选列表长度', async () => {
  const pipeline = make({ enabled: true, exact: ['a'], dryRun: true })
  const tools = [tool('a'), tool('b')]
  assert.equal((await run(pipeline, tools)).tools, tools)
  const stats = pipeline.inspect()
  assert.equal(stats.hidden, 0)
  assert.equal(stats.hiddenTotal, 0)
  assert.equal(stats.hiddenBytes, 0)
  assert.equal(stats.wouldHide, 1)
  assert.equal(stats.wouldHideBytes, JSON.stringify(tools).length - JSON.stringify([tools[1]]).length)
})
test('visibility 同输入两次输出字节相等且非工具投影透传', async () => {
  const pipeline = make({ enabled: true, exact: ['a'] })
  const tools = [tool('a'), tool('b')]
  const first = await run(pipeline, tools)
  assert.equal(JSON.stringify(first), JSON.stringify(await run(pipeline, tools)))
  const assembly = { tools, sections: [], contexts: [], variables: {} }
  const result = await pipeline.hooks[0].handler(assembly, {}, async () => assembly)
  for (const key of ['sections', 'contexts', 'variables']) assert.equal(result[key], assembly[key])
})
test('visibility 配置归一化、扁平兼容与敌意输入不抛', () => {
  const config = normalizeConfig({ visibilityEnabled: true, hiddenExact: ['a', '', 'a', 1], hiddenPrefixes: ['x', 'x'] })
  assert.deepEqual(config.visibility, { enabled: true, dryRun: false, exact: ['a'], prefixes: ['x'] })
  assert.equal(normalizeConfig({ visibilityEnabled: true, visibility: { enabled: false } }).visibility.enabled, false)
  assert.deepEqual(normalizeConfig({ visibility: { enabled: 1, exact: [1], prefixes: null, unknown: true } }).visibility,
    { enabled: false, dryRun: false, exact: [], prefixes: [] })
  assert.doesNotThrow(() => normalizeConfig(new Proxy({}, { get() { throw Error('坏配置') } })))
})
test('visibility HTTP 只接收布尔开关，摘要不暴露 exact 数组', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rg-visibility-case-'))
  const routes = []
  let provider
  const ctx = {
    on() {},
    inject(deps, callback) {
      callback({ effect: fn => fn(), cordisInspect: { register(value) { provider = value; return () => {} } },
        webServer: { register(route) { routes.push(route); return () => {} } } })
    },
  }
  apply(ctx, { visibility: { exact: ['a'], prefixes: ['x'] } })
  const req = Readable.from([Buffer.from(JSON.stringify({ visibility: { enabled: true, dryRun: true, exact: ['b'], prefixes: [] } }))])
  req.method = 'POST'
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
  await routes.find(r => r.path.endsWith('/config')).handler(req, res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.config.visibility, { enabled: true, dryRun: true, exactCount: 1, prefixes: ['x'] })
  assert.deepEqual(provider.query('inspect').config.visibility, res.body.config.visibility)
  routes.find(r => r.path.endsWith('/stats')).handler({ method: 'GET' }, res)
  assert.equal(res.body.hidden, 0)
  assert.deepEqual(res.body.ledger, [])
})
