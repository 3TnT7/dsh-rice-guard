import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/index.js'

/**
 * Minimal Host fake:
 * - `ctx.on` 记录 assemble 与 usage 两条监听器；
 * - `ctx.inject` resolves `cordisInspect` + `webServer` (or never calls back);
 * - `ctx.effect` runs the registration and keeps its disposer, like Cordis does.
 */
function createInspectHost(options = {}) {
  const service = options.service !== false
  const logs = []
  const logger = {
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
    info: (message) => logs.push({ level: 'info', message }),
    debug: () => {},
  }

  const listeners = new Map()
  const providers = new Map()
  const effects = []
  const rootEffects = []
  const injectCalls = []
  const routes = []

  const cordisInspect = {
    register(registration) {
      const id = registration.manifest.id
      if (providers.has(id)) throw new Error(`Host Cordis inspect provider "${id}" is already registered`)
      providers.set(id, registration)
      return () => {
        if (providers.get(id) === registration) providers.delete(id)
      }
    },
    list() {
      return [...providers.values()].map((provider) => provider.manifest)
    },
  }

  const ctx = {
    logger,
    effect(execute, label) {
      const entry = { label, dispose: execute() }
      rootEffects.push(entry)
      return entry.dispose
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    inject(deps, callback) {
      injectCalls.push(deps)
      if (!service) return { then() {} }
      const child = {
        cordisInspect,
        webServer: {
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        },
        effect(execute, label) {
          const entry = { label, dispose: execute() }
          effects.push(entry)
          return entry.dispose
        },
      }
      callback(child)
      return { then() {} }
    },
  }

  async function assemble(assembly, context = {}) {
    const list = listeners.get('system-prompt/assemble') ?? []
    let result
    for (const listener of list) result = await listener(assembly, context, async () => assembly)
    return result
  }

  return { ctx, logs, listeners, providers, effects, rootEffects, injectCalls, routes, assemble }
}

/** Every test gets a fresh $DSH_HOME so archives never leak between cases. */
function freshHome() {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rg-inspect-'))
  return process.env.DSH_HOME
}

function applyFresh(host, config) {
  freshHome()
  apply(host.ctx, config ?? {})
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
}

async function request(route, method, body, url) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(payload)
  req.method = method
  req.url = url || route.path
  const res = makeRes()
  await route.handler(req, res)
  return res
}

function routeOf(host, path) {
  return host.routes.find((entry) => entry.path === path)
}

