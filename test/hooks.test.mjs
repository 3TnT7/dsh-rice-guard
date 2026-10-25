import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../src/config.js'
import { createCachePipeline, selfcheck } from '../src/cache-pipeline.js'
import { installHooks } from '../src/hooks.js'
import { apply } from '../src/index.js'
import { canonicalizeTools, jsonLength } from '../src/cache-pipeline/canonical.js'
import { codePointLength } from '../src/cache-pipeline/truncate.js'

// `apply()` reads the persisted tuning archive; keep it out of the real home so
// tests never depend on (or write to) the user's plugin data directory.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rg-hooks-home-'))

const BIG_TOOL = 'mcp__rea__compare_web_captures'
const KEEP_FULL_TOOL = 'mcp__rea__list_names'

/**
 * Minimal fake of the DSH surface the single hook touches: `ctx.on`. There is
 * no scope, no registry and no `ctx.effect` / `ctx.inject` any more — that is
 * exactly what the v4 listener set removed.
 */
function createHarness() {
  const listeners = new Map()
  const logs = []

  const logger = {
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
    info: (message) => logs.push({ level: 'info', message }),
    debug: () => {},
  }

  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
  }

  async function assemble(assembly, next) {
    const list = listeners.get('system-prompt/assemble') ?? []
    assert.equal(list.length, 1, 'exactly one system-prompt/assemble listener must be installed')
    const nextFn = typeof next === 'function' ? next : async () => assembly
    let result
    for (const listener of list) result = await listener(assembly, {}, nextFn)
    return result
  }

  return { listeners, logs, logger, ctx, assemble }
}

function createPipeline(harness, config) {
  return createCachePipeline(normalizeConfig(config ?? {}), { logger: harness.logger })
}

function install(harness, pipeline) {
  return installHooks(harness.ctx, pipeline.hooks, { logger: harness.logger })
}

/** The shape core hands to the waterfall: `{ name, description, parameters }`. */
function projection(name, parameters, description) {
  return {
    name,
    description: description ?? 'Tool description. '.repeat(30),
    parameters,
  }
}

function makeAssembly(tools) {
  return {
    sections: [{ name: 'deploy:persona', text: 'persona' }],
    contexts: [],
    variables: { provider: 'x' },
    tools,
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function bigParameters() {
  const properties = {}
  for (let i = 0; i < 10; i += 1) {
    properties[`field_${i}`] = {
      type: 'object',
      description: `Field ${i}. `.repeat(20),
      properties: {
        term: { type: 'string', description: 'term '.repeat(40), examples: ['one'] },
        options: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
            deep: { type: 'object', properties: { x: { type: 'string' } } },
          },
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

/** An unserializable-in-a-stable-way tool: every `JSON.stringify` grows it. */
function unstableProjection(name = 'mcp__rea__unstable') {
  const tool = projection(name, bigParameters())
  let calls = 0
  tool.toJSON = () => {
    calls += 1
    return { pad: 'x'.repeat(calls) }
  }
  return tool
}

// -------------------------------------------------------------------- U1

test('U1: exactly one listener, system-prompt/assemble only', () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)

  const report = installHooks(harness.ctx, pipeline.hooks, { logger: harness.logger })

  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.installed, [{ id: 'shape-and-stabilize-tools', event: 'system-prompt/assemble' }])
  assert.deepEqual([...harness.listeners.keys()], ['system-prompt/assemble'])
  assert.equal(pipeline.hooks.length, 1)
  assert.equal(pipeline.hooks[0].kind, 'waterfall')
  assert.equal(pipeline.hooks[0].containment, 'own-errors-only')
  // v4 has no teardown: nothing is registered, so nothing needs disposing.
  assert.equal('dispose' in pipeline, false)
})

// -------------------------------------------------------------------- U2

test('U2: a prefix-matched tool is shaped in the assembly projection', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const original = projection(BIG_TOOL, bigParameters())
  const assembly = makeAssembly([original])
  const result = await harness.assemble(assembly)

  assert.notEqual(result, assembly)
  assert.notEqual(result.tools, assembly.tools)

  const shaped = result.tools[0]
  assert.notEqual(shaped, original)
  assert.equal(codePointLength(shaped.description) <= 262, true)
  assert.equal(codePointLength(shaped.description) < codePointLength(original.description), true)
  assert.equal(jsonLength(shaped.parameters) < jsonLength(original.parameters), true)
  assert.equal(selfcheck(shaped.parameters), true)

  const propertyNames = Object.keys(shaped.parameters.properties)
  for (const name of shaped.parameters.required ?? []) {
    assert.equal(propertyNames.includes(name), true, `required "${name}" must exist in properties`)
  }
  assert.equal((shaped.parameters.required ?? []).includes('field_0'), true)

  const stats = pipeline.inspect()
  assert.equal(stats.assembleCalls, 1)
  assert.equal(stats.shadowed, 1)
  assert.equal(stats.shadowedTotal, 1)
  assert.equal(stats.toolsSeen, 1)
  assert.equal(stats.bytesSaved > 0, true)

  // The input objects are read-only for us.
  assert.deepEqual(original.parameters, bigParameters())
  assert.equal(original.description, 'Tool description. '.repeat(30))
})

// -------------------------------------------------------------------- U3

test('U3: keepFull wins and the tool keeps its original object/bytes', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, { ordering: { enabled: false } })
  install(harness, pipeline)

  const original = projection(KEEP_FULL_TOOL, bigParameters())
  const assembly = makeAssembly([original])
  const result = await harness.assemble(assembly)

  assert.equal(result, assembly)
  assert.equal(result.tools[0], original)
  assert.equal(JSON.stringify(result.tools), JSON.stringify(assembly.tools))

  const stats = pipeline.inspect()
  assert.equal(stats.skippedByKeepFull, 1)
  assert.equal(stats.skippedByKeepFullTotal, 1)
  assert.equal(stats.shadowed, 0)
})

