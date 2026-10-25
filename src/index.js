/**
 * 职责
 *   插件入口，只做装配：加载精调存档 → 规范化配置 → 建 logger → 建
 *   cache-pipeline / 统计存储 / 配置存档 → 装双通道钩子 → 注册只读 Inspect
 *   Provider 与面板用 HTTP 路由。这里不写工具 schema 逻辑。
 *
 * 依赖的 DSH 契约（DSH 0.2.1-rc.3）
 *   - `ctx.logger`：对象形态与可调用形态都存在；本文件两种都兼容。
 *   - `ctx.on(event, listener)`：经 hooks.js 安装 assemble 与 session/event 双通道监听器。
 *   - `ctx.inject(deps, callback)`：子 fiber 只在服务可用时激活；缺 `webServer`
 *     或 `cordisInspect` 时插件本体照常加载。
 *   - `ctx.effect(execute, label)`：执行并接管 disposer，重载/卸载时自动释放。
 *   - `cordisInspect.register(registration)`：provider id 每进程唯一，重复注册抛错。
 *
 * 关键决策与依据
 *   - **存档优先于 profile**：启动时先读 `<dir>/config.json`（如存在），用它覆盖
 *     profile 传入配置；面板明示来源并给「恢复默认（删档）」。这是「精调要能备份
 *     还原」的前提——否则重启后精调结果消失，备份没有意义。
 *   - **统计记录走回调**：cache-pipeline 每次 assemble 把一条纯数字记录交给
 *     `statsStore.record`，落盘/聚合都在本文件之外，投影主链路不碰 fs。
 *   - **四条面板路由**：`stats`（读）/ `config`（既有开关写）/ `tuning`（读写整份
 *     配置）/ `tuning/restore`（还原）。配置元数据只在 tuning 按需返回，不让
 *     5 秒轮询背着它跑。
 *   - **写盘失败不阻断投影**：统计/存档各自捕获错误并由 `error` 字段暴露；
 *     最坏情况是「界面提示未落盘」，而不是插件不工作。
 *
 * 已知边界
 *   - 存档目录固定 `$DSH_HOME/storages/dsh-rice-guard`；要换盘用 `DSH_HOME`。
 *   - 精调保存后只影响**新会话**（会话冻结）；已有会话沿用各自快照。
 *   - 路由无鉴权，与现有 stats/config 路由同一安全姿态（本机 loopback 面板用）。
 */
import { DEFAULTS, normalizeConfig } from './config.js'
import { CONFIG_GROUPS, CONFIG_META } from './config-meta.js'
import { createCachePipeline } from './cache-pipeline.js'
import { installHooks } from './hooks.js'
import { createUsageHook } from './usage.js'
import { auditConfig, clampWarnings } from './config-audit.js'
import { createConfigStore } from './config-store.js'
import { createStatsStore, WINDOW_IDS } from './stats-store.js'
import { defaultStoreDir } from './store-paths.js'
import { pricingSnapshot } from './pricing.js'

export const name = 'dsh-rice-guard'

/** Inspect provider identity: process-unique, referenced by `cordis_inspect_query`. */
const INSPECT_PROVIDER_ID = 'RiceGuard'

/** Effect label owned by the injected child fiber; released on plugin reload. */
const INSPECT_EFFECT_LABEL = 'rice-guard:inspect'

/** `inspect` takes no input; the host validates against this schema. */
const INSPECT_EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false }

/**
 * Output schema is annotation-only on purpose: the standard "unconstrained JSON"
 * form accepted by the host's `assertSupportedJsonSchema`.
 */
const INSPECT_ANY_OUTPUT = {
  description: 'cache-pipeline statistics snapshot plus the effective truncation/ordering switches.',
}

/** Panel routes; all local loopback endpoints used by the sidebar panel. */
const STATS_ROUTE_PATH = '/api/rice-guard/stats'
const CONFIG_ROUTE_PATH = '/api/rice-guard/config'
const TUNING_ROUTE_PATH = '/api/rice-guard/tuning'
const RESTORE_ROUTE_PATH = '/api/rice-guard/tuning/restore'

/** Only these switches may be written through the legacy config route. */
const SWITCH_GROUPS = Object.freeze({
  truncation: ['enabled', 'dryRun'],
  visibility: ['enabled', 'dryRun'],
  ordering: ['enabled'],
})

/**
 * @param {object} ctx plugin context
 * @param {unknown} rawConfig raw plugin config (never trusted)
 */
