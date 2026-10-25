import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, normalizeConfig } from '../src/config.js'
import { createCachePipeline } from '../src/cache-pipeline.js'
import { SLIM_RULE_DEFAULTS, selfcheck, slimParameters } from '../src/cache-pipeline/slim.js'
import { codePointLength, truncateDescription } from '../src/cache-pipeline/truncate.js'
import { canonicalizeTools, canonicalizeValue } from '../src/cache-pipeline/canonical.js'

// 只造内存夹具，不读时间、不写文件、不发网络；不依赖宿主 API。
function rules(overrides = {}) {
  return { ...SLIM_RULE_DEFAULTS, minSchemaChars: 0, maxSchemaChars: 100000, ...overrides }
}

function schema(properties = {}) {
  return { type: 'object', properties, description: '中文描述'.repeat(1000) }
}

function assemble(pipeline, tools) {
  const assembly = { tools, sections: [], contexts: [], variables: {} }
  return pipeline.hooks[0].handler(assembly, {}, async () => assembly)
}

test('兼容：非对象配置永不抛且完整回默认值', () => {
  for (const raw of [null, undefined, 0, -3, NaN, Infinity, '', '配置', [], [1]]) {
    assert.doesNotThrow(() => assert.deepEqual(normalizeConfig(raw), DEFAULTS))
  }
})

test('兼容：已知键非法类型回退，不把字符串或数字当布尔值', () => {
  const actual = normalizeConfig({
    truncation: { maxDepth: '3', enabled: 'yes', keepFull: 1, shadowPrefixes: {} },
    ordering: { enabled: 0, verify: true },
    debug: { logOnce: 0, logLevel: 123, maxLoggedTools: '0' },
  })
  assert.deepEqual(actual, DEFAULTS)
  assert.deepEqual(normalizeConfig({ truncation: [], ordering: 'x', debug: null }), DEFAULTS)
})

// 区间来自 config.js NUMBER_RULES；maxBranches 的配置下限为 1，执行截联合时才保底 2。
const ranges = [
  ['truncation', 'minSchemaChars', 0, 1000000],
  ['truncation', 'maxSchemaChars', 200, 1000000],
  ['truncation', 'maxDepth', 0, 6],
  ['truncation', 'topDescriptionChars', 0, 4000],
  ['truncation', 'nestedDescriptionChars', 0, 4000],
  ['truncation', 'descriptionDepth', 0, 6],
  ['truncation', 'maxDescriptionChars', 0, 8000],
  ['truncation', 'maxBranches', 1, 64],
  ['ordering', 'maxDepth', 0, 512],
  ['ordering', 'circuitBreaker', 0, 1000],
  ['debug', 'maxLoggedTools', 0, 1000],
]
for (const [group, key, min, max] of ranges) {
  test(`兼容：${group}.${key} 的 clamp、整数化与非有限值回退`, () => {
    for (const [raw, expected] of [
      [min - 1, min], [min, min], [max, max], [max + 1, max], [-100, min],
      [min + 0.9, min], [NaN, DEFAULTS[group][key]],
      [Infinity, DEFAULTS[group][key]], [-Infinity, DEFAULTS[group][key]],
    ]) {
      assert.equal(normalizeConfig({ [group]: { [key]: raw } })[group][key], expected)
    }
  })
}

test('兼容：未知键在顶层及每个分组被丢弃', () => {
  const actual = normalizeConfig({ unknown: 1, truncation: { unknown: 2 }, ordering: { unknown: 3 }, debug: { unknown: 4 } })
  assert.deepEqual(actual, DEFAULTS)
  for (const object of [actual, actual.truncation, actual.ordering, actual.debug]) {
    assert.equal(Object.hasOwn(object, 'unknown'), false)
  }
})

test('兼容：扁平旧键仍映射，分组与新名字优先', () => {
  const actual = normalizeConfig({ shadowPrefixes: ['legacy__'], keepFull: ['safe'], minChars: 13, canonicalizeTools: false, dryRun: true })
  assert.deepEqual(actual.truncation.shadowPrefixes, ['legacy__'])
  assert.deepEqual(actual.truncation.keepFull, ['safe'])
  assert.equal(actual.truncation.minSchemaChars, 13)
  assert.equal(actual.truncation.dryRun, true)
  assert.equal(actual.ordering.enabled, false)
  const preferred = normalizeConfig({ maxDepth: 6, minSchemaChars: 20, minChars: 10, canonicalizeTools: false, truncation: { maxDepth: 2 }, ordering: { enabled: true } })
  assert.equal(preferred.truncation.maxDepth, 2)
  assert.equal(preferred.truncation.minSchemaChars, 20)
  assert.equal(preferred.ordering.enabled, true)
})

