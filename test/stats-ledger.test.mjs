/**
 * 职责：验证分段收益账、估算 token 与有界决策留痕。
 * 依赖的 DSH 契约：assemble 权威结果与无损 JSON inspect。
 * 关键决策与依据：计量沿用 JSON UTF-16 长度，不伪称精确 token。
 * 已知边界：ledger 在最近 32 条窗口内去重，淘汰后允许重记。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/config.js'
import { createCachePipeline } from '../src/cache-pipeline.js'
const tool = (name) => ({ name, description: '描述内容'.repeat(200), parameters: { type: 'object', properties: {} } })
const make = (config = {}) => createCachePipeline(normalizeConfig(config))
const run = (pipeline, tools) => {
  const assembly = { tools }
  return pipeline.hooks[0].handler(assembly, {}, async () => assembly)
}

test('分段字节账先消隐后瘦身且可归因', async () => {
  const pipeline = make({ visibility: { enabled: true, exact: ['mcp__hide'] }, ordering: { enabled: true } })
  const tools = [tool('mcp__hide'), tool('mcp__slim')]
  const output = await run(pipeline, tools)
  const stats = pipeline.inspect()
  assert.equal(stats.bytesBefore, JSON.stringify(tools).length)
  assert.equal(stats.bytesAfterVisibility, JSON.stringify([tools[1]]).length)
  assert.equal(stats.bytesAfter, JSON.stringify(output.tools).length)
  assert.equal(stats.hiddenBytes, stats.bytesBefore - stats.bytesAfterVisibility)
  assert.equal(stats.bytesSaved, stats.bytesAfterVisibility - stats.bytesAfter)
  assert.equal(stats.hiddenBytes + stats.bytesSaved, stats.bytesBefore - stats.bytesAfter)
  assert.equal(stats.hiddenTotal, 1)
  assert.equal(stats.shadowed, 1)
  assert.equal(stats.toolsSeen, 2)
})
test('visibility 关闭时输出与原瘦身路径逐字节相同', async () => {
  const tools = [tool('mcp__x'), tool('core')]
  const a = make()
  const b = make({ visibility: { enabled: false, exact: ['mcp__x'] } })
  assert.equal(JSON.stringify((await run(a, tools)).tools), JSON.stringify((await run(b, tools)).tools))
  const stats = b.inspect()
  assert.equal(stats.bytesAfterVisibility, stats.bytesBefore)
  assert.equal(stats.hiddenBytes, 0)
  assert.equal(stats.bytesSaved, a.inspect().bytesSaved)
})
test('token 为4字符启发估算，向下取整并逐次累计', async () => {
  const pipeline = make({ visibility: { enabled: true, exact: ['mcp__a'] } })
  const tools = [tool('mcp__a'), tool('mcp__b')]
  await run(pipeline, tools)
  const first = pipeline.inspect()
  assert.equal(first.tokensBefore, Math.floor(first.bytesBefore / 4))
  assert.equal(first.tokensAfter, Math.floor(first.bytesAfter / 4))
  assert.equal(first.tokensSaved, Math.floor((first.bytesBefore - first.bytesAfter) / 4))
  assert.equal(first.tokensSavedTotal, first.tokensSaved)
  await run(pipeline, tools)
  assert.equal(pipeline.inspect().tokensSavedTotal, first.tokensSaved * 2)
  assert.equal(pipeline.inspect().hiddenTotal, 2)
})
test('新 gauge 在全关与无工具结果前也清零，累计不清', async () => {
  const pipeline = make({ visibility: { enabled: true, exact: ['x'], dryRun: true }, truncation: { enabled: false }, ordering: { enabled: false } })
  await run(pipeline, [tool('x')])
  assert.equal(pipeline.inspect().wouldHide, 1)
  pipeline.setConfig({ visibility: { enabled: false } })
  await run(pipeline, [])
  for (const key of ['hidden', 'wouldHide', 'hiddenBytes', 'wouldHideBytes', 'tokensBefore', 'tokensAfter', 'tokensSaved', 'bytesAfterVisibility']) assert.equal(pipeline.inspect()[key], 0)
})
test('ledger 最多32条、窗口内去重、seq递增、新实例为空', async () => {
  const pipeline = make({ visibility: { enabled: true, prefixes: ['hide_'] }, truncation: { enabled: false }, ordering: { enabled: false } })
  const same = [tool('hide_same')]
  await run(pipeline, same)
  await run(pipeline, same)
  assert.deepEqual(pipeline.inspect().ledger, [{ seq: 1, tool: 'hide_same', action: 'hidden', reason: 'prefix' }])
  assert.equal(pipeline.inspect().hiddenTotal, 2)
  await run(pipeline, Array.from({ length: 40 }, (_, i) => tool(`hide_${i}`)))
  const snapshot = pipeline.inspect()
  assert.equal(snapshot.ledger.length, 32)
  assert.equal(snapshot.ledger.at(-1).seq, 41)
  for (let i = 1; i < 32; i++) assert.equal(snapshot.ledger[i].seq, snapshot.ledger[i - 1].seq + 1)
  snapshot.ledger[0].tool = '修改快照'
  assert.notEqual(pipeline.inspect().ledger[0].tool, '修改快照')
  assert.deepEqual(make().inspect().ledger, [])
})
test('ledger 只记异常/被保护原因（不记 prefix-miss 与 size），inspect无undefined', async () => {
  const pipeline = make({ ordering: { enabled: false } })
  await run(pipeline, [tool('core'), tool('mcp__rea__list_names'), { name: 'mcp__tiny', parameters: { type: 'object', properties: {} } }])
  const snapshot = pipeline.inspect()
  // 常态跳过只进计数：133 个工具里 prefix-miss 占大头，进 ledger 会把窗口刷满。
  assert.equal(snapshot.ledger.some(e => e.reason === 'prefix-miss'), false)
  assert.equal(snapshot.ledger.some(e => e.reason === 'size'), false)
  assert.ok(snapshot.ledger.some(e => e.reason === 'keepFull'))
  assert.equal(snapshot.skippedByInvalidTotal, 1)
  assert.deepEqual(snapshot, JSON.parse(JSON.stringify(snapshot)))
  assert.equal(Object.hasOwn(snapshot, 'lastError'), false)
})
test('正常瘦身不刷 ledger（只计数）', async () => {
  const pipeline = make({ ordering: { enabled: false } })
  await run(pipeline, Array.from({ length: 40 }, (_, i) => tool(`mcp__slim_${i}`)))
  const snapshot = pipeline.inspect()
  assert.equal(snapshot.shadowedTotal, 40)
  assert.deepEqual(snapshot.ledger, [])
})
test('visibility 单工具异常保留引用，列表级异常整体回退', async () => {
  const pipeline = make({ visibility: { enabled: true, exact: ['hide'] }, truncation: { enabled: false }, ordering: { enabled: false } })
  const broken = Object.defineProperty({}, 'name', { get() { throw Error('坏工具') } })
  const result = await run(pipeline, [tool('hide'), broken, tool('safe')])
  assert.equal(result.tools[0], broken)
  assert.equal(result.tools.length, 2)
  assert.equal(pipeline.inspect().failed, 1)
  const tools = [tool('hide'), tool('safe')]
  tools[Symbol.iterator] = function* () { yield this[0]; throw Error('坏列表') }
  const assembly = { tools }
  assert.equal(await pipeline.hooks[0].handler(assembly, {}, async () => assembly), assembly)
  assert.equal(pipeline.inspect().failed, 2)
  assert.equal(pipeline.inspect().hidden, 0)
  assert.equal(pipeline.inspect().lastError, '坏列表')
})

test('消隐后 truncation dryRun 的预计收益只基于剩余列表', async () => {
  const config = { visibility: { enabled: true, exact: ['mcp__hide'] }, truncation: { dryRun: true }, ordering: { enabled: false } }
  const pipeline = make(config)
  const tools = [tool('mcp__hide'), tool('mcp__keep')]
  const actual = await run(pipeline, tools)
  const reference = make({ truncation: { dryRun: true }, ordering: { enabled: false } })
  await run(reference, [tools[1]])
  assert.equal(actual.tools[0], tools[1])
  assert.equal(pipeline.inspect().wouldSaveBytes, reference.inspect().wouldSaveBytes)
  assert.equal(pipeline.inspect().bytesSaved, 0)
  assert.equal(pipeline.inspect().wouldShadow, 1)
})
test('隐藏全部包含数组分隔符，后续空列表清零 gauge 不清累计', async () => {
  const pipeline = make({ visibility: { enabled: true, prefixes: ['x'] }, truncation: { enabled: false }, ordering: { enabled: false } })
  const tools = [tool('x1'), tool('x2')]
  assert.deepEqual((await run(pipeline, tools)).tools, [])
  assert.equal(pipeline.inspect().hiddenBytes, JSON.stringify(tools).length - 2)
  await run(pipeline, [])
  assert.equal(pipeline.inspect().hidden, 0)
  assert.equal(pipeline.inspect().hiddenTotal, 2)
  await pipeline.hooks[0].handler({}, {}, async () => ({ tools: null }))
  assert.equal(pipeline.inspect().bytesBefore, 0)
})