// -------------------------------------------------------------------- U4

test('U4: a prefix miss passes the tool through untouched', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, { ordering: { enabled: false } })
  install(harness, pipeline)

  const original = projection('plugin_manager', bigParameters())
  const assembly = makeAssembly([original])
  const result = await harness.assemble(assembly)

  assert.equal(result, assembly)
  assert.equal(result.tools[0], original)
  assert.equal(pipeline.inspect().skippedByPrefix, 1)
  assert.equal(pipeline.inspect().skippedByPrefixTotal, 1)
  assert.equal(pipeline.inspect().shadowed, 0)
})

// -------------------------------------------------------------------- U5

test('U5: shadowPrefixes: [] processes every tool (old semantics)', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, {
    truncation: { shadowPrefixes: [] },
    ordering: { enabled: false },
  })
  install(harness, pipeline)

  const original = projection('web_fetch_file', bigParameters())
  const result = await harness.assemble(makeAssembly([original]))

  const shaped = result.tools[0]
  assert.notEqual(shaped, original)
  assert.equal(codePointLength(shaped.description) <= 262, true)
  assert.equal(jsonLength(shaped.parameters) < jsonLength(original.parameters), true)
  assert.equal(pipeline.inspect().shadowed, 1)
})

// -------------------------------------------------------------------- U5b

test('U5b: the default prefix hits mcp__* only; [] still hits every tool', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, { ordering: { enabled: false } })
  install(harness, pipeline)

  // Default config: an MCP tool name matches `mcp__` and gets shaped.
  const mcp = projection('mcp__github__create_issue', bigParameters())
  const core = projection('read', bigParameters())
  const result = await harness.assemble(makeAssembly([mcp, core]))

  assert.notEqual(result.tools[0], mcp)
  assert.equal(codePointLength(result.tools[0].description) <= 262, true)
  assert.equal(jsonLength(result.tools[0].parameters) < jsonLength(mcp.parameters), true)
  // A core tool is outside the `mcp__` prefix and keeps its reference/bytes.
  assert.equal(result.tools[1], core)
  assert.equal(pipeline.inspect().shadowed, 1)
  assert.equal(pipeline.inspect().skippedByPrefix, 1)

  // The default value itself is the generic prefix, not upstream's `mcp__rea__`.
  assert.deepEqual(normalizeConfig({}).truncation.shadowPrefixes, ['mcp__'])

  // `[]` is a different semantic (old): it matches ANY name, `read` included.
  const allHarness = createHarness()
  const allPipeline = createPipeline(allHarness, {
    truncation: { shadowPrefixes: [] },
    ordering: { enabled: false },
  })
  install(allHarness, allPipeline)

  const plain = projection('read', bigParameters())
  const allResult = await allHarness.assemble(makeAssembly([plain]))

  assert.notEqual(allResult.tools[0], plain)
  assert.equal(jsonLength(allResult.tools[0].parameters) < jsonLength(plain.parameters), true)
  assert.equal(allPipeline.inspect().shadowed, 1)
  assert.equal(allPipeline.inspect().skippedByPrefix, 0)
})