test('兼容：debug.logOnce 严格布尔，日志上限 0 保留、负数归零', () => {
  for (const raw of [0, -1]) {
    const actual = normalizeConfig({ debug: { logOnce: raw, maxLoggedTools: raw } })
    assert.equal(actual.debug.logOnce, true)
    assert.equal(actual.debug.maxLoggedTools, 0)
  }
  assert.equal(normalizeConfig({ debug: { logOnce: false } }).debug.logOnce, false)
})

test('兼容：配置 getter 抛错时仍完整回默认值', () => {
  const hostile = Object.defineProperty({}, 'truncation', { enumerable: true, get() { throw new Error('配置 getter') } })
  assert.doesNotThrow(() => assert.deepEqual(normalizeConfig(hostile), DEFAULTS))
})

test('兼容：无原型 schema、__proto__ 与 constructor 自有键不污染原型', () => {
  const properties = Object.assign(Object.create(null), JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"number"}}'))
  const input = Object.assign(Object.create(null), schema(properties))
  const result = slimParameters(input, rules())
  assert.ok(result)
  assert.ok(selfcheck(result.parameters))
  assert.equal(Object.hasOwn(result.parameters.properties, '__proto__'), true)
  assert.equal(Object.hasOwn(result.parameters.properties, 'constructor'), true)
  assert.equal(result.parameters.properties.__proto__.type, 'string')
  assert.equal(result.parameters.properties.constructor.type, 'number')
  assert.equal(Object.getPrototypeOf(result.parameters.properties), Object.prototype)
  assert.equal(Object.getPrototypeOf(input), null)
  assert.equal(({}).polluted, undefined)
})

test('兼容：schema 序列化 getter 抛错走 invalid 拒绝，不向外抛', () => {
  const input = schema()
  Object.defineProperty(input, 'description', { enumerable: true, get() { throw new Error('schema getter') } })
  const reasons = []
  assert.doesNotThrow(() => assert.equal(slimParameters(input, rules(), { onReject: (reason) => reasons.push(reason) }), undefined))
  assert.deepEqual(reasons, ['invalid'])
})

test('兼容：根字段 getter 抛错被纯函数边界吞回，不影响后续健康输入', () => {
  const input = Object.defineProperty({}, 'type', { enumerable: true, get() { throw new Error('根 getter') } })
  assert.doesNotThrow(() => assert.equal(slimParameters(input, rules()), undefined))
  assert.ok(slimParameters(schema(), rules()))
})

test('兼容：超过 maxDepth 的嵌套坍缩，长 description 仍确定性瘦身', () => {
  let deep = { type: 'string', description: '深'.repeat(2000) }
  for (let i = 0; i < 10; i += 1) deep = { type: 'object', properties: { child: deep } }
  const input = schema({ deep })
  const result = slimParameters(input, rules({ maxDepth: 1 }))
  assert.ok(result)
  assert.ok(result.collapsedNodes > 0)
  assert.equal(result.parameters.properties.deep.properties.child.additionalProperties, true)
  assert.ok(codePointLength(result.parameters.description) <= 142) // 140 窗口 + 软后缀。
  assert.equal(JSON.stringify(result), JSON.stringify(slimParameters(input, rules({ maxDepth: 1 }))))
})

test('兼容：空 enum 当前被接受（预期应拒绝不可满足 schema）', (t) => {
  const result = slimParameters(schema({ choice: { type: 'string', enum: [] } }), rules())
  assert.ok(result)
  assert.deepEqual(result.parameters.properties.choice.enum, [])
  assert.equal(selfcheck(result.parameters), true)
  // 当前没有逐项截 enum 的 API；直接注入“已截空”敌意结果。selfcheck 仅检查形状与 JSON，
  // 不检查 enum 非空。预期：此类不可满足 schema 应走 selfcheck 拒绝；只记录，不改实现。
  t.skip('已知缺口：空 enum 未被 selfcheck 拒绝')
})

test('兼容：预算 skeleton 保留 enum 全集，不造空 enum、不静默放宽（0.6.0）', () => {
  const enumValues = Array.from({ length: 100 }, (_, i) => `选项${i}${'长'.repeat(30)}`)
  const input = schema({ choice: { type: 'string', enum: enumValues } })
  input['x-padding'] = '保留的非注解扩展'.repeat(200) // 强制所有深度候选超预算，进入 skeleton。
  const result = slimParameters(input, rules({ maxSchemaChars: 200, maxDepth: 0, topDescriptionChars: 0 }))
  assert.ok(result)
  // 0.6.0：枚举全集保留；不再出现「只剩 type: string」的静默放宽。
  assert.deepEqual(result.parameters.properties.choice, { type: 'string', enum: enumValues })
  assert.equal(result.enumsKept >= 1, true)
})

