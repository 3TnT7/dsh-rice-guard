import test from 'node:test'
import assert from 'node:assert/strict'

import { SLIM_RULE_DEFAULTS, selfcheck, slimParameters } from '../src/cache-pipeline/slim.js'
import { codePointLength } from '../src/cache-pipeline/truncate.js'

function rules(overrides = {}) {
  return {
    ...SLIM_RULE_DEFAULTS,
    minSchemaChars: 0,
    maxSchemaChars: 100000,
    maxDepth: 4,
    descriptionDepth: 4,
    ...overrides,
  }
}

/** Add a large root description so every fixture starts above `minSchemaChars`. */
function padded(schema) {
  const copy = JSON.parse(JSON.stringify(schema))
  copy.description = 'Root padding. '.repeat(300)
  return copy
}

function bigParameters() {
  const properties = {}
  for (let i = 0; i < 10; i += 1) {
    properties[`field_${i}`] = {
      type: 'object',
      description: `Field ${i} description `.repeat(10),
      properties: {
        term: { type: 'string', description: 'term '.repeat(40), examples: ['one', 'two'] },
        options: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 10, minimum: 1 },
            deep: { type: 'object', properties: { x: { type: 'string' } } },
          },
          required: ['limit'],
        },
      },
      required: ['term', 'ghost'],
    }
  }
  return {
    type: 'object',
    description: 'Root. '.repeat(100),
    properties,
    required: ['field_0', 'ghost'],
  }
}

test('non-schema inputs are left alone', () => {
  assert.equal(slimParameters(null, rules()), undefined)
  assert.equal(slimParameters(undefined, rules()), undefined)
  assert.equal(slimParameters([], rules()), undefined)
  assert.equal(slimParameters('{}', rules()), undefined)
  assert.equal(slimParameters(42, rules()), undefined)
})

test('a root that is not a callable object schema is refused', () => {
  assert.equal(slimParameters(padded({ type: 'array', properties: {} }), rules()), undefined)
  assert.equal(slimParameters({ type: 'object', properties: 'nope' }, rules()), undefined)
  assert.equal(slimParameters({ type: ['object', 'null'], properties: {} }, rules()), undefined)
})

test('schemas below minSchemaChars are not touched', () => {
  const tiny = padded({ type: 'object', properties: { a: { type: 'string' } } })
  assert.equal(slimParameters(tiny, rules({ minSchemaChars: 500000 })), undefined)
})

test('a candidate that is not smaller is refused', () => {
  const tiny = { type: 'object', properties: { a: { type: 'string' } } }
  const reasons = []
  const result = slimParameters(tiny, rules({ maxSchemaChars: 200 }), { onReject: (r) => reasons.push(r) })
  assert.equal(result, undefined)
  assert.deepEqual(reasons, ['not-smaller'])
})

test('a large schema shrinks and keeps a callable object root', () => {
  const result = slimParameters(bigParameters(), rules())
  assert.ok(result)
  assert.ok(result.charsAfter < result.charsBefore)
  assert.equal(result.charsBefore > 700, true)
  assert.equal(result.parameters.type, 'object')
  assert.equal(result.parameters.additionalProperties, false)
  assert.equal(typeof result.parameters.properties, 'object')
  assert.ok(Object.keys(result.parameters.properties).length > 0)
  // The root description is clamped to topDescriptionChars + the soft suffix.
  assert.ok(codePointLength(result.parameters.description) <= 142)
  // Every kept description was clamped too.
  for (const entry of Object.values(result.parameters.properties)) {
    if (typeof entry.description === 'string') assert.ok(codePointLength(entry.description) <= 142)
  }
  // The product must still be plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(result.parameters)), result.parameters)
})

test('required is pruned to names that still exist in properties', () => {
  const schema = padded({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['a', 'b', 'ghost'],
  })
  const result = slimParameters(schema, rules())
  assert.ok(result)
  assert.deepEqual(result.parameters.required, ['a', 'b'])

  const empty = padded({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['ghost'],
  })
  const emptyResult = slimParameters(empty, rules())
  assert.ok(emptyResult)
  assert.equal(Object.prototype.hasOwnProperty.call(emptyResult.parameters, 'required'), false)
})

