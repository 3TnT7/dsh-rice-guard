import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SUFFIX,
  codePointLength,
  truncateDescription,
} from '../src/cache-pipeline/truncate.js'

/** Matches a lone high or low surrogate (i.e. a broken emoji after cutting). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const EMPTY_RESULT = { text: '', truncated: false, beforeCodePoints: 0, afterCodePoints: 0 }

test('codePointLength counts code points, not UTF-16 units', () => {
  assert.equal(codePointLength('abc'), 3)
  assert.equal(codePointLength('😀'), 1)
  assert.equal(codePointLength('a😀b'), 3)
  assert.equal(codePointLength(''), 0)
  assert.equal(codePointLength(42), 0)
  assert.equal(codePointLength(null), 0)
})

test('short text comes back trimmed and untruncated', () => {
  const result = truncateDescription('  hello  ', 10)
  assert.deepEqual(result, { text: 'hello', truncated: false, beforeCodePoints: 5, afterCodePoints: 5 })
})

test('invalid max / non-string / blank input yields the empty result', () => {
  assert.deepEqual(truncateDescription('hello', 0), EMPTY_RESULT)
  assert.deepEqual(truncateDescription('hello', -10), EMPTY_RESULT)
  assert.deepEqual(truncateDescription('hello', Number.NaN), EMPTY_RESULT)
  assert.deepEqual(truncateDescription(undefined, 10), EMPTY_RESULT)
  assert.deepEqual(truncateDescription(123, 10), EMPTY_RESULT)
  assert.deepEqual(truncateDescription('    ', 10), EMPTY_RESULT)
})

test('a cut that lands inside a surrogate pair never emits a lone surrogate', () => {
  // 9 BMP chars + one astral emoji: the 10-code-point window ends exactly on
  // the emoji. A UTF-16 `slice(0, 10)` would split the pair in half.
  const text = `${'a'.repeat(9)}😀${'b'.repeat(20)}`
  const result = truncateDescription(text, 10)

  assert.equal(result.truncated, true)
  assert.equal(LONE_SURROGATE.test(result.text), false)
  assert.ok(result.text.startsWith(`${'a'.repeat(9)}😀`))
  assert.ok(result.text.endsWith(DEFAULT_SUFFIX))
  assert.equal(result.beforeCodePoints, 30)
  assert.equal(result.afterCodePoints, codePointLength(result.text))
})

test('the emoji is simply excluded when it falls outside the window', () => {
  const text = `${'a'.repeat(10)}😀`
  const result = truncateDescription(text, 10)

  assert.equal(result.truncated, true)
  assert.equal(LONE_SURROGATE.test(result.text), false)
  assert.equal(result.text, `${'a'.repeat(10)}${DEFAULT_SUFFIX}`)
  assert.equal(result.afterCodePoints, 12)
})

test('prefers the last sentence boundary inside the window', () => {
  const text = 'First sentence. Second sentence that keeps going and going and going.'
  const result = truncateDescription(text, 20)

  assert.equal(result.text, `First sentence.${DEFAULT_SUFFIX}`)
  assert.equal(result.truncated, true)
  assert.ok(result.afterCodePoints <= 20 + codePointLength(DEFAULT_SUFFIX))
})

test('searches boundary markers in code-point coordinates', () => {
  // 20 emoji then '。' — the marker's UTF-16 index is 40/41, its code-point
  // index is 20/21. A mixed-coordinate implementation cannot find it.
  const text = `${'😀'.repeat(20)}。${'x'.repeat(50)}`
  const result = truncateDescription(text, 21)

  assert.equal(result.truncated, true)
  assert.ok(result.text.endsWith(`。${DEFAULT_SUFFIX}`))
  assert.equal(LONE_SURROGATE.test(result.text), false)
})

test('no boundary: cuts at max code points and reports the soft limit', () => {
  const text = '汉'.repeat(300)
  const result = truncateDescription(text, 260)

  assert.equal(result.truncated, true)
  assert.equal(codePointLength(result.text), 262)
  assert.ok(result.text.endsWith(DEFAULT_SUFFIX))
  assert.equal(result.afterCodePoints, 262)
  assert.equal(result.beforeCodePoints, 300)
})

test('custom markers, suffix and keep-ratio are honored', () => {
  const result = truncateDescription('alpha|beta|gamma', 9, { boundaryMarkers: ['|'], suffix: '...' })
  assert.equal(result.text, 'alpha|...')

  // A boundary too close to the start is ignored (2 < 12 * 0.9), so the full
  // 12-code-point window survives.
  const early = truncateDescription('a. bb cccc ddddd eeeeee', 12, { suffix: '', minKeepRatio: 0.9 })
  assert.equal(early.text, 'a. bb cccc d')
})

test('trailing whitespace is trimmed before the suffix is appended', () => {
  const result = truncateDescription(`abcdef      ${'x'.repeat(30)}`, 12)
  assert.equal(result.text, `abcdef${DEFAULT_SUFFIX}`)
})

test('truncation is deterministic (identical bytes on a second run)', () => {
  const text = `${'Long sentence. '.repeat(40)}😀 tail`
  const first = truncateDescription(text, 50)
  const second = truncateDescription(text, 50)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})
