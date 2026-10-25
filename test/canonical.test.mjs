import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalizeTools,
  canonicalizeValue,
  isPlainObject,
  jsonLength,
} from '../src/cache-pipeline/canonical.js'

test('sorts object keys recursively while preserving arrays', () => {
  const input = { b: 1, a: { z: 1, y: 2 }, c: [3, 1, { q: 1, p: 2 }] }
  const output = canonicalizeValue(input)

  assert.deepEqual(Object.keys(output), ['a', 'b', 'c'])
  assert.deepEqual(Object.keys(output.a), ['y', 'z'])
  assert.deepEqual(output.c.slice(0, 2), [3, 1])
  assert.deepEqual(Object.keys(output.c[2]), ['p', 'q'])
  // The input is never mutated.
  assert.deepEqual(input, { b: 1, a: { z: 1, y: 2 }, c: [3, 1, { q: 1, p: 2 }] })
  assert.notEqual(output, input)
})

test('uses code-unit order, not locale order', () => {
  const output = canonicalizeValue({ ä: 1, z: 2 })
  assert.deepEqual(Object.keys(output), ['z', 'ä'])
})

test('__proto__ becomes an own data property and stays visible to JSON', () => {
  const input = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"number"}}}')
  const output = canonicalizeValue(input)

  assert.ok(Object.prototype.hasOwnProperty.call(output.properties, '__proto__'))
  assert.ok(Object.keys(output.properties).includes('__proto__'))
  assert.ok(JSON.stringify(output).includes('"__proto__"'))
  assert.deepEqual(Object.keys(output.properties), ['__proto__', 'a'])
  assert.equal(Object.getPrototypeOf(output.properties), Object.prototype)
  assert.equal(output.properties.__proto__.type, 'string')
  // Nothing leaked into the prototype chain.
  assert.equal(Object.getPrototypeOf(output), Object.prototype)
})

test('drops undefined-valued keys (same bytes as JSON.stringify)', () => {
  const input = { b: undefined, a: 1 }
  const output = canonicalizeValue(input)
  assert.deepEqual(Object.keys(output), ['a'])
  assert.equal(JSON.stringify(output), JSON.stringify(input))
})

test('non-plain objects are returned untouched', () => {
  class Widget {
    constructor() {
      this.b = 1
      this.a = 2
    }
  }
  const widget = new Widget()
  assert.equal(canonicalizeValue(widget), widget)

  const date = new Date()
  assert.equal(canonicalizeValue(date), date)

  const nullProto = Object.create(null)
  nullProto.b = 1
  nullProto.a = 2
  const rebuilt = canonicalizeValue(nullProto)
  assert.deepEqual(Object.keys(rebuilt), ['a', 'b'])
  assert.equal(Object.getPrototypeOf(rebuilt), Object.prototype)
  assert.equal(isPlainObject(nullProto), true)
  assert.equal(isPlainObject(date), false)
})

test('cycles and depth limits return the original subtree instead of throwing', () => {
  const cyclic = { b: 1 }
  cyclic.self = cyclic
  const output = canonicalizeValue(cyclic)
  assert.equal(output.b, 1)
  assert.equal(output.self, cyclic)

  const deep = { b: { y: 1, x: 2 }, a: 1 }
  const limited = canonicalizeValue(deep, { maxDepth: 0 })
  assert.deepEqual(Object.keys(limited), ['a', 'b'])
  assert.deepEqual(Object.keys(limited.b), ['y', 'x'])
})

test('canonicalizeValue is idempotent', () => {
  const input = JSON.parse('{"z":1,"a":{"m":[{"b":1,"a":2}],"k":2}}')
  const once = canonicalizeValue(input)
  const twice = canonicalizeValue(once)
  assert.equal(JSON.stringify(once), JSON.stringify(twice))
})