// -------------------------------------------------------------------- U6

test('U6: dryRun counts but returns the original tools', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, {
    truncation: { dryRun: true },
    ordering: { enabled: false },
  })
  install(harness, pipeline)

  const original = projection(BIG_TOOL, bigParameters())
  const assembly = makeAssembly([original])
  const first = await harness.assemble(assembly)

  assert.equal(first, assembly)
  assert.equal(first.tools[0], original)
  assert.equal(JSON.stringify(first.tools), JSON.stringify(assembly.tools))

  const stats = pipeline.inspect()
  assert.equal(stats.shadowed, 0)
  assert.equal(stats.shadowedTotal, 0)
  assert.equal(stats.wouldShadow, 1)
  assert.equal(stats.wouldSaveBytes > 0, true)
  assert.equal(stats.bytesSaved, 0)
  assert.equal(stats.bytesAfter, stats.bytesBefore)

  // A second assemble must not spam the log: one dry-run line per process.
  await harness.assemble(assembly)
  const dryRunLogs = harness.logs.filter((entry) => entry.level === 'info' && entry.message.includes('dryRun'))
  assert.equal(dryRunLogs.length, 1)
})

test('U6b: dryRun still allows ordering, and ordering never changes length', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, { truncation: { dryRun: true } })
  install(harness, pipeline)

  const original = projection(BIG_TOOL, bigParameters())
  const assembly = makeAssembly([original])
  const result = await harness.assemble(assembly)

  assert.equal(codePointLength(result.tools[0].description), codePointLength(original.description))
  assert.equal(jsonLength(result.tools[0].parameters), jsonLength(original.parameters))
  assert.equal(jsonLength(result.tools), jsonLength(assembly.tools))
  assert.equal(pipeline.inspect().shadowed, 0)
  assert.equal(pipeline.inspect().wouldShadow, 1)
})

// -------------------------------------------------------------------- U7

test('U7: length verify compares shaped vs sorted, never the original list', async () => {
  const tools = [projection(BIG_TOOL, bigParameters())]

  // Reference run: truncation only, so its output IS the shaped list.
  const shapedHarness = createHarness()
  const shapedPipeline = createPipeline(shapedHarness, { ordering: { enabled: false } })
  install(shapedHarness, shapedPipeline)
  const shapedAssembly = makeAssembly(clone(tools))
  const shapedResult = await shapedHarness.assemble(shapedAssembly)

  // Full run: shaped then sorted. If the verify baseline were `assembled.tools`,
  // this handler would count a fallback and return the unsorted list.
  const fullHarness = createHarness()
  const fullPipeline = createPipeline(fullHarness)
  install(fullHarness, fullPipeline)
  const fullAssembly = makeAssembly(clone(tools))
  const fullResult = await fullHarness.assemble(fullAssembly)

  const stats = fullPipeline.inspect()
  assert.equal(stats.canonicalFallbacks, 0)
  assert.equal(stats.shadowed, 1)
  // jsonLength(shaped) === jsonLength(sorted), and both are smaller than input.
  assert.equal(jsonLength(fullResult.tools), jsonLength(shapedResult.tools))
  assert.equal(jsonLength(fullResult.tools) < jsonLength(tools), true)
  // The full run really is sorted; the shaped one is not.
  assert.deepEqual(Object.keys(fullResult.tools[0]), ['description', 'name', 'parameters'])
  assert.deepEqual(Object.keys(shapedResult.tools[0]), ['name', 'description', 'parameters'])
  assert.equal(codePointLength(fullResult.tools[0].description) <= 262, true)
})

// -------------------------------------------------------------------- U8