export function apply(ctx, rawConfig) {
  const baseConfig = normalizeConfig(rawConfig)
  const storeDir = defaultStoreDir()

  // Logger is created after the archive is loaded (stored config may change
  // `debug.logLevel`); stores keep a lazy sink so early warnings still land.
  let logger = null
  const lazyLogger = {
    error: (message) => forwardLog(logger, 'error', message),
    warn: (message) => forwardLog(logger, 'warn', message),
    info: (message) => forwardLog(logger, 'info', message),
    debug: (message) => forwardLog(logger, 'debug', message),
  }

  const configStore = createConfigStore({ dir: storeDir, baseConfig, logger: lazyLogger })
  const config = configStore.effective()
  logger = createLogger(ctx, config)

  const statsStore = createStatsStore({ dir: storeDir, logger: lazyLogger })
  statsStore.configure(config)
  try {
    ctx.effect(() => () => statsStore.close(), 'rice-guard:stats-store')
  } catch (error) {
    logger.warn(`统计存储释放回调未注册：${describe(error)}`)
  }

  const deps = { logger }
  const pipeline = createCachePipeline(config, {
    ...deps,
    recordAssemble: (record) => statsStore.record(record),
  })

  const report = installHooks(ctx, [...pipeline.hooks, createUsageHook({
    recordUsage: statsStore.recordUsage.bind(statsStore),
  })], deps)

  if (report.failed.length > 0) {
    const first = report.failed[0]
    logger.error(
      `cache-pipeline is not active: ${report.failed.length} hook(s) failed to install (${describe(first && first.error)})`,
    )
  }

  installInspectProvider(ctx, pipeline, configStore, logger)
  installApiRoutes(ctx, { pipeline, statsStore, configStore, storeDir, logger })
}

// ------------------------------------------------------------------ routes

/**
 * Serve the panel's data over HTTP.
 *
 * All routes are registered in one child fiber injected on `webServer`; without
 * that service (headless/tui) nothing is registered and the plugin keeps
 * working. `effect` owns the disposers, so a reload never leaves stale routes.
 *
 * @param {object} ctx
 * @param {{ pipeline: object, statsStore: object, configStore: object, storeDir: string, logger: object }} deps
 */
function installApiRoutes(ctx, deps) {
  if (!ctx || typeof ctx.inject !== 'function') return
  const { pipeline, statsStore, configStore, storeDir, logger } = deps
  try {
    ctx.inject(['webServer'], (child) => {
      const statsRoute = {
        kind: 'exact',
        path: STATS_ROUTE_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method Not Allowed' })
          let body
          try {
            const windowId = readWindow(req)
            const now = Date.now()
            body = JSON.stringify({
              ...inspectSnapshot(pipeline),
              config: configSummary(pipeline.getConfig(), configStore),
              window: windowId,
              windows: {
                today: statsStore.summary('today', now),
                d7: statsStore.summary('d7', now),
                d30: statsStore.summary('d30', now),
              },
              conversations: statsStore.conversations(windowId, now),
              storage: statsStore.info(),
              timezone: statsStore.timezone(),
              now,
            })
          } catch (error) {
            logger.warn(`stats route failed to build a snapshot: ${describe(error)}`)
            return sendJson(res, 500, { error: 'snapshot failed' })
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      }

      const configRoute = {
        kind: 'exact',
        path: CONFIG_ROUTE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' })
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return sendJson(res, 400, { error: describe(error) })
          }
          const patch = pickSwitches(body)
          if (Object.keys(patch).length === 0) {
            return sendJson(res, 400, { error: 'no supported switches in body' })
          }
          let result
          try {
            result = saveAndApply(configStore, pipeline, statsStore, patch, {
              source: 'panel',
              note: '配置页开关',
            })
          } catch (error) {
            logger.warn(`live config rejected: ${describe(error)}`)
            return sendJson(res, 400, { error: 'invalid config' })
          }
          return sendJson(res, 200, {
            ok: true,
            config: configSummary(pipeline.getConfig(), configStore),
            persisted: result.error === null,
            backupId: result.backupId,
            warnings: collectWarnings(patch, pipeline.getConfig()),
            storage: statsStore.info(),
          })
        },
      }

      const tuningRoute = {
        kind: 'exact',
        path: TUNING_ROUTE_PATH,
        handler: async (req, res) => {
          if (req.method === 'GET') {
            return sendJson(res, 200, tuningView(pipeline, statsStore, configStore, storeDir))
          }
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' })
          let body
          try {
            body = await readJsonBody(req, 64 * 1024)
          } catch (error) {
            return sendJson(res, 400, { error: describe(error) })
          }
          // `{patch}` 追加式保存；`{config}` 整份替换；裸配置对象也当 patch。
          const input = isPlainObject(body) && isPlainObject(body.patch)
            ? body.patch
            : isPlainObject(body) && isPlainObject(body.config)
              ? body.config
              : body
          if (!isPlainObject(input)) return sendJson(res, 400, { error: 'config patch must be an object' })
          let result
          try {
            result = saveAndApply(configStore, pipeline, statsStore, input, {
              source: 'tuning',
              note: isPlainObject(body) && typeof body.note === 'string' ? body.note : '',
            })
          } catch (error) {
            logger.warn(`tuning save rejected: ${describe(error)}`)
            return sendJson(res, 400, { error: describe(error) })
          }
          return sendJson(res, 200, {
            ...tuningView(pipeline, statsStore, configStore, storeDir),
            backupId: result.backupId,
            changed: result.changed,
            warnings: collectWarnings(input, pipeline.getConfig()),
            saved: result.error === null,
            error: result.error,
          })
        },
      }

      const restoreRoute = {
        kind: 'exact',
        path: RESTORE_ROUTE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' })
          let body
          try {
            body = await readJsonBody(req, 8 * 1024)
          } catch (error) {
            return sendJson(res, 400, { error: describe(error) })
          }
          const kind = isPlainObject(body) ? body.kind : undefined
          let result
          try {
            if (kind === 'defaults') {
              result = configStore.resetDefaults()
            } else if (kind === 'backup') {
              result = configStore.restoreBackup(isPlainObject(body) ? body.id : undefined)
              if (typeof result.error === 'string' && result.error.startsWith('invalid backup id')) {
                return sendJson(res, 400, { error: 'invalid backup id' })
              }
            } else {
              return sendJson(res, 400, { error: "kind must be 'defaults' or 'backup'" })
            }
            pipeline.applyFullConfig(result.config)
            statsStore.configure(result.config)
          } catch (error) {
            logger.warn(`tuning restore rejected: ${describe(error)}`)
            return sendJson(res, 400, { error: describe(error) })
          }
          return sendJson(res, 200, {
            ...tuningView(pipeline, statsStore, configStore, storeDir),
            backupId: result.backupId,
            changed: result.changed,
            warnings: collectWarnings({}, pipeline.getConfig()),
            saved: result.error === null,
            error: result.error,
          })
        },
      }

      child.effect(() => {
        const disposers = [statsRoute, configRoute, tuningRoute, restoreRoute].map((route) => child.webServer.register(route))
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* a stale route must never break unload */
            }
          }
        }
      }, 'rice-guard:api-routes')
    })
  } catch (error) {
    logger.warn(`panel routes are not registered: ${describe(error)}`)
  }
}

