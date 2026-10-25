/**
 * 职责：验证会话冻结（v0.4.0）——运行期配置按 session 快照，
 * 改动只影响之后的新会话；无 session id 或 `freeze.enabled:false` 时保持旧行为。
 * 依赖的 DSH 契约：`system-prompt/assemble` 的 context 形如
 * `{ agent, scope: agent, signal? }`（`assembleContextFor`，实测见
 * `docs/design/cache-pipeline/tasks/003_cache-pipeline_会话冻结探针.md`）。
 * 已知边界：快照只在进程内；超过 128 个会话按 LRU 淘汰，淘汰后下次 assemble
 * 会按当时的 live 配置重新冻结（测试用 200 个会话来证明上限与计数）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.js'
import { createCachePipeline } from '../src/cache-pipeline.js'

const HIDE = 'mcp__hide'
const tool = (name) => ({ name, description: '描述内容'.repeat(40), parameters: { type: 'object', properties: {} } })
const contextFor = (id) => ({ agent: { session: { id } }, scope: { session: { id } } })
const make = (config = {}) => createCachePipeline(normalizeConfig(config))
const run = (pipeline, tools, context = {}) => {
  const assembly = { tools }
  return pipeline.hooks[0].handler(assembly, context, async () => assembly)
}
/** 消隐关 + 另两个关：最省事的「先冻结、再改配置」基线。 */
const allOff = (visibility = {}) => ({
  visibility: { enabled: false, exact: [HIDE], ...visibility },
  truncation: { enabled: false },
  ordering: { enabled: false },
})

test('冻结：老会话沿用快照，新会话拿改后的配置', async () => {
  const pipeline = make(allOff())
  const tools = [tool(HIDE)]
  const sessionA = contextFor('session-a')

  assert.equal((await run(pipeline, tools, sessionA)).tools.length, 1)
  pipeline.setConfig({ visibility: { enabled: true } })
  // 老会话：冻结在「关闭」那一刻，配置改了也不动它。
  assert.equal((await run(pipeline, tools, sessionA)).tools.length, 1)
  // 新会话：第一次 assemble 发生在改动之后，冻结的是新值。
  assert.equal((await run(pipeline, tools, contextFor('session-b'))).tools.length, 0)

  const snapshot = pipeline.inspect()
  assert.equal(snapshot.sessionsFrozen, 2)
  assert.equal(snapshot.sessionSnapshots, 2)
  assert.equal(snapshot.frozenAssembles, 1)
})

test('冻结：全关时也会建立快照（早退之前定视图）', async () => {
  const pipeline = make(allOff())
  await run(pipeline, [tool(HIDE)], contextFor('session-a'))
  assert.equal(pipeline.inspect().sessionsFrozen, 1)

  pipeline.setConfig({ visibility: { enabled: true } })
  // 如果早退发生在定视图之前，这个会话会拿到新配置（等于没冻结）。
  assert.equal((await run(pipeline, [tool(HIDE)], contextFor('session-a'))).tools.length, 1)
})

test('冻结：dryRun 开关也按会话冻结', async () => {
  const pipeline = make({
    visibility: { enabled: true, dryRun: false, exact: [HIDE] },
    truncation: { enabled: false },
    ordering: { enabled: false },
  })
  const sessionA = contextFor('session-a')
  assert.equal((await run(pipeline, [tool(HIDE)], sessionA)).tools.length, 0)

  pipeline.setConfig({ visibility: { dryRun: true } })
  // 老会话仍是 dryRun:false（真移除）。
  assert.equal((await run(pipeline, [tool(HIDE)], sessionA)).tools.length, 0)
  // 新会话是 dryRun:true（只试算，保留工具）。
  assert.equal((await run(pipeline, [tool(HIDE)], contextFor('session-b'))).tools.length, 1)
})

test('没有 session id：立即生效，且不建快照', async () => {
  const pipeline = make(allOff())
  assert.equal((await run(pipeline, [tool(HIDE)])).tools.length, 1)
  pipeline.setConfig({ visibility: { enabled: true } })
  assert.equal((await run(pipeline, [tool(HIDE)])).tools.length, 0)
  assert.equal(pipeline.inspect().sessionsFrozen, 0)
  assert.equal(pipeline.inspect().sessionSnapshots, 0)
})

test('freeze.enabled=false：退回「切开关立刻生效」', async () => {
  const pipeline = make({ ...allOff(), freeze: { enabled: false } })
  const sessionA = contextFor('session-a')
  assert.equal((await run(pipeline, [tool(HIDE)], sessionA)).tools.length, 1)
  pipeline.setConfig({ visibility: { enabled: true } })
  assert.equal((await run(pipeline, [tool(HIDE)], sessionA)).tools.length, 0)
  assert.equal(pipeline.inspect().sessionsFrozen, 0)
})

test('冻结：超过 128 个会话按 LRU 淘汰，被淘汰的会话重新快照', async () => {
  const pipeline = make(allOff())
  const tools = [tool(HIDE)]
  for (let i = 0; i < 200; i += 1) await run(pipeline, tools, contextFor(`s-${i}`))

  let snapshot = pipeline.inspect()
  assert.equal(snapshot.sessionsFrozen, 128)
  assert.equal(snapshot.sessionSnapshots, 200)
  assert.equal(snapshot.sessionSnapshotsEvicted, 72)

  pipeline.setConfig({ visibility: { enabled: true } })
  // s-0 最早被淘汰：重新冻结的是「开启」后的配置。
  assert.equal((await run(pipeline, tools, contextFor('s-0'))).tools.length, 0)
  // s-199 还在窗口里：仍冻结在「关闭」。
  assert.equal((await run(pipeline, tools, contextFor('s-199'))).tools.length, 1)
})

test('敌意 context：getter 抛错不拖垮钩子，按无 session 处理', async () => {
  const pipeline = make(allOff())
  const hostile = Object.defineProperty({}, 'agent', {
    get() {
      throw new Error('boom')
    },
  })
  assert.equal((await run(pipeline, [tool(HIDE)], hostile)).tools.length, 1)
  const snapshot = pipeline.inspect()
  assert.equal(snapshot.failed, 0)
  assert.equal(snapshot.sessionsFrozen, 0)
})

test('配置归一化：freeze 默认开、非法值回退、运行期接口不改它', () => {
  assert.equal(normalizeConfig({}).freeze.enabled, true)
  assert.equal(normalizeConfig({ freeze: { enabled: false } }).freeze.enabled, false)
  assert.equal(normalizeConfig({ freeze: { enabled: 'no' } }).freeze.enabled, true)

  const pipeline = make({ freeze: { enabled: false } })
  pipeline.setConfig({ truncation: { enabled: true } })
  assert.equal(pipeline.getConfig().freeze.enabled, false)
})

test('运行期配置不改 freeze 与 pricing（只换三个投影开关）', () => {
  const pipeline = make({ pricing: { model: 'deepseek-v4-pro', period: 'peak' } })
  pipeline.setConfig({ truncation: { enabled: false }, visibility: { enabled: true } })
  const config = pipeline.getConfig()
  assert.equal(config.freeze.enabled, true)
  assert.equal(config.pricing.model, 'deepseek-v4-pro')
  assert.equal(config.pricing.period, 'peak')
})