test('__proto__ inside properties survives as an own data property', () => {
  const schema = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"number"}},"required":["__proto__"]}',
  )
  schema.description = 'Root padding. '.repeat(300)

  const result = slimParameters(schema, rules())
  assert.ok(result)
  const properties = result.parameters.properties

  assert.ok(Object.prototype.hasOwnProperty.call(properties, '__proto__'))
  assert.ok(Object.keys(properties).includes('__proto__'))
  assert.ok(JSON.stringify(result.parameters).includes('"__proto__"'))
  assert.deepEqual(Object.keys(properties), ['__proto__', 'a'])
  assert.deepEqual(result.parameters.required, ['__proto__'])
  // Still a normal object (not Object.create(null)) and the prototype is intact.
  assert.equal(Object.getPrototypeOf(properties), Object.prototype)
  assert.equal(properties.__proto__.type, 'string')
})

test('prefixItems is never truncated, even with truncateUnions on', () => {
  const schema = padded({
    type: 'object',
    properties: {
      tuple: {
        type: 'array',
        prefixItems: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'array', items: { type: 'string' } },
        ],
      },
    },
  })

  const result = slimParameters(schema, rules({ truncateUnions: true, maxBranches: 2 }))
  assert.ok(result)
  const prefixItems = result.parameters.properties.tuple.prefixItems
  assert.equal(prefixItems.length, 5)
  assert.deepEqual(
    prefixItems.map((entry) => entry.type),
    ['string', 'number', 'boolean', 'object', 'array'],
  )
})

test('union truncation is off by default and never keeps fewer than two branches', () => {
  const branches = [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array' },
    { type: 'object' },
  ]
  const schema = padded({
    type: 'object',
    properties: { u: { oneOf: branches }, v: { anyOf: branches } },
  })

  const off = slimParameters(schema, rules({ truncateUnions: false }))
  assert.ok(off)
  assert.equal(off.parameters.properties.u.oneOf.length, 5)

  const on = slimParameters(schema, rules({ truncateUnions: true, maxBranches: 2 }))
  assert.ok(on)
  assert.equal(on.parameters.properties.u.oneOf.length, 2)
  assert.equal(on.parameters.properties.v.anyOf.length, 2)
  assert.equal(on.parameters.properties.u.description, '(variants truncated)')

  const floor = slimParameters(schema, rules({ truncateUnions: true, maxBranches: 1 }))
  assert.ok(floor)
  assert.equal(floor.parameters.properties.u.oneOf.length, 2)
})

test('annotations are dropped unless dropAnnotations is false', () => {
  const schema = padded({
    type: 'object',
    properties: {
      a: { type: 'string', examples: ['one'], title: 'A', $comment: 'c', deprecated: true },
    },
  })

  const dropped = slimParameters(schema, rules())
  assert.ok(dropped)
  assert.equal('examples' in dropped.parameters.properties.a, false)
  assert.equal('title' in dropped.parameters.properties.a, false)
  assert.equal('$comment' in dropped.parameters.properties.a, false)
  assert.equal('deprecated' in dropped.parameters.properties.a, false)

  const kept = slimParameters(schema, rules({ dropAnnotations: false }))
  assert.ok(kept)
  assert.deepEqual(kept.parameters.properties.a.examples, ['one'])
  assert.equal(kept.parameters.properties.a.title, 'A')
})

test('descriptions are clamped per depth, in code points', () => {
  const schema = padded({
    type: 'object',
    properties: {
      a: { type: 'string', description: 'nested '.repeat(50) },
      b: {
        type: 'object',
        properties: {
          c: { type: 'object', description: 'deep description', properties: { d: { type: 'string' } } },
        },
      },
    },
  })

  const result = slimParameters(schema, rules({ descriptionDepth: 1, nestedDescriptionChars: 60 }))
  assert.ok(result)
  // 140 code points + ' …', minus the trailing space the boundary leaves and
  // `trimEnd` removes → 139 + 2 = 141. The suffix is a soft limit.
  assert.equal(codePointLength(result.parameters.description), 141)
  assert.equal(codePointLength(result.parameters.properties.a.description), 62)
  assert.equal('description' in result.parameters.properties.b.properties.c, false)
  assert.ok(result.droppedDescriptionKeys > 0)
})