test('U8: an ordering failure keeps the shaped tools (unsorted, not original)', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const unstable = unstableProjection(BIG_TOOL)
  const result = await harness.assemble(makeAssembly([unstable]))

  const stats = pipeline.inspect()
  assert.equal(stats.canonicalFallbacks, 1)
  assert.equal(stats.shadowed, 1)

  const shaped = result.tools[0]
  assert.notEqual(shaped, unstable)
  assert.equal(codePointLength(shaped.description) <= 262, true)
  assert.equal(jsonLength(shaped.parameters) < jsonLength(unstable.parameters), true)
  // Unordered on purpose: stage B failed, so the source key order survives.
  assert.deepEqual(Object.keys(shaped).slice(0, 3), ['name', 'description', 'parameters'])
  assert.ok(harness.logs.some((entry) => entry.level === 'error' && entry.message.includes('serialized length')))
})

// -------------------------------------------------------------------- U9

test('U9: a rejection from next() propagates untouched and is not counted', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const boom = new Error('inner failure')
  await assert.rejects(
    () =>
      harness.assemble(makeAssembly([]), async () => {
        throw boom
      }),
    (error) => error === boom,
  )

  assert.equal(pipeline.inspect().failed, 0)
  assert.equal(pipeline.inspect().assembleCalls, 0)
})

// ------------------------------------------------------------------- U10

test('U10: same input twice is byte-identical and the input is never mutated', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const tools = [projection(BIG_TOOL, bigParameters(), 'Long tool description. '.repeat(40))]
  const serializedInput = JSON.stringify(tools)

  const assemblyA = makeAssembly(JSON.parse(serializedInput))
  const assemblyB = makeAssembly(JSON.parse(serializedInput))
  const first = await harness.assemble(assemblyA)
  const second = await harness.assemble(assemblyB)

  assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools))

  // Neither input was touched: same bytes and same key order.
  assert.equal(JSON.stringify(assemblyA.tools), serializedInput)
  assert.equal(JSON.stringify(assemblyB.tools), serializedInput)
  assert.deepEqual(Object.keys(assemblyA.tools[0]), ['name', 'description', 'parameters'])
  assert.equal(assemblyA.tools.length, 1)
})

// ------------------------------------------------------------------- U11

test('U11: one broken tool does not stop the others', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const broken = projection('mcp__rea__boom', bigParameters())
  Object.defineProperty(broken, 'description', {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error('description boom')
    },
  })
  const healthy = projection('mcp__rea__ok', bigParameters())

  const result = await harness.assemble(makeAssembly([broken, healthy]))

  assert.equal(result.tools.length, 2)
  assert.equal(result.tools[0], broken)
  assert.notEqual(result.tools[1], healthy)
  assert.equal(jsonLength(result.tools[1].parameters) < jsonLength(healthy.parameters), true)
  assert.equal(pipeline.inspect().failed, 1)
  assert.ok(harness.logs.some((entry) => entry.level === 'warn' && entry.message.includes('description boom')))
})

// ------------------------------------------------------------------- U12

test('U12: the circuit breaker only stops ordering, never shaping', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, { ordering: { circuitBreaker: 1 } })
  install(harness, pipeline)

  await harness.assemble(makeAssembly([unstableProjection()]))
  assert.equal(pipeline.inspect().circuitOpen, true)
  assert.equal(pipeline.inspect().canonicalFallbacks, 1)

  const normal = projection(BIG_TOOL, bigParameters())
  const result = await harness.assemble(makeAssembly([normal]))

  assert.notEqual(result.tools[0], normal)
  assert.equal(codePointLength(result.tools[0].description) <= 262, true)
  assert.equal(jsonLength(result.tools[0].parameters) < jsonLength(normal.parameters), true)
  // Stage B is skipped, so the source key order survives.
  assert.deepEqual(Object.keys(result.tools[0]), ['name', 'description', 'parameters'])
  assert.equal(pipeline.inspect().canonicalFallbacks, 1)
  assert.equal(pipeline.inspect().assembleCalls, 2)
})

// ------------------------------------------------------------------- U13