test('inspect provider: manifest shape, return fields and config summary', () => {
  const host = createInspectHost()
  applyFresh(host, {
    truncation: { shadowPrefixes: ['plugin_manager'], keepFull: ['plugin_manager'], dryRun: true },
    ordering: { verify: 'none' },
  })

  assert.deepEqual(host.injectCalls, [['cordisInspect'], ['webServer']])
  assert.equal(host.effects.length, 2)
  assert.equal(host.effects[0].label, 'rice-guard:inspect')
  assert.equal(host.effects[1].label, 'rice-guard:api-routes')
  assert.deepEqual(host.routes.map((route) => route.path), [
    '/api/rice-guard/stats',
    '/api/rice-guard/config',
    '/api/rice-guard/tuning',
    '/api/rice-guard/tuning/restore',
  ])

  const registration = host.providers.get('RiceGuard')
  assert.ok(registration, 'RiceGuard must be registered')

  const { manifest } = registration
  assert.equal(manifest.id, 'RiceGuard')
  assert.equal(manifest.description.length > 0, true)
  assert.equal(manifest.methods.length, 1)

  const method = manifest.methods[0]
  assert.equal(method.name, 'inspect')
  assert.equal(method.description.length > 0, true)
  assert.deepEqual(method.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
  assert.equal(typeof method.outputSchema.description, 'string')

  const result = registration.query('inspect', undefined)
  assert.equal(result.assembleCalls, 0)
  assert.equal(result.circuitOpen, false)

  // `lastError` is undefined after a clean start; JSON semantics drop it, and
  // the host validates the returned value as lossless JSON.
  assert.equal(Object.hasOwn(result, 'lastError'), false)

  assert.equal(result.config.truncation.enabled, true)
  assert.equal(result.config.truncation.dryRun, true)
  assert.deepEqual(result.config.truncation.shadowPrefixes, ['plugin_manager'])
  assert.equal(result.config.truncation.keepFullCount, 1)
  assert.equal(result.config.ordering.enabled, true)
  assert.equal(result.config.ordering.verify, 'none')
  assert.equal(result.config.source, 'profile')
  assert.equal(result.config.storage.enabled, true)

  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  assert.throws(() => registration.query('list'), /unknown RiceGuard inspect method "list"/)
})

test('inspect provider: counters reflect the last assemble', async () => {
  const host = createInspectHost()
  applyFresh(host, { ordering: { enabled: false } })
  const registration = host.providers.get('RiceGuard')

  await host.assemble({
    tools: [{ name: 'plugin_manager', description: 'short', parameters: {} }],
  })

  const result = registration.query('inspect')
  assert.equal(result.assembleCalls, 1)
  assert.equal(result.toolsSeen, 1)
  assert.equal(result.skippedByPrefix, 1)
  assert.equal(result.shadowed, 0)
  assert.equal(Object.hasOwn(result, 'lastError'), false)
})

test('inspect provider: the effect disposer removes the registration on reload', () => {
  const host = createInspectHost()
  applyFresh(host, {})

  assert.equal(host.providers.has('RiceGuard'), true)
  host.effects[0].dispose()
  assert.equal(host.providers.has('RiceGuard'), false)
  // The disposer is idempotent: a reload may dispose twice.
  assert.doesNotThrow(() => host.effects[0].dispose())
})

test('inspect provider: a host without cordisInspect still installs the hook', () => {
  const host = createInspectHost({ service: false })
  freshHome()

  assert.doesNotThrow(() => apply(host.ctx, {}))
  assert.deepEqual(host.injectCalls, [['cordisInspect'], ['webServer']])
  assert.deepEqual([...host.listeners.keys()], ['system-prompt/assemble', 'session/event'])
  assert.equal(host.providers.size, 0)
  assert.equal(host.effects.length, 0)
  assert.deepEqual(host.rootEffects.map((entry) => entry.label), ['rice-guard:stats-store'])
  assert.equal(host.logs.some((entry) => entry.level === 'warn'), false)
})

test('inspect provider: a minimal ctx without inject() is supported', () => {
  freshHome()
  const events = []
  const ctx = {
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    on(event) {
      events.push(event)
    },
  }

  assert.doesNotThrow(() => apply(ctx, {}))
  assert.deepEqual(events, ['system-prompt/assemble', 'session/event'])
})

test('inspect provider: a duplicate id is reported, never fatal', () => {
  const host = createInspectHost()
  freshHome()
  // Someone else already owns the process-unique id.
  host.providers.set('RiceGuard', { manifest: { id: 'RiceGuard' } })

  assert.doesNotThrow(() => apply(host.ctx, {}))
  assert.deepEqual([...host.listeners.keys()], ['system-prompt/assemble', 'session/event'])
  assert.equal(
    host.logs.some((entry) => entry.level === 'warn' && entry.message.includes('already registered')),
    true,
  )
})

test('config route: POST applies the switches and persists them', async () => {
  const host = createInspectHost()
  applyFresh(host, {})

  const route = routeOf(host, '/api/rice-guard/config')
  assert.ok(route, 'the config route must be registered')

  const res = await request(route, 'POST', { truncation: { enabled: false, dryRun: true } })

  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.persisted, true)
  assert.equal(body.config.truncation.enabled, false)
  assert.equal(body.config.truncation.dryRun, true)

  // The same values reach the Inspect Provider on the next read.
  const registration = host.providers.get('RiceGuard')
  const snapshot = registration.query('inspect')
  assert.equal(snapshot.config.truncation.enabled, false)
  assert.equal(snapshot.config.truncation.dryRun, true)
  assert.equal(snapshot.config.source, 'store')
})

test('config route: rejects a non-POST method, malformed JSON and empty switches', async () => {
  const host = createInspectHost()
  applyFresh(host, {})
  const route = routeOf(host, '/api/rice-guard/config')

  assert.equal((await request(route, 'GET')).status, 405)
  assert.equal((await request(route, 'POST', '{not json')).status, 400)
  assert.equal((await request(route, 'POST', {})).status, 400)
  assert.equal((await request(route, 'POST', { unknown: { enabled: true } })).status, 400)
})

test('stats route: windows, conversations, storage and timezone shape', async () => {
  const host = createInspectHost()
  applyFresh(host, { ordering: { enabled: false } })
  await host.assemble({ tools: [{ name: 'plugin_manager', description: 'short', parameters: {} }] })

  const route = routeOf(host, '/api/rice-guard/stats')
  const res = await request(route, 'GET', undefined, '/api/rice-guard/stats?window=today')
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)

  assert.equal(body.window, 'today')
  assert.deepEqual(Object.keys(body.windows), ['today', 'd7', 'd30'])
  assert.equal(body.windows.today.assembleRequests, 1)
  assert.equal(body.windows.today.assembleCalls, 1)
  assert.equal(typeof body.windows.today.bytesSaved, 'number')
  assert.equal(typeof body.windows.today.tokensBefore, 'number')
  assert.equal(typeof body.windows.today.tokensAfter, 'number')
  assert.equal(Array.isArray(body.conversations), true)
  assert.equal(typeof body.timezone, 'string')
  assert.ok(body.timezone.length > 0)
  assert.equal(body.storage.enabled, true)
  assert.equal(typeof body.storage.dir, 'string')
  assert.equal(body.config.source, 'profile')

  assert.equal((await request(route, 'POST')).status, 405)
})

