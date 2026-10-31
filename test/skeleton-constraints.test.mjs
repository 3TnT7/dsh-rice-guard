/**
 * 职责：验证 0.6.0 的「最小调用约束优先于预算」——skeleton / collapse 不再静默
 * 丢弃 `enum` / `items`（《007》§3.3），并验证锚点/资源/方言标识与元组尾部约束。
 * 依赖的 DSH 契约：无；纯函数 + 模块门面。
 * 关键决策与依据：通过 slimParameters 的返回值验证语义；宽松预算隔离普通遍历
 * 与 collapse，用 padding 强制 skeleton，避免一条路径的保留行为掩盖另一条缺陷。
 * 已知边界：只保证最小约束（类型 / enum 全集 / 一层元素结构）；`$ref`、组合分支、
 * 深层嵌套不做猜测式重写；复杂度换来的体积上限仍由「严格变小 + selfcheck」兜底。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.js'
import { slimParameters } from '../src/cache-pipeline/slim.js'
import { createCachePipeline } from '../src/cache-pipeline.js'

/** 预算很紧：强制进入 skeleton / collapse 路径。 */
const TIGHT = Object.freeze({
  minSchemaChars: 0,
  maxSchemaChars: 200,
  maxDepth: 0,
  topDescriptionChars: 0,
  nestedDescriptionChars: 0,
  descriptionDepth: 0,
  maxDescriptionChars: 0,
})

const root = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) })

test('skeleton 保留数组元素的 items 类型与 enum', () => {
  const input = root({
    fields: { type: 'array', items: { type: 'string', enum: ['type', 'name', 'path'] } },
  })
  input['x-padding'] = '填充'.repeat(400) // 被 skeleton 丢掉，用来制造超预算
  const result = slimParameters(input, TIGHT)
  assert.ok(result)
  assert.deepEqual(result.parameters.properties.fields, {
    type: 'array',
    items: { type: 'string', enum: ['type', 'name', 'path'] },
  })
  assert.equal(result.itemsKept >= 1, true)
})

test('skeleton 保留对象元素的一层结构与 required', () => {
  const input = root({
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  })
  input['x-padding'] = '填充'.repeat(400)
  const result = slimParameters(input, TIGHT)
  assert.ok(result)
  const files = result.parameters.properties.files
  assert.equal(files.type, 'array')
  assert.equal(files.items.type, 'object')
  assert.deepEqual(Object.keys(files.items.properties).sort(), ['content', 'path'])
  assert.deepEqual(files.items.required, ['path', 'content'])
})

test('collapse 保留 >12 项的 enum 全集（旧实现只在 ≤12 时保留）', () => {
  const many = Array.from({ length: 15 }, (_, i) => `v${i}`)
  const input = root({
    outer: {
      type: 'object',
      properties: {
        // 用长 description 撑大原文；collapse 会把它换成短提示，候选因而严格变小。
        nested: { type: 'string', enum: many, description: '详细描述'.repeat(100) },
      },
      required: ['nested'],
    },
  })
  // maxDepth 1：深度 >1 的节点走 collapse；预算 5000 保证深度 1 候选被采用。
  const result = slimParameters(input, { ...TIGHT, maxSchemaChars: 5000, maxDepth: 1 })
  assert.ok(result)
  const stub = result.parameters.properties.outer.properties.nested
  assert.equal(stub.type, 'string')
  assert.deepEqual(stub.enum, many)
})

test('collapse 保留对象数组元素的一层字段与 required', () => {
  const input = root({
    files: {
      type: 'array',
      description: '数组详细描述'.repeat(100),
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  })
  // 深度 0 + 宽松预算：files 直接 collapse，不能靠 skeleton 补回字段。
  const result = slimParameters(input, { ...TIGHT, maxSchemaChars: 5000 })
  assert.ok(result)
  assert.equal(result.collapsedNodes, 1)
  assert.equal(result.parameters.properties.files.description, 'Nested fields omitted by rice-guard.')
  assert.deepEqual(result.parameters.properties.files.items, {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  })
})

test('宽松预算保留 $anchor、$id 与 $schema 的引用解析语义', () => {
  const input = {
    ...root({ a: { $ref: '#item' }, b: { $ref: 'other.json' } }),
    additionalProperties: false,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.com/schemas/root.json',
    $defs: { item: { $anchor: 'item', type: 'string' } },
    description: '根描述'.repeat(100),
  }
  const result = slimParameters(input, { ...TIGHT, maxSchemaChars: 5000, maxDepth: 3 })
  assert.ok(result)
  assert.equal(result.collapsedNodes, 0)
  assert.equal(result.parameters.$defs.item.$anchor, 'item')
  assert.equal(result.parameters.properties.a.$ref, '#item')
  assert.equal(result.parameters.properties.b.$ref, 'other.json')
  assert.equal(result.parameters.$id, input.$id)
  assert.equal(result.parameters.$schema, input.$schema)
})

test('skeleton 同时保留 prefixItems 与 items 尾部约束', () => {
  const input = root({
    pair: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      items: false,
    },
  })
  input['x-padding'] = '填充'.repeat(400)
  const result = slimParameters(input, TIGHT)
  assert.ok(result)
  assert.equal(result.parameters['x-padding'], undefined) // 确认使用 skeleton。
  assert.deepEqual(result.parameters.properties.pair, {
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'number' }],
    items: false,
  })
})

test('skeleton 复原约束后超预算：显式标记 overBudget，而非删约束', () => {
  const many = Array.from({ length: 40 }, (_, i) => `选项${i}${'长'.repeat(10)}`)
  const input = root({ choice: { type: 'string', enum: many } })
  input['x-padding'] = '填充'.repeat(600) // 会被 skeleton 丢掉，制造「原文更大」
  const result = slimParameters(input, TIGHT)
  assert.ok(result)
  assert.deepEqual(result.parameters.properties.choice, { type: 'string', enum: many })
  assert.equal(result.overBudget, true)
})

test('pipeline 统计：enumsKept / itemsKept / oversizeSlims 进 gauge 与累计', () => {
  const pipeline = createCachePipeline(
    normalizeConfig({
      truncation: { shadowPrefixes: ['mcp__'], minSchemaChars: 0, maxSchemaChars: 200, maxDepth: 0, topDescriptionChars: 0, nestedDescriptionChars: 0, descriptionDepth: 0, maxDescriptionChars: 0 },
      ordering: { enabled: false },
      visibility: { enabled: false },
    }),
  )
  const tool = {
    name: 'mcp__big__tool',
    description: 'x',
    parameters: root({ fields: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }),
  }
  tool.parameters['x-padding'] = '填充'.repeat(400)
  const assembly = { tools: [tool] }
  return pipeline.hooks[0].handler(assembly, {}, async () => assembly).then(() => {
    const snapshot = pipeline.inspect()
    assert.equal(snapshot.shadowed, 1)
    assert.equal(snapshot.enumsKept >= 1, true)
    assert.equal(snapshot.itemsKept >= 1, true)
    assert.equal(snapshot.enumsKeptTotal >= 1, true)
    assert.equal(snapshot.itemsKeptTotal >= 1, true)
  })
})