test('U13: structural anomalies degrade locally instead of throwing', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const assembly = makeAssembly([projection(BIG_TOOL, bigParameters())])

  // A non-object result from next() falls back to the assembly we received.
  assert.equal(await harness.assemble(assembly, async () => null), assembly)
  assert.equal(await harness.assemble(assembly, async () => 42), assembly)
  assert.equal(await harness.assemble(assembly, async () => undefined), assembly)

  // A non-array `tools` only gives up post-processing.
  const nonArray = { sections: [], tools: 'nope' }
  assert.equal(await harness.assemble(assembly, async () => nonArray), nonArray)

  // An empty list is valid input.
  const empty = makeAssembly([])
  const emptyResult = await harness.assemble(empty)
  assert.notEqual(emptyResult, empty)
  assert.deepEqual(emptyResult.tools, [])
  assert.notEqual(emptyResult.tools, empty.tools)

  // Malformed elements are preserved by reference.
  const junk = [null, 42, 'x', new Date(0)]
  const junkResult = await harness.assemble(makeAssembly(junk))
  for (let index = 0; index < junk.length; index += 1) assert.equal(junkResult.tools[index], junk[index])

  // A tool without `parameters` gets its description shaped and gains no key.
  const noParameters = { name: 'mcp__rea__no_parameters', description: 'Long. '.repeat(120) }
  const noParametersResult = await harness.assemble(makeAssembly([noParameters]))
  const shaped = noParametersResult.tools[0]
  assert.notEqual(shaped, noParameters)
  assert.equal(Object.prototype.hasOwnProperty.call(shaped, 'parameters'), false)
  assert.equal('description' in shaped, true)
  assert.equal(codePointLength(shaped.description) <= 262, true)
})

// ------------------------------------------------------------------- N12

test('N12: blank descriptions keep their original text and non-plain parameters keep their reference', async () => {
  const harness = createHarness()
  // Stage A only: ordering rebuilds every parameter object, which would hide
  // the reference-preservation contract this test locks down.
  const pipeline = createPipeline(harness, { ordering: { enabled: false } })
  install(harness, pipeline)

  // 1. A whitespace-only description must not be replaced by '' / undefined.
  //    The parameters are big, so a new tool object is expected; the text is
  //    the original whitespace, not the trimmed/empty truncation result.
  const whitespace = ' \n\t  '
  const blank = projection('mcp__rea__blank', bigParameters(), whitespace)
  const blankResult = await harness.assemble(makeAssembly([blank]))
  const blankShaped = blankResult.tools[0]
  assert.notEqual(blankShaped, blank)
  assert.equal(typeof blankShaped.description, 'string')
  assert.equal(blankShaped.description, whitespace)
  assert.notEqual(blankShaped.description, '')
  assert.notEqual(blankShaped.description, undefined)
  // The parameters really were slimmed, so the preserve-description assertion
  // above is not passing because nothing happened at all.
  assert.equal(jsonLength(blankShaped.parameters) < jsonLength(blank.parameters), true)

  // 2. An empty description stays an own string property, never undefined.
  const empty = projection('mcp__rea__empty', bigParameters(), '')
  const emptyResult = await harness.assemble(makeAssembly([empty]))
  const emptyShaped = emptyResult.tools[0]
  assert.equal(Object.prototype.hasOwnProperty.call(emptyShaped, 'description'), true)
  assert.equal(emptyShaped.description, '')
  assert.notEqual(emptyShaped.description, undefined)

  // 3. A non-plain `parameters` is "description only": no rebuild, no
  //    `parameters: undefined`, and the original reference survives.
  const nonPlain = [
    ['array', []],
    ['string', 'raw'],
    ['null', null],
    ['date', new Date(0)],
  ]
  for (const [label, parameters] of nonPlain) {
    const original = { name: `mcp__rea__params_${label}`, description: 'Long. '.repeat(120), parameters }
    const result = await harness.assemble(makeAssembly([original]))
    const shaped = result.tools[0]

    assert.notEqual(shaped, original, `${label}: the description should still be shaped`)
    assert.equal(codePointLength(shaped.description) < codePointLength(original.description), true)
    assert.equal(Object.prototype.hasOwnProperty.call(shaped, 'parameters'), true, `${label}: parameters key kept`)
    assert.equal(shaped.parameters, parameters, `${label}: parameters must keep its reference`)
    assert.notEqual(shaped.parameters, undefined, `${label}: parameters must never become undefined`)
    assert.equal(JSON.stringify(shaped).includes('"parameters":undefined'), false)
    assert.equal(original.parameters, parameters, `${label}: the input object is untouched`)
  }

  // 4. Nothing to change: short description + non-plain parameters means the
  //    original tool (and assembly) come back by reference.
  const untouched = { name: 'mcp__rea__untouched', description: 'short', parameters: [] }
  const untouchedAssembly = makeAssembly([untouched])
  const untouchedResult = await harness.assemble(untouchedAssembly)
  assert.equal(untouchedResult, untouchedAssembly)
  assert.equal(untouchedResult.tools[0], untouched)
  assert.equal(pipeline.inspect().shadowed, 0)
})