/** Save to the archive, then apply the resolved config to the live pipeline. */
function saveAndApply(configStore, pipeline, statsStore, input, meta) {
  const result = configStore.save(input, meta)
  pipeline.applyFullConfig(result.config)
  statsStore.configure(result.config)
  return result
}

/** One tuning snapshot; used by GET and after every write. */
function tuningView(pipeline, statsStore, configStore, storeDir) {
  const config = pipeline.getConfig()
  const status = configStore.status()
  return {
    ok: true,
    meta: CONFIG_META,
    groups: CONFIG_GROUPS,
    defaults: DEFAULTS,
    effective: config,
    persisted: configStore.storedConfig(),
    source: status.source,
    origin: status.origin,
    savedAt: status.savedAt,
    storePath: status.path,
    dir: storeDir,
    backups: configStore.listBackups(),
    warnings: collectWarnings({}, config),
    storage: statsStore.info(),
  }
}

/** Dangerous-combination audit + unpriced model note. */
function collectWarnings(patch, config) {
  const warnings = auditConfig(config)
  if (isPlainObject(patch) && Object.keys(patch).length > 0) {
    warnings.push(...clampWarnings(patch, config))
  }
  try {
    const pricing = pricingSnapshot(config.pricing)
    if (pricing.status !== 'priced') {
      warnings.push(`价表未命中模型「${config.pricing.model}」：省钱估算只显示 token，不折算金额。`)
    }
  } catch {
    /* 价表异常不影响配置保存 */
  }
  return warnings
}

/** Only the five runtime switches are writable through the legacy route. */
function pickSwitches(body) {
  const out = {}
  if (!isPlainObject(body)) return out
  for (const [group, keys] of Object.entries(SWITCH_GROUPS)) {
    const source = body[group]
    if (!isPlainObject(source)) continue
    const picked = {}
    for (const key of keys) {
      if (typeof source[key] === 'boolean') picked[key] = source[key]
    }
    if (Object.keys(picked).length > 0) out[group] = picked
  }
  return out
}

/** `?window=today|d7|d30`, default 30-day view. */
function readWindow(req) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const value = url.searchParams.get('window')
    return WINDOW_IDS.includes(value) ? value : 'd30'
  } catch {
    return 'd30'
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Collect a small JSON request body; rejects oversized or malformed input. */
function readJsonBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
  })
}

// ----------------------------------------------------------------- inspect

