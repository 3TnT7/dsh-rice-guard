import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStatsStore, monthKey } from '../src/stats-store.js'
import { createUsageHook } from '../src/usage.js'

const NOW = new Date(2026, 9, 25, 12).getTime()

/** 每个用例独占临时目录，关闭句柄后清理，不读真实宿主存档。 */
function fixture(t, enabled = true, at = NOW) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-usage-'))
  const stores = []
  function open() {
    const store = createStatsStore({ dir, now: () => at })
    stores.push(store)
    store.configure({ storage: { enabled } })
    return store
  }
  t.after(() => {
    for (const store of stores) store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, open, store: open() }
}

function usage(store, sid = 'session-a', values = {}, ts = NOW) {
  store.recordUsage({ sessionId: sid, ts, usage: { inputTokens: 100, cacheReadTokens: 300, outputTokens: 20, ...values } })
}

function assemble(store, sid = 'session-a', ts = NOW, tokensBefore = 100) {
  store.record({ sessionId: sid, ts, processed: true, tokensBefore, bytesBefore: tokensBefore * 4 })
}

test('usage：只有实测通道也能统计窗口与会话，不增加 assemble 次数', (t) => {
  const { store } = fixture(t)
  usage(store)
  const summary = store.summary()
  assert.equal(summary.assembleRequests, 0)
  assert.deepEqual(summary.usage, {
    calls: 1, promptTokens: 400, hitTokens: 300, missTokens: 100, outputTokens: 20,
    reasoningTokens: 0, hitRate: 0.75, steadyHitRate: null, zeroHitCalls: 0,
    firstCalls: 1, pairedCalls: 0, toolsShare: null,
  })
  assert.deepEqual(store.conversations()[0].usage,
    { calls: 1, promptTokens: 400, hitTokens: 300, hitRate: 0.75, toolsShare: null })
})

test('usage：配对按配对消息的真实 prompt 加权，且只消耗一次 assemble', (t) => {
  const { store } = fixture(t)
  assemble(store, 'a', NOW - 1000, 100)
  usage(store, 'a')
  assemble(store, 'b', NOW - 1000, 200)
  usage(store, 'b', { inputTokens: 200, cacheReadTokens: 400 })
  usage(store, 'b')
  const result = store.summary().usage
  assert.equal(result.pairedCalls, 2)
  assert.equal(result.toolsShare, 300 / 1000)
  assert.equal(store.conversations().find((row) => row.sessionId === 'b').usage.toolsShare, 200 / 600)
})

test('usage：零估算 assemble 不参与配对，后续正常估算单独贡献占比', (t) => {
  const { store } = fixture(t)
  store.record({ sessionId: 'a', ts: NOW - 1000, processed: false, tokensBefore: 0 })
  usage(store, 'a')
  assert.equal(store.summary().usage.pairedCalls, 0)
  assert.equal(store.summary().usage.toolsShare, null)

  assemble(store, 'a', NOW, 120)
  usage(store, 'a', { inputTokens: 200, cacheReadTokens: 400 }, NOW + 1)
  assert.equal(store.summary().usage.pairedCalls, 1)
  assert.equal(store.summary().usage.toolsShare, 120 / 600)

  // 正常估算之后若又出现零估算，不能跨过最新步骤误配更早的记录。
  assemble(store, 'a', NOW + 2, 300)
  store.record({ sessionId: 'a', ts: NOW + 3, processed: false, tokensBefore: 0 })
  usage(store, 'a', {}, NOW + 4)
  assert.equal(store.summary().usage.pairedCalls, 1)
  assert.equal(store.summary().usage.toolsShare, 120 / 600)
})

test('usage：超过十分钟、不同会话、未来 assemble 均不配对，过期取用即删', (t) => {
  const { store } = fixture(t)
  assemble(store, 'expired', NOW - 600001)
  usage(store, 'expired')
  usage(store, 'expired', {}, NOW - 600000)
  assemble(store, 'other')
  usage(store, 'different')
  assemble(store, 'future', NOW + 1)
  usage(store, 'future')
  usage(store, 'future', {}, NOW + 2)
  assert.equal(store.summary().usage.pairedCalls, 0)
  assert.equal(store.summary().usage.toolsShare, null)
})

test('usage：十分钟边界仍可配对', (t) => {
  const { store } = fixture(t)
  assemble(store, 'a', NOW - 600000)
  usage(store, 'a')
  assert.equal(store.summary().usage.pairedCalls, 1)
})