// ------------------------------------------------------------------- U14

test('U14: __proto__ survives canonicalization with a clean length check', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const parameters = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"number"}},"required":["__proto__","a"]}',
  )
  const assembly = makeAssembly([{ name: 'mcp__rea__proto', parameters }])
  const result = await harness.assemble(assembly)

  const stats = pipeline.inspect()
  assert.equal(stats.protoKeysSeen, 1)
  assert.equal(stats.canonicalFallbacks, 0)

  const shapedParameters = result.tools[0].parameters
  assert.equal(Object.prototype.hasOwnProperty.call(shapedParameters.properties, '__proto__'), true)
  assert.equal(Object.keys(shapedParameters.properties).includes('__proto__'), true)
  assert.equal(JSON.stringify(result.tools).includes('"__proto__"'), true)
  assert.equal(Object.getPrototypeOf(shapedParameters.properties), Object.prototype)
  // Sorting did not eat a key: same serialized length as the input.
  assert.equal(jsonLength(result.tools), jsonLength(assembly.tools))
})

// ------------------------------------------------------------------- U15

test('U15: arrays keep their source order; only object keys are sorted', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['b', 'a', 'c'] },
      union: { oneOf: [{ type: 'number' }, { type: 'string' }] },
      tuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
    },
    required: ['action', 'union'],
  }
  const result = await harness.assemble(
    makeAssembly([projection('mcp__rea__arrays', parameters), projection('mcp__rea__second', parameters)]),
  )

  // Tool list order follows core's orderTools; we never reorder it.
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['mcp__rea__arrays', 'mcp__rea__second'],
  )

  // Parameters are below minSchemaChars, so they are untouched by stage A and
  // only key-sorted by stage B.
  const shaped = result.tools[0].parameters
  assert.equal(pipeline.inspect().skippedByInvalid, 2)
  assert.deepEqual(shaped.required, ['action', 'union'])
  assert.deepEqual(shaped.properties.action.enum, ['b', 'a', 'c'])
  assert.deepEqual(
    shaped.properties.union.oneOf.map((branch) => branch.type),
    ['number', 'string'],
  )
  assert.deepEqual(
    shaped.properties.tuple.prefixItems.map((branch) => branch.type),
    ['string', 'number'],
  )
})

// ------------------------------------------------------------------- U16

test('U16: only tools change; sections/contexts/variables keep their references', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const assembly = makeAssembly([projection(BIG_TOOL, bigParameters())])
  const result = await harness.assemble(assembly)

  assert.notEqual(result.tools, assembly.tools)
  assert.equal(result.sections, assembly.sections)
  assert.equal(result.contexts, assembly.contexts)
  assert.equal(result.variables, assembly.variables)
})

// ------------------------------------------------------------------- U17

test('U17：apply 安装双通道钩子，实测监听器只读且不参与 assemble', async () => {
  const harness = createHarness()
  const events = []
  let effectCalls = 0
  const injected = []

  const ctx = {
    logger: harness.logger,
    on(event, listener) {
      events.push(event)
      return harness.ctx.on(event, listener)
    },
    effect() {
      effectCalls += 1
      return () => {}
    },
    inject(deps) {
      injected.push(deps)
    },
  }

  apply(ctx, { truncation: { shadowPrefixes: [] } })

  assert.deepEqual(events, ['system-prompt/assemble', 'session/event'])
  assert.deepEqual([...harness.listeners.keys()], ['system-prompt/assemble', 'session/event'])
  assert.equal(harness.listeners.get('session/event').length, 1)
  // 可选服务不解析时只创建统计存储的释放 effect，不注册子服务。
  const assembly = makeAssembly([projection(BIG_TOOL, bigParameters())])
  const before = clone(assembly)
  const listener = harness.listeners.get('session/event')[0]
  const message = Object.freeze({ type: 'assistant/message', time: Date.now(),
    data: Object.freeze({ usage: Object.freeze({ inputTokens: 10, cacheReadTokens: 20 }) }) })
  assert.equal(await listener(Object.freeze({ id: 'u17' }), message), undefined)
  assert.deepEqual(assembly, before)
  const result = await harness.assemble(assembly)
  assert.deepEqual(result, await createPipeline(harness, { truncation: { shadowPrefixes: [] } }).hooks[0].handler(assembly, {}, async () => assembly))
  assert.deepEqual(assembly, before)
  assert.deepEqual(injected, [['cordisInspect'], ['webServer']])
  assert.equal(effectCalls, 1)
  assert.equal(harness.listeners.has('agent/created'), false)
})

