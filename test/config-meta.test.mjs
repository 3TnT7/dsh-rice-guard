import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/config.js'
import { CONFIG_GROUPS, CONFIG_META, META_BY_PATH, flattenLeaves } from '../src/config-meta.js'

function expectedLeaves(value, prefix = '') {
  const rows = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) rows.push(...expectedLeaves(child, path))
    else rows.push({ path, value: child })
  }
  return rows
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

test('metadata covers every DEFAULTS leaf exactly once and no others', () => {
  const expected = expectedLeaves(DEFAULTS).map(({ path }) => path).sort()
  const actual = CONFIG_META.map(({ path }) => path)
  assert.equal(new Set(actual).size, actual.length, 'paths must be unique')
  assert.deepEqual([...actual].sort(), expected)
  assert.equal(Object.keys(META_BY_PATH).length, actual.length)
  for (const entry of CONFIG_META) assert.equal(META_BY_PATH[entry.path], entry)
})

test('group order and metadata defaults match source defaults', () => {
  assert.deepEqual(CONFIG_GROUPS.map(({ id }) => id), ['truncation','visibility','ordering','freeze','storage','pricing','debug'])
  for (const { path, default: value } of CONFIG_META) {
    const [group, ...keys] = path.split('.')
    assert.ok(sameValue(value, keys.reduce((node, key) => node[key], DEFAULTS[group])), `${path} default differs`)
  }
})

test('metadata fields, kinds and numeric ranges are valid', () => {
  const groups = new Set(CONFIG_GROUPS.map(({ id }) => id))
  for (const entry of CONFIG_META) {
    for (const key of ['path','group','kind','label','summary','impact','default','recommended','risk','timing','editable']) assert.ok(key in entry, `${entry.path}: ${key} required`)
    for (const key of ['label','summary','impact','recommended']) assert.equal(typeof entry[key], 'string'), assert.ok(entry[key].trim())
    assert.ok(groups.has(entry.group), entry.path)
    assert.ok(['low','medium','high'].includes(entry.risk), entry.path)
    assert.ok(['new-session','immediate','display-only'].includes(entry.timing), entry.path)
    assert.equal(entry.editable, true)
    const [group, key] = entry.path.split('.')
    const value = DEFAULTS[group][key]
    if (entry.kind === 'boolean') assert.equal(typeof value, 'boolean', entry.path)
    if (entry.kind === 'number') {
      assert.equal(typeof value, 'number', entry.path)
      assert.ok(Number.isFinite(entry.min) && Number.isFinite(entry.max) && entry.min <= entry.max, entry.path)
      assert.ok(value >= entry.min && value <= entry.max, entry.path)
    }
    if (entry.kind === 'enum') assert.ok(Array.isArray(entry.options) && entry.options.includes(value), entry.path)
    if (entry.kind === 'string') assert.equal(typeof value, 'string', entry.path)
    if (entry.kind === 'stringList') assert.ok(Array.isArray(value) && Number.isInteger(entry.maxEntries) && entry.maxEntries > 0, entry.path)
    if (entry.kind === 'object') assert.ok(value === null || (typeof value === 'object' && !Array.isArray(value)), entry.path)
  }
})

test('flattenLeaves preserves each leaf and follows declared group order', () => {
  const leaves = flattenLeaves(DEFAULTS)
  assert.equal(leaves.length, CONFIG_META.length)
  assert.deepEqual(leaves.map(({ path }) => path), CONFIG_META.map(({ path }) => path))
  for (const { path, value } of leaves) {
    const [group, ...keys] = path.split('.')
    assert.ok(sameValue(value, keys.reduce((node, key) => node[key], DEFAULTS[group])), path)
  }
})

test('flattenLeaves never throws on hostile inputs', () => {
  const hostile = [null, undefined, 1, 'bad', [], Object.create(null), new Proxy({}, { get() { throw Error('hostile getter') } }), new Proxy({}, { ownKeys() { throw Error('hostile keys') } })]
  for (const input of hostile) assert.doesNotThrow(() => flattenLeaves(input))
})