test('deep nodes collapse to a callable stub; non-object types keep no additionalProperties', () => {
  const schema = padded({
    type: 'object',
    properties: {
      a: {
        type: 'object',
        properties: {
          b: { type: 'object', description: 'b description', properties: { c: { type: 'string' } } },
          s: { type: 'string', description: 's description' },
        },
      },
    },
  })

  const collapsed = slimParameters(schema, rules({ maxDepth: 1 }))
  assert.ok(collapsed)
  const b = collapsed.parameters.properties.a.properties.b
  assert.equal(b.type, 'object')
  assert.equal(b.additionalProperties, true)
  assert.match(b.description, /nested fields omitted/)
  assert.ok(collapsed.collapsedNodes >= 1)

  const stringNode = collapsed.parameters.properties.a.properties.s
  assert.equal(stringNode.type, 'string')
  assert.equal('additionalProperties' in stringNode, false)
})

test('an object schema without an explicit type still collapses as an object', () => {
  const schema = padded({
    type: 'object',
    properties: {
      a: { type: 'object', properties: { b: { properties: { x: { type: 'string' } } } } },
    },
  })
  const result = slimParameters(schema, rules({ maxDepth: 1 }))
  assert.ok(result)
  const b = result.parameters.properties.a.properties.b
  assert.equal(b.type, 'object')
  assert.equal(b.additionalProperties, true)
})

test('a schema over budget falls back to a name/type skeleton', () => {
  const many = { type: 'object', description: 'Root padding. '.repeat(300), properties: {} }
  for (let i = 0; i < 200; i += 1) {
    many.properties[`p${i}`] = { type: 'string', description: `Param ${i} description. `.repeat(10) }
  }

  const result = slimParameters(many, rules({ maxDepth: 1, maxSchemaChars: 200 }))
  assert.ok(result)
  assert.ok(result.charsAfter < result.charsBefore)
  assert.equal(result.parameters.additionalProperties, false)
  assert.equal(Object.keys(result.parameters.properties).length, 200)
  assert.deepEqual(result.parameters.properties.p7, { type: 'string' })
})

test('slimming is deterministic; re-slimming is a no-op', () => {
  const schema = bigParameters()
  const first = slimParameters(schema, rules())
  const second = slimParameters(schema, rules())
  assert.ok(first)
  assert.ok(second)
  assert.equal(JSON.stringify(first.parameters), JSON.stringify(second.parameters))

  const third = slimParameters(first.parameters, rules())
  if (third !== undefined) {
    assert.equal(JSON.stringify(third.parameters), JSON.stringify(first.parameters))
  }
})

test('selfcheck validates the product shape and rejects non-JSON values', () => {
  assert.equal(selfcheck({ type: 'object', properties: {} }), true)
  assert.equal(selfcheck({ type: 'object' }), false)
  assert.equal(selfcheck({ type: 'array', properties: {} }), false)
  assert.equal(selfcheck({ type: 'object', properties: { a: 42 } }), false)
  assert.equal(selfcheck({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }), false)
  assert.equal(selfcheck({ type: 'object', properties: { a: { type: 'string', default: undefined } } }), false)
  assert.equal(selfcheck({ type: 'object', properties: { a: { type: 'string', default: NaN } } }), false)
  assert.equal(selfcheck({ type: 'object', properties: { a: { type: 'string', default: 1n } } }), false)
  assert.equal(selfcheck({ type: 'object', properties: { a: { type: 'string', default: () => 1 } } }), false)

  const cyclic = { type: 'object', properties: {} }
  cyclic.properties.self = cyclic
  assert.equal(selfcheck(cyclic), false)
})

test('a product that fails selfcheck is refused, not registered', () => {
  class Weird {
    constructor() {
      this.x = 1
    }
  }

  const schema = padded({ type: 'object', properties: { a: { type: 'string' } } })
  schema.properties.a = new Weird()

  const reasons = []
  const result = slimParameters(schema, rules(), { onReject: (reason) => reasons.push(reason) })
  assert.equal(result, undefined)
  assert.deepEqual(reasons, ['selfcheck'])
})