test('apply() reports an install failure without throwing', () => {
  const logs = []
  const logger = {
    error: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    info: () => {},
    debug: () => {},
  }
  const ctx = {
    logger,
    on() {
      throw new Error('on boom')
    },
  }

  assert.doesNotThrow(() => apply(ctx, {}))
  assert.ok(logs.some((message) => message.includes('not active')))
})

// ------------------------------------------------------------------- U18

test('U18: no runtime dependencies, plain ESM, relative imports and node builtins only', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)

  const sources = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) sources.push(full)
    }
  }
  walk(join(root, 'src'))
  assert.equal(sources.length >= 5, true)

  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    // Anchor at the start of a line so prose in comments ("… from "x" …")
    // never counts as an import.
    const specifiers = [
      ...text.matchAll(/^\s*import\s+[^\n]*?\bfrom\s+['"]([^'"]+)['"]/gm),
      ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...text.matchAll(/^\s*export\s+[^\n]*?\bfrom\s+['"]([^'"]+)['"]/gm),
    ].map((match) => match[1])
    // Node builtins (`node:fs` etc.) are part of the runtime, not a package
    // dependency; the host half may use them. Everything else must be local.
    for (const specifier of specifiers) {
      const allowed = specifier.startsWith('.') || specifier.startsWith('node:')
      assert.equal(allowed, true, `${file} imports unsupported "${specifier}"`)
    }
  }
})

// -------------------------------------------------------------- other paths

test('both switches off is a zero-cost pass-through', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, {
    truncation: { enabled: false },
    ordering: { enabled: false },
  })
  install(harness, pipeline)

  const inner = makeAssembly([{ b: 1, a: 2 }])
  let calls = 0
  const result = await harness.assemble(inner, async () => {
    calls += 1
    return inner
  })

  assert.equal(calls, 1)
  assert.equal(result, inner)
  assert.equal(pipeline.inspect().assembleCalls, 0)
})

test('ordering-only: truncation disabled only sorts; shadow counters stay 0', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness, { truncation: { enabled: false } })
  install(harness, pipeline)

  // Both tools are big enough that stage A WOULD reshape them if truncation
  // ran: that is what makes the "only sorting" assertion meaningful.
  const first = projection(BIG_TOOL, bigParameters(), 'Ordering only. '.repeat(40))
  const second = projection('mcp__rea__second', bigParameters())
  const tools = [first, second]
  const assembly = makeAssembly(tools)

  // Independent reference: the ordering primitive applied to an untouched clone.
  const reference = canonicalizeTools(clone(tools), {
    maxDepth: normalizeConfig({}).ordering.maxDepth,
    verify: 'length',
  })
  assert.equal(Array.isArray(reference.tools), true)

  const result = await harness.assemble(assembly)

  const stats = pipeline.inspect()
  assert.equal(stats.assembleCalls, 1)
  assert.equal(stats.shadowed, 0)
  assert.equal(stats.wouldShadow, 0)
  assert.equal(stats.shadowedTotal, 0)
  // Stage A did not run at all: no tool was seen and no bytes were measured.
  // (A bytes measurement here would be exactly the wasted full-list stringify.)
  assert.equal(stats.toolsSeen, 0)
  assert.equal(stats.bytesBefore, 0)
  assert.equal(stats.bytesAfter, 0)

  // Byte-identical to the sorting-only reference path...
  assert.equal(JSON.stringify(result.tools), JSON.stringify(reference.tools))
  // ...and genuinely sorted, i.e. not the source byte order.
  assert.notEqual(JSON.stringify(result.tools), JSON.stringify(tools))
  assert.deepEqual(Object.keys(result.tools[0]), ['description', 'name', 'parameters'])

  // Only key order changed: values, parameter bytes and list order are intact.
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [BIG_TOOL, 'mcp__rea__second'],
  )
  for (let index = 0; index < tools.length; index += 1) {
    assert.equal(result.tools[index].description, tools[index].description)
    assert.equal(codePointLength(result.tools[index].description), codePointLength(tools[index].description))
    assert.deepEqual(result.tools[index].parameters, tools[index].parameters)
    assert.equal(jsonLength(result.tools[index].parameters), jsonLength(tools[index].parameters))
  }

  // Non-tool parts keep their references, and the input list is untouched.
  assert.equal(result.sections, assembly.sections)
  assert.equal(result.contexts, assembly.contexts)
  assert.equal(result.variables, assembly.variables)
  assert.deepEqual(Object.keys(assembly.tools[0]), ['name', 'description', 'parameters'])
})