test('tuning route: GET exposes metadata and effective config', async () => {
  const host = createInspectHost()
  applyFresh(host, {})
  const res = await request(routeOf(host, '/api/rice-guard/tuning'), 'GET')
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)

  assert.equal(body.ok, true)
  assert.equal(body.meta.length, 31)
  assert.equal(body.groups.length, 7)
  assert.equal(body.effective.truncation.maxDescriptionChars, 260)
  assert.equal(body.defaults.truncation.maxDescriptionChars, 260)
  assert.equal(body.persisted, null)
  assert.equal(body.source, 'profile')
  assert.deepEqual(body.backups, [])
  assert.equal(Array.isArray(body.warnings), true)

  assert.equal((await request(routeOf(host, '/api/rice-guard/tuning'), 'DELETE')).status, 405)
})

test('tuning route: POST saves, backs up and survives a reload', async () => {
  const host = createInspectHost()
  const home = freshHome()
  apply(host.ctx, {})

  const route = routeOf(host, '/api/rice-guard/tuning')
  const res = await request(route, 'POST', { patch: { truncation: { maxDescriptionChars: 300 } } })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.saved, true)
  assert.equal(body.effective.truncation.maxDescriptionChars, 300)
  assert.equal(body.persisted.truncation.maxDescriptionChars, 300)
  assert.equal(body.source, 'store')
  assert.equal(body.origin, 'tuning')
  assert.match(body.backupId, /^\d{8}-\d{6}-[a-f0-9]{4}$/)
  assert.deepEqual(body.changed, ['truncation.maxDescriptionChars'])

  // Restart simulation: a fresh host on the same $DSH_HOME reads the archive.
  const second = createInspectHost()
  apply(second.ctx, {})
  const registration = second.providers.get('RiceGuard')
  assert.equal(registration.query('inspect').config.source, 'store')
  assert.equal(host.providers.get('RiceGuard').query('inspect').config.source, 'store')
  const tuning = JSON.parse((await request(routeOf(second, '/api/rice-guard/tuning'), 'GET')).body)
  assert.equal(tuning.effective.truncation.maxDescriptionChars, 300)
  assert.equal(tuning.backups.length, 1)
  assert.equal(tuning.storePath.startsWith(home), true)
})

test('tuning route: normalized values are reported as warnings', async () => {
  const host = createInspectHost()
  applyFresh(host, {})
  const route = routeOf(host, '/api/rice-guard/tuning')

  const res = await request(route, 'POST', {
    patch: { truncation: { maxDepth: 99 }, unknownTop: { a: 1 } },
  })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.effective.truncation.maxDepth, 6)
  assert.equal(body.warnings.some((warning) => warning.includes('truncation.maxDepth')), true)
  assert.equal(body.warnings.some((warning) => warning.includes('unknownTop.a')), true)
})

test('tuning restore: defaults and backup restore both work', async () => {
  const host = createInspectHost()
  applyFresh(host, {})
  const tuningRoute = routeOf(host, '/api/rice-guard/tuning')
  // First save: previous value (64) lands in a backup. Second save's backup
  // contains the first save's value (8), which is what we restore below.
  await request(tuningRoute, 'POST', { patch: { ordering: { maxDepth: 8 } } })
  const save = JSON.parse((await request(tuningRoute, 'POST', { patch: { ordering: { maxDepth: 9 } } })).body)
  const backupId = save.backupId
  assert.ok(backupId)

  const defaults = JSON.parse(
    (await request(routeOf(host, '/api/rice-guard/tuning/restore'), 'POST', { kind: 'defaults' })).body,
  )
  assert.equal(defaults.persisted, null)
  assert.equal(defaults.effective.ordering.maxDepth, 64)
  assert.equal(defaults.source, 'profile')

  const restored = JSON.parse(
    (await request(routeOf(host, '/api/rice-guard/tuning/restore'), 'POST', { kind: 'backup', id: backupId })).body,
  )
  assert.equal(restored.effective.ordering.maxDepth, 8)
  assert.equal(restored.source, 'store')
  assert.ok(restored.backupId)

  const invalid = await request(routeOf(host, '/api/rice-guard/tuning/restore'), 'POST', {
    kind: 'backup',
    id: '../config',
  })
  assert.equal(invalid.status, 400)

  const badKind = await request(routeOf(host, '/api/rice-guard/tuning/restore'), 'POST', { kind: 'nope' })
  assert.equal(badKind.status, 400)
})