/**
 * Register the read-only Inspect Provider when the host offers `cordisInspect`.
 * `effect` owns the disposer so a reload removes the old provider before the new
 * one registers (the process-unique id would reject the second registration).
 */
function installInspectProvider(ctx, pipeline, configStore, logger) {
  if (!ctx || typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['cordisInspect'], (child) => {
      try {
        const registration = createInspectProvider(pipeline, configStore)
        child.effect(() => child.cordisInspect.register(registration), INSPECT_EFFECT_LABEL)
      } catch (error) {
        logger.warn(`inspect provider is not registered: ${describe(error)}`)
      }
    })
  } catch (error) {
    logger.warn(`inspect provider is not registered: ${describe(error)}`)
  }
}

/** Build the `cordisInspect.register` registration; no state beyond the closures. */
function createInspectProvider(pipeline, configStore) {
  return {
    manifest: {
      id: INSPECT_PROVIDER_ID,
      description:
        'Read-only statistics and effective configuration of the dsh-rice-guard cache-pipeline: model-facing tool projection shaping plus deterministic key ordering.',
      methods: [
        {
          name: 'inspect',
          description:
            'Return a snapshot of the cache-pipeline counters and the truncation/ordering switches that produced them.',
          inputSchema: INSPECT_EMPTY_INPUT,
          outputSchema: INSPECT_ANY_OUTPUT,
        },
      ],
    },
    query(method) {
      if (method !== 'inspect') throw new Error(`unknown RiceGuard inspect method "${method}"`)
      return { ...inspectSnapshot(pipeline), config: configSummary(pipeline.getConfig(), configStore) }
    },
  }
}

/**
 * Shallow copy of `pipeline.inspect()` without `undefined` values.
 *
 * Every counter is a primitive, so a shallow copy is a complete snapshot. The
 * filter mirrors ECMA-262 `JSON.stringify` object semantics (undefined-valued
 * keys are omitted), which keeps the result a lossless JSON value.
 */
function inspectSnapshot(pipeline) {
  const snapshot = {}
  for (const [key, value] of Object.entries(pipeline.inspect())) {
    if (value !== undefined) snapshot[key] = value
  }
  return snapshot
}

/** Only the fields the panel needs; secrets and paths stay out. */
function configSummary(config, configStore) {
  return {
    source: configStore && typeof configStore.status === 'function' ? configStore.status().source : 'profile',
    truncation: {
      enabled: config.truncation.enabled,
      dryRun: config.truncation.dryRun,
      shadowPrefixes: [...config.truncation.shadowPrefixes],
      keepFullCount: config.truncation.keepFull.length,
    },
    visibility: {
      enabled: config.visibility.enabled,
      dryRun: config.visibility.dryRun,
      exactCount: config.visibility.exact.length,
      prefixes: [...config.visibility.prefixes],
    },
    ordering: {
      enabled: config.ordering.enabled,
      verify: config.ordering.verify,
    },
    freeze: {
      enabled: config.freeze.enabled,
    },
    storage: {
      enabled: config.storage.enabled,
      maxBackups: config.storage.maxBackups,
    },
    pricing: {
      model: config.pricing.model,
      period: config.pricing.period,
      override: config.pricing.override !== null,
    },
  }
}

// ------------------------------------------------------------------ logger

/**
 * Build the logger the module consumes. Works with both documented shapes of
 * `ctx.logger`: callable (`ctx.logger('name')` → named logger) and object
 * (`ctx.logger.warn(...)`). Level filtering uses `debug.logLevel`.
 */
function createLogger(ctx, config) {
  let scoped
  try {
    const raw = ctx ? ctx.logger : undefined
    if (typeof raw === 'function') scoped = raw('rice-guard')
    else if (raw && typeof raw === 'object') scoped = raw
  } catch {
    scoped = undefined
  }

  const configured = config && config.debug ? config.debug.logLevel : 'warn'
  const rank = configured === 'silent' ? 0 : configured === 'info' ? 2 : 1
  const emit = (needed, level, message) => {
    if (rank < needed) return
    try {
      const fn = scoped && scoped[level]
      if (typeof fn === 'function') fn.call(scoped, `[rice-guard] ${message}`)
    } catch {
      /* logging must never break activation */
    }
  }

  return {
    error: (message) => emit(1, 'error', message),
    warn: (message) => emit(1, 'warn', message),
    info: (message) => emit(2, 'info', message),
    debug: (message) => emit(2, 'debug', message),
  }
}

/** Forward early store warnings to the logger once it exists. */
function forwardLog(logger, level, message) {
  if (logger === null) return
  try {
    const fn = logger[level]
    if (typeof fn === 'function') fn.call(logger, message)
  } catch {
    /* a log sink must never throw */
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function describe(error) {
  if (error instanceof Error) return error.message || String(error)
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