test('ordering sorts the object keys of the whole list and keeps the input intact', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  install(harness, pipeline)

  const tools = [
    { name: 't', parameters: { z: 1, a: { y: 2, x: 3 } } },
    { name: 'u', parameters: {} },
  ]
  const assembly = makeAssembly(tools)
  const result = await harness.assemble(assembly)

  assert.notEqual(result, assembly)
  assert.equal(result.sections, assembly.sections)
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['t', 'u'],
  )
  assert.deepEqual(Object.keys(result.tools[0].parameters), ['a', 'z'])
  assert.deepEqual(Object.keys(result.tools[0].parameters.a), ['x', 'y'])
  // The received objects were not touched.
  assert.deepEqual(Object.keys(assembly.tools[0].parameters), ['z', 'a'])
  assert.equal(jsonLength(result.tools), jsonLength(assembly.tools))
  assert.equal(pipeline.inspect().assembleCalls, 1)
})

// ---------------------------------------------------------------- skeleton

test('installHooks isolates a failing registration', () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)

  const report = installHooks({ on() { throw new Error('on boom') } }, pipeline.hooks, {
    logger: harness.logger,
  })

  assert.equal(report.failed.length, 1)
  assert.equal(report.installed.length, 0)
})

test('installHooks rejects an invalid spec without touching the next one', () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  const installed = []

  const report = installHooks(
    {
      on(event) {
        installed.push(event)
      },
    },
    [{ id: 'bad' }, ...pipeline.hooks],
    { logger: harness.logger },
  )

  assert.equal(report.failed.length, 1)
  assert.equal(report.failed[0].id, 'bad')
  assert.deepEqual(report.installed.map((entry) => entry.id), ['shape-and-stabilize-tools'])
  assert.deepEqual(installed, ['system-prompt/assemble'])
})

test('installHooks treats a non-array spec list as empty', () => {
  const report = installHooks({ on() {} }, null, {})
  assert.deepEqual(report, { installed: [], failed: [] })
})

test('normalizeConfig never throws and clamps hostile input', () => {
  const hostile = [
    undefined,
    null,
    'x',
    42,
    [],
    { truncation: 'nope', ordering: [], debug: null },
    { maxDepth: 1e9, shadowPrefixes: [1, 2], keepFull: 'x', canonicalizeTools: false },
  ]
  for (const raw of hostile) {
    const config = normalizeConfig(raw)
    assert.ok(config.truncation.maxDepth >= 0 && config.truncation.maxDepth <= 6)
    assert.ok(config.ordering.maxDepth >= 0 && config.ordering.maxDepth <= 512)
    assert.ok(Object.isFrozen(config))
    assert.ok(Object.isFrozen(config.truncation.keepFull))
  }

  assert.equal(normalizeConfig({ maxDepth: 99 }).truncation.maxDepth, 6)
  assert.equal(normalizeConfig({ minChars: 123 }).truncation.minSchemaChars, 123)
  assert.equal(normalizeConfig({ canonicalizeTools: false }).ordering.enabled, false)
  assert.equal(normalizeConfig({ maxDescriptionChars: 10 }).truncation.maxDescriptionChars, 10)
  assert.deepEqual(normalizeConfig({ shadowPrefixes: [1, 2] }).truncation.shadowPrefixes, ['mcp__'])
  assert.deepEqual(normalizeConfig({ shadowPrefixes: [] }).truncation.shadowPrefixes, [])
  assert.equal(normalizeConfig({ debug: { logLevel: 'shout' } }).debug.logLevel, 'warn')
  assert.equal(normalizeConfig({ unknownKey: 1 }).truncation.enabled, true)
})
