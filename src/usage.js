/**
 * provider 用量只读旁路：高频事件先做常数次判断，不记录无关事件。
 * 不修改会话或事件；统计失败不能影响宿主消息链路。
 */
export function createUsageHook(deps) {
  return {
    id: 'usage-record',
    event: 'session/event',
    kind: 'serial',
    containment: 'never-throw',
    handler(session, event) {
      try {
        if (!session || typeof session.id !== 'string' || session.id === '') return
        if (!event || event.type !== 'assistant/message') return
        const usage = event.data && event.data.usage
        if (!usage || typeof usage !== 'object') return
        if (!positive(usage.inputTokens) && !positive(usage.outputTokens)
          && !positive(usage.cacheReadTokens) && !positive(usage.cacheWriteTokens)
          && !positive(usage.reasoningTokens)) return
        deps.recordUsage({ sessionId: session.id, ts: event.time, usage })
      } catch {
        /* 只读统计旁路永不向宿主抛错。 */
      }
    },
  }
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