for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
  test(`兼容：默认 truncateUnions:false 不截断 ${keyword}`, () => {
    const branches = Array.from({ length: 9 }, (_, i) => ({ type: 'string', const: `分支${i}` }))
    const result = slimParameters(schema({ choice: { [keyword]: branches } }), rules({ maxBranches: 2 }))
    assert.ok(result)
    assert.equal(SLIM_RULE_DEFAULTS.truncateUnions, false)
    assert.deepEqual(result.parameters.properties.choice[keyword], branches)
  })
}

test('兼容：打开联合截断也不截 prefixItems，位置与数量保持', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ type: 'string', const: i }))
  const result = slimParameters(schema({ tuple: { type: 'array', prefixItems: items } }), rules({ truncateUnions: true, maxBranches: 1 }))
  assert.ok(result)
  assert.deepEqual(result.parameters.properties.tuple.prefixItems, items)
})

test('兼容：循环 schema 在遍历前 invalid 拒绝，无栈溢出且无输入修改', () => {
  const input = schema()
  input.properties.self = input
  const reasons = []
  assert.doesNotThrow(() => assert.equal(slimParameters(input, rules(), { onReject: (reason) => reasons.push(reason) }), undefined))
  assert.deepEqual(reasons, ['invalid'])
  assert.equal(input.properties.self, input)
})

test('兼容：截断处理空白、空字符串、单码点及非法 max', () => {
  const empty = { text: '', truncated: false, beforeCodePoints: 0, afterCodePoints: 0 }
  for (const text of ['', ' \n\t ']) assert.deepEqual(truncateDescription(text, 3), empty)
  for (const max of [0, -1, NaN]) assert.deepEqual(truncateDescription('中文😀', max), empty)
  for (const text of ['中', '😀']) {
    assert.deepEqual(truncateDescription(text, 1), { text, truncated: false, beforeCodePoints: 1, afterCodePoints: 1 })
  }
})

test('兼容：中文与 ZWJ emoji 按码点，空后缀时输出不超 max', () => {
  for (const text of ['中文描述不能按 UTF-16 猜长度', '👨‍👩‍👧', '😀中文👨‍👩‍👧']) {
    for (let max = 1; max <= codePointLength(text); max += 1) {
      const result = truncateDescription(text, max, { suffix: '' })
      assert.ok(codePointLength(result.text) <= max)
      assert.equal(result.afterCodePoints, codePointLength(result.text))
    }
  }
  // README 已声明码点安全 ≠ 字素安全；不会许诺保住整个 ZWJ 家庭字素。
  assert.equal(truncateDescription('👨‍👩‍👧', 2, { suffix: '' }).text, '👨‍')
})

test('兼容：默认后缀当前超过 max（严格上限预期与旧契约不一致）', (t) => {
  const result = truncateDescription('中文描述很长', 2)
  assert.equal(result.text, '中文 …')
  assert.equal(codePointLength(result.text), 4)
  // truncate.js 与现有测试明确约定 max + 2。任务要求总长 <= max，但不能改实现/旧测试；
  // 严格预期暂跳过，上条以公开 suffix:'' 验证硬上限；不把旧契约伪装成通过。
  t.skip('契约差异：默认软后缀不计入 max，严格总长上限未实现')
})

test('兼容：深层对象键排序、数组与工具列表保序且不改输入', () => {
  let value = { z: 1, a: 2 }
  for (let i = 0; i < 20; i += 1) value = { z: i, a: value }
  const input = [{ name: 'z', parameters: { z: value, a: ['后', '前', { z: 1, a: 2 }] } }, { name: 'a' }]
  const before = JSON.stringify(input)
  const report = canonicalizeTools(input, { verify: 'length' })
  assert.ok(report.tools)
  assert.deepEqual(report.tools.map((tool) => tool.name), ['z', 'a'])
  assert.deepEqual(report.tools[0].parameters.a.slice(0, 2), ['后', '前'])
  assert.deepEqual(Object.keys(report.tools[0].parameters.a[2]), ['a', 'z'])
  let current = canonicalizeValue(value)
  for (let i = 0; i <= 20; i += 1) {
    assert.deepEqual(Object.keys(current), ['a', 'z'])
    current = current.a
  }
  assert.equal(JSON.stringify(input), before)
  assert.equal(JSON.stringify(report.tools).length, before.length)
})