test('usage：各会话首条剔除，第二条全命中时稳态为一', (t) => {
  const { store } = fixture(t)
  usage(store, 'a', { cacheReadTokens: 0 })
  usage(store, 'b', { cacheReadTokens: 0 })
  usage(store, 'a', { inputTokens: 0, cacheReadTokens: 500 })
  usage(store, 'b', { inputTokens: 0, cacheReadTokens: 500 })
  const result = store.summary().usage
  assert.equal(result.firstCalls, 2)
  assert.equal(result.steadyHitRate, 1)
  assert.equal(result.hitRate, 1000 / 1200)
  assert.equal(result.zeroHitCalls, 2)
})

test('usage：纯输出不算零命中 prompt，命中率分母为零时为 null', (t) => {
  const { store } = fixture(t)
  usage(store, 'a', { inputTokens: 0, cacheReadTokens: 0, outputTokens: 10 })
  const result = store.summary().usage
  assert.equal(result.calls, 1)
  assert.equal(result.promptTokens, 0)
  assert.equal(result.hitRate, null)
  assert.equal(result.steadyHitRate, null)
  assert.equal(result.zeroHitCalls, 0)
})

test('usage：重启从双类型 JSONL 重建，首条集合不从历史恢复', (t) => {
  const { store, dir, open } = fixture(t)
  assemble(store)
  usage(store, 'session-a', { cacheWriteTokens: 12, reasoningTokens: 9 })
  usage(store)
  const before = store.summary()
  assert.equal(store.info().usageRecords, 0, '仅统计加载进来的 usage 行')
  store.close()
  const lines = readFileSync(join(dir, 'stats', `${monthKey(NOW)}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(lines[0].v, 2)
  assert.equal(lines[0].k, 'a')
  assert.deepEqual(lines[1], { v: 2, k: 'u', ts: NOW, sid: 'session-a', input: 100,
    output: 20, cacheRead: 300, cacheWrite: 12, reasoning: 9, first: 1, paired: 1, estTokens: 100 })
  const restarted = open()
  assert.deepEqual(restarted.summary(), before)
  assert.equal(restarted.info().recordsLoaded, 1)
  assert.equal(restarted.info().usageRecords, 2)
  assert.equal(restarted.info().corruptLines, 0)
  usage(restarted)
  assert.equal(restarted.summary().usage.firstCalls, 2)
  assert.equal(restarted.summary().usage.pairedCalls, 1, '加载旧 assemble 不进入本进程待配对表')
})

test('usage：v1 无 k 旧日志仍是 assemble，不产生实测数据', (t) => {
  const { store, dir, open } = fixture(t)
  store.close()
  mkdirSync(join(dir, 'stats'), { recursive: true })
  writeFileSync(join(dir, 'stats', `${monthKey(NOW)}.jsonl`), `${JSON.stringify({ v: 1, ts: NOW, sid: 'old', processed: 1, bytesBefore: 400 })}\n`)
  const restarted = open()
  assert.equal(restarted.summary().assembleRequests, 1)
  assert.equal(restarted.summary().tokensBefore, 100)
  assert.equal(restarted.summary().usage.calls, 0)
  assert.equal(restarted.info().usageRecords, 0)
  assert.deepEqual(restarted.conversations()[0].usage,
    { calls: 0, promptTokens: 0, hitTokens: 0, hitRate: null, toolsShare: null })
})

test('usage：损坏行计数，未知版本或类型不混入统计', (t) => {
  const { store, dir, open } = fixture(t)
  usage(store)
  store.close()
  const path = join(dir, 'stats', `${monthKey(NOW)}.jsonl`)
  const corrupt = ['not json', 'null', '{"v":2}', JSON.stringify({ v: 3, ts: NOW }), JSON.stringify({ v: 2, k: 'x', ts: NOW })]
  writeFileSync(path, `${readFileSync(path, 'utf8')}${corrupt.join('\n')}\n`)
  const restarted = open()
  assert.equal(restarted.info().corruptLines, 5)
  assert.equal(restarted.info().usageRecords, 1)
  assert.equal(restarted.summary().usage.calls, 1)
})

test('usage：禁用持久化仍在内存累计，不创建 stats 目录', (t) => {
  const { store, dir } = fixture(t, false)
  assemble(store)
  usage(store)
  assert.equal(store.summary().usage.calls, 1)
  assert.equal(store.summary().usage.pairedCalls, 1)
  assert.equal(existsSync(join(dir, 'stats')), false)
})

test('usage：缺失、负数、NaN、字符串等敌意数值归零且不抛', (t) => {
  const { store } = fixture(t)
  for (const value of [undefined, null, {}, { usage: null }, { usage: 'x' }]) {
    assert.doesNotThrow(() => store.recordUsage(value))
  }
  for (const bad of [-10, NaN, Infinity, '200', true, {}, null, undefined]) {
    assert.doesNotThrow(() => store.recordUsage({ sessionId: 'bad', usage: {
      inputTokens: bad, outputTokens: bad, cacheReadTokens: bad, cacheWriteTokens: bad, reasoningTokens: bad,
    } }))
    store.recordUsage({ sessionId: 'valid', usage: { inputTokens: 10, outputTokens: bad,
      cacheReadTokens: bad, cacheWriteTokens: bad, reasoningTokens: bad } })
  }
  assert.equal(store.summary().usage.calls, 8)
  assert.equal(store.summary().usage.promptTokens, 80)
  assert.equal(store.summary().usage.outputTokens, 0)
  assert.equal(store.summary().usage.reasoningTokens, 0)
  assert.equal(store.summary().usage.hitRate, 0)
  assert.equal(store.summary().usage.firstCalls, 1)
  assert.doesNotThrow(() => store.recordUsage(new Proxy({}, { get() { throw new Error('敌意读取') } })))
})

test('usage：本地自然日与七天、三十天窗口边界正确', (t) => {
  const { store } = fixture(t)
  const midnight = new Date(2026, 9, 25).getTime()
  for (const ts of [midnight - 1, midnight, new Date(2026, 9, 19).getTime(),
    new Date(2026, 9, 18, 23, 59).getTime(), new Date(2026, 8, 26).getTime(),
    new Date(2026, 8, 25, 23, 59).getTime()]) usage(store, String(ts), {}, ts)
  assert.equal(store.summary('today').usage.calls, 1)
  assert.equal(store.summary('d7').usage.calls, 3)
  assert.equal(store.summary('d30').usage.calls, 5)
})

test('usage：跨日 prune 同时裁剪实测日桶和会话桶', (t) => {
  const { store } = fixture(t, false)
  usage(store, 'old')
  const future = new Date(2027, 0, 1, 12).getTime()
  usage(store, 'new', {}, future)
  assert.equal(store.summary('d30', NOW).usage.calls, 1, '旧实测日桶已删除，仅保留新桶')
  assert.deepEqual(store.conversations('d30', future).map((row) => row.sessionId), ['new'])
  assert.equal(store.info().sessions, 1)
})

test('usage-hook：只读 spec 及有效事件透传时间', () => {
  const calls = []
  const hook = createUsageHook({ recordUsage: (record) => calls.push(record) })
  assert.equal(hook.id, 'usage-record')
  assert.equal(hook.event, 'session/event')
  assert.equal(hook.kind, 'serial')
  assert.equal(hook.containment, 'never-throw')
  const values = Object.freeze({ cacheReadTokens: 10 })
  const session = Object.freeze({ id: 'a' })
  const event = Object.freeze({ type: 'assistant/message', time: NOW, data: Object.freeze({ usage: values }) })
  hook.handler(session, event)
  assert.deepEqual(calls, [{ sessionId: 'a', ts: NOW, usage: values }])
})

test('usage-hook：高频无关事件早退、非法字段与回调异常不冒泡', () => {
  const calls = []
  const hook = createUsageHook({ recordUsage: (record) => calls.push(record) })
  const session = { id: 'a' }
  const unreadable = { type: 'other', get data() { throw new Error('不应读取 data') } }
  for (const event of [undefined, null, unreadable, {}, { type: 'assistant/message' },
    { type: 'assistant/message', data: { usage: { inputTokens: '1', cacheReadTokens: NaN } } }]) {
    assert.doesNotThrow(() => hook.handler(session, event))
  }
  const valid = { type: 'assistant/message', time: NOW, data: { usage: { outputTokens: 1 } } }
  for (const badSession of [null, {}, { id: '' }, { id: 1 }]) hook.handler(badSession, valid)
  assert.equal(calls.length, 0)
  assert.doesNotThrow(() => createUsageHook({ recordUsage() { throw new Error('旁路失败') } }).handler(session, valid))
})
