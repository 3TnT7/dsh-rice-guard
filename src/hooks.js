/**
 * 职责
 *   钩子注册骨架：`src/index.js` 只调用一次 `installHooks`，把模块产出的
 *   `HookSpec[]` 交给它；本文件是全插件唯一碰 `ctx.on` 的地方。
 *
 * 依赖的 DSH 契约（DSH 0.2.1-rc.2）
 *   - `ctx.on(event, listener)`：返回 disposer，监听器随插件 fiber 卸载自动释放；
 *     本文件不保存、也不主动调用该 disposer。
 *   - 事件类型由 spec 声明：`serial`（顺序执行、可 bail）与 `waterfall`
 *     （宿主注入 `next()`；不调用 `next()` 等于否决后续链）。
 *   - 本模块只用 `waterfall` + `own-errors-only`，不依赖其它事件。
 *
 * 关键决策与依据
 *   - 错误语义按 spec 声明、刻意不对称（《整合实现方案》§6.5）：
 *     `never-throw` 吞掉同步抛错与 rejection 并记 warn；`own-errors-only` 原样调用
 *     handler，`next()` 的 rejection 必须由 handler 上抛，不能在这里吞。
 *   - 逐条隔离失败：某个 spec 装不上只记 failed，不影响后面的 spec。
 *   - `assertHookSpec` 在注册前校验形状，坏 spec 不落进 `ctx.on`。
 *
 * 已知边界
 *   - `never-throw` 由 `session/event` 用量旁路（`src/usage.js`）使用；
 *     spend-guard / loop-breaker 若接入也复用它，避免后来者各写一套。
 *   - 本文件不负责计数：handler 自己的失败由 handler 记账（`failed` 字段），
 *     这里只做「逃出 containment」的最后一条日志。
 *   - 不提供卸载 API：生命周期由宿主 fiber 管理。
 */

/**
 * 逐条安装。失败的那条记进 `failed` 并跳过，绝不影响下一条。
 *
 * @param {{ on: (event: string, listener: Function, options?: object) => unknown }} ctx
 * @param {readonly object[]} specs
 * @param {{ logger?: object }} [deps]
 * @returns {{ installed: { id: string, event: string }[], failed: { id: string, error: unknown }[] }}
 */
export function installHooks(ctx, specs, deps) {
  const installed = []
  const failed = []
  const list = Array.isArray(specs) ? specs : []

  for (const spec of list) {
    let id
    try {
      id = assertHookSpec(spec)
      if (!ctx || typeof ctx.on !== 'function') {
        throw new TypeError('hook context does not provide on()')
      }
      const listener = wrapHook(spec, deps)
      ctx.on(spec.event, listener)
      installed.push({ id: spec.id, event: spec.event })
    } catch (error) {
      failed.push({ id: id ?? (spec && typeof spec.id === 'string' ? spec.id : ''), error })
      report(deps, 'warn', `failed to install hook "${id ?? '?'}" on "${eventOf(spec)}": ${describe(error)}`)
    }
  }

  return { installed, failed }
}

/**
 * 唯一的包装点。`never-throw` 把同步抛错和 rejected promise 都变成 `undefined`
 * 加一条日志；`own-errors-only` 完全不插手：handler 自己的 try/catch 与
 * `next()` 的原样上抛已经是对的（《整合实现方案》§6.5）。
 */
function wrapHook(spec, deps) {
  const handler = spec.handler

  if (spec.containment === 'own-errors-only') {
    return function listener(...args) {
      return handler.apply(this, args)
    }
  }

  return function listener(...args) {
    try {
      const result = handler.apply(this, args)
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).catch((error) => {
          reportHookFailure(deps, spec, error)
          return undefined
        })
      }
      return result
    } catch (error) {
      reportHookFailure(deps, spec, error)
      return undefined
    }
  }
}

function reportHookFailure(deps, spec, error) {
  // 计数是 handler 的职责（它拥有 pipeline 统计）；这里只是 handler 逃出自身
  // containment 后的最后一条日志，不重复加 failed。
  report(deps, 'warn', `hook "${spec.id}" failed inside its containment: ${describe(error)}`)
}

function assertHookSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('hook spec must be an object')
  if (typeof spec.id !== 'string' || spec.id === '') throw new TypeError('hook spec id must be a non-empty string')
  if (typeof spec.event !== 'string' || spec.event === '') throw new TypeError('hook spec event must be a non-empty string')
  if (spec.kind !== 'serial' && spec.kind !== 'waterfall') throw new TypeError(`hook spec "${spec.id}" has an invalid kind`)
  if (spec.containment !== 'never-throw' && spec.containment !== 'own-errors-only') {
    throw new TypeError(`hook spec "${spec.id}" has an invalid containment`)
  }
  if (typeof spec.handler !== 'function') throw new TypeError(`hook spec "${spec.id}" has no handler`)
  return spec.id
}

function eventOf(spec) {
  return spec && typeof spec.event === 'string' ? spec.event : '?'
}

function report(deps, level, message) {
  try {
    const logger = deps && deps.logger
    const fn = logger && logger[level]
    if (typeof fn === 'function') fn.call(logger, `[hooks] ${message}`)
  } catch {
    /* logging must never break registration */
  }
}

function describe(error) {
  if (error instanceof Error) return error.message || String(error)
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