test('canonicalizeTools preserves list order and malformed elements', () => {
  const date = new Date()
  const report = canonicalizeTools([{ b: 1, a: 2 }, null, date, 'x'])

  assert.equal(report.changed, true)
  assert.ok(Array.isArray(report.tools))
  assert.equal(report.tools.length, 4)
  assert.equal(JSON.stringify(report.tools[0]), JSON.stringify({ a: 2, b: 1 }))
  assert.equal(report.tools[1], null)
  assert.equal(report.tools[2], date)
  assert.equal(report.tools[3], 'x')
})

test('canonicalizeTools rejects a non-array input without throwing', () => {
  assert.deepEqual(canonicalizeTools(null), { changed: false, reason: 'not-array', protoKeysSeen: 0 })
  assert.deepEqual(canonicalizeTools({}), { changed: false, reason: 'not-array', protoKeysSeen: 0 })
  assert.deepEqual(canonicalizeTools('x'), { changed: false, reason: 'not-array', protoKeysSeen: 0 })
})

test('an empty tool list is accepted', () => {
  const report = canonicalizeTools([])
  assert.equal(report.changed, true)
  assert.deepEqual(report.tools, [])
})

test('verify:length keeps the sorted tools when bytes are preserved', () => {
  const tools = [
    { name: 'x', parameters: { z: 1, y: 2, required: ['b', 'a'] } },
    { name: 'a', parameters: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } } },
  ]
  const before = jsonLength(tools)
  const report = canonicalizeTools(tools)

  assert.equal(report.changed, true)
  assert.ok(Array.isArray(report.tools))
  assert.equal(jsonLength(report.tools), before)
  assert.deepEqual(report.tools[0].parameters.required, ['b', 'a'])
})

test('a serialization length change triggers the length-mismatch fallback', () => {
  let calls = 0
  const unstable = {
    name: 'unstable',
    parameters: {},
    toJSON() {
      calls += 1
      return { n: calls === 1 ? 'a' : 'bb' }
    },
  }

  const report = canonicalizeTools([unstable])
  assert.equal(report.changed, false)
  assert.equal(report.reason, 'length-mismatch')
  assert.equal(report.tools, undefined)

  // With the check disabled the same input is accepted.
  const unverified = canonicalizeTools([unstable], { verify: 'none' })
  assert.ok(Array.isArray(unverified.tools))
})

test('protoKeysSeen counts __proto__ occurrences', () => {
  const parameters = JSON.parse('{"__proto__":{"type":"string"},"b":1}')
  const report = canonicalizeTools([{ name: 'p', parameters }])
  assert.equal(report.protoKeysSeen, 1)
  assert.ok(JSON.stringify(report.tools).includes('"__proto__"'))
})

test('jsonLength reports -1 for unserializable values', () => {
  assert.equal(jsonLength({ a: 1 }), '{"a":1}'.length)
  assert.equal(jsonLength({ a: 1n }), -1)
  assert.equal(jsonLength(undefined), -1)
})

test('canonicalizeTools is deterministic: the same input twice yields identical bytes', () => {
  const source = [
    { name: 'x', description: 'd', parameters: { z: 1, a: { y: 2, x: 3 }, required: ['b', 'a'] } },
    { name: 'y', parameters: JSON.parse('{"__proto__":{"type":"string"},"b":1}') },
    { name: 'z', parameters: { enum: [3, 1, 2], z: 2, a: 1 } },
  ]
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const snapshot = JSON.stringify(source)

  const first = canonicalizeTools(clone(source))
  const second = canonicalizeTools(clone(source))

  assert.ok(Array.isArray(first.tools))
  assert.ok(Array.isArray(second.tools))
  assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools))
  assert.equal(first.protoKeysSeen, second.protoKeysSeen)
  // The input is never mutated, and array order is preserved.
  assert.equal(JSON.stringify(source), snapshot)
  assert.deepEqual(first.tools.map((tool) => tool.name), ['x', 'y', 'z'])
  assert.deepEqual(first.tools[2].parameters.enum, [3, 1, 2])
})