test('兼容：maxDepth 超限子树保持原引用、原键序', () => {
  const untouched = { z: 1, a: { z: 2, a: 3 } }
  const input = { z: untouched, a: 1 }
  const output = canonicalizeValue(input, { maxDepth: 0 })
  assert.deepEqual(Object.keys(output), ['a', 'z'])
  assert.equal(output.z, untouched)
  assert.deepEqual(Object.keys(output.z), ['z', 'a'])
  const report = canonicalizeTools([{ parameters: untouched, name: 'x' }], { maxDepth: 0, verify: 'length' })
  assert.equal(report.tools[0].parameters, untouched)
})

test('兼容：不稳定 getter 可确定触发 length-mismatch，自检不发送候选', () => {
  let calls = 0
  const tool = { name: 'getter' }
  Object.defineProperty(tool, 'parameters', { enumerable: true, get() { calls += 1; return { value: '长'.repeat(calls) } } })
  const report = canonicalizeTools([tool], { verify: 'length' })
  assert.equal(calls, 2)
  assert.equal(report.reason, 'length-mismatch')
  assert.equal(report.changed, false)
  assert.equal(Object.hasOwn(report, 'tools'), false)
})

test('兼容：排序把 __proto__ 当普通数据键，不污染 Object.prototype', () => {
  const input = JSON.parse('{"z":0,"__proto__":{"polluted":true},"constructor":{"z":1,"a":2}}')
  for (const output of [canonicalizeValue(input), canonicalizeTools([input]).tools[0]]) {
    assert.equal(Object.hasOwn(output, '__proto__'), true)
    assert.deepEqual(Object.keys(output), ['__proto__', 'constructor', 'z'])
    assert.equal(Object.getOwnPropertyDescriptor(output, '__proto__').value.polluted, true)
    assert.equal(Object.getPrototypeOf(output), Object.prototype)
    assert.ok(JSON.stringify(output).includes('"__proto__"'))
  }
  assert.equal(({}).polluted, undefined)
})

test('兼容：坏工具局部隔离，不妨碍健康工具瘦身且不修改其它输入', async () => {
  class NonPlain { constructor() { this.name = 'mcp__bad'; this.parameters = null } }
  const bad = [new NonPlain(), null, 42, 'x', [], { description: '缺 name', parameters: schema() }, { name: 'mcp__null', parameters: null }, { name: 'mcp__text', parameters: 'schema' }]
  const healthy = { name: 'mcp__healthy', description: '健康', parameters: schema() }
  const unrelated = { name: 'core', parameters: { z: 1, a: 2 } }
  const before = JSON.stringify([bad, healthy, unrelated])
  // 关排序才能单独断言未处理元素引用；默认两阶段另有下一条覆盖。
  const pipeline = createCachePipeline(normalizeConfig({ ordering: { enabled: false } }))
  const result = await assemble(pipeline, [...bad, healthy, unrelated])
  bad.forEach((tool, i) => assert.equal(result.tools[i], tool))
  assert.notEqual(result.tools[bad.length], healthy)
  assert.equal(result.tools[bad.length + 1], unrelated)
  assert.equal(JSON.stringify([bad, healthy, unrelated]), before)
  assert.equal(pipeline.inspect().failed, 0)
})

test('兼容：默认两阶段容忍坏工具，健康工具结果等于独立处理', async () => {
  const healthy = { name: 'mcp__healthy', parameters: schema() }
  const bad = [null, 'x', new Map(), { description: '缺 name' }, { name: 'mcp__null', parameters: null }, { name: 'mcp__text', parameters: 'schema' }]
  const before = JSON.stringify(bad)
  const mixed = await assemble(createCachePipeline(normalizeConfig()), [...bad, healthy])
  const alone = await assemble(createCachePipeline(normalizeConfig()), [healthy])
  assert.equal(JSON.stringify(mixed.tools.at(-1)), JSON.stringify(alone.tools[0]))
  assert.equal(JSON.stringify(mixed.tools.slice(0, -1)), before)
  assert.equal(JSON.stringify(bad), before)
})

test('兼容：tools 不是数组时原 assembly 透传、不计处理次数', async () => {
  const pipeline = createCachePipeline(normalizeConfig())
  for (const tools of [null, undefined, 0, 'tools', {}]) {
    const input = { tools, sections: ['原样'] }
    assert.equal(await pipeline.hooks[0].handler(input, {}, async () => input), input)
  }
  assert.equal(pipeline.inspect().assembleCalls, 0)
})

test('兼容：inspect 原始快照可 stringify，递归不含 undefined 值', async () => {
  const pipeline = createCachePipeline(normalizeConfig())
  const check = (value) => {
    assert.notEqual(value, undefined)
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) check(child)
    }
  }
  for (const snapshot of [pipeline.inspect(), (await assemble(pipeline, []), pipeline.inspect())]) {
    assert.doesNotThrow(() => JSON.stringify(snapshot))
    check(snapshot)
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  }
})
