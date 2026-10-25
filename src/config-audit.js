/**
 * 职责
 *   配置审阅（0.7.0）：把「危险的配置组合」与「被 normalize 静默改掉的值」翻译成
 *   人话警告，供概览面板与精调页展示。只读、纯函数，不改配置。
 *
 * 关键决策与依据
 *   - `normalizeConfig` 的契约是「永不抛、静默回退/clamp」，这对线上安全但会让
 *     用户在精调页填了 9999 却实际按 1000 跑。`clampWarnings` 抵消这个盲区：
 *     保存后对比「你填的叶子」与「实际生效的叶子」，不一致就明说。
 *   - 警告分两类：`auditConfig` 看「最终态是否自相矛盾/危险」，`clampWarnings`
 *     看「输入是否被改写」。两者都不阻止保存——面板负责告知，用户负责决定。
 *
 * 已知边界
 *   - 只覆盖本插件自己的配置语义；不知道 profile 里其它插件的设置。
 *   - 价格表匹配（unpriced）需要 pricing 模块，交给 `index.js` 追加，本文件不引。
 */
import { deepEqual, flattenPaths } from './config-store.js'

/**
 * 检查一份生效配置的危险组合。
 * @param {object} config 规范化后的完整配置
 * @returns {string[]} 面向用户的中文警告
 */
export function auditConfig(config) {
  const warnings = []
  if (!config || typeof config !== 'object') return warnings
  const truncation = config.truncation || {}
  const visibility = config.visibility || {}
  const ordering = config.ordering || {}
  const freeze = config.freeze || {}
  const storage = config.storage || {}

  if (truncation.enabled && Array.isArray(truncation.shadowPrefixes) && truncation.shadowPrefixes.length === 0) {
    warnings.push('瘦身前缀为空：等于「处理全部工具」，会把 core 工具定义也瘦身，务必先 dryRun 验证。')
  }
  if (
    truncation.enabled &&
    typeof truncation.maxSchemaChars === 'number' &&
    typeof truncation.minSchemaChars === 'number' &&
    truncation.maxSchemaChars < truncation.minSchemaChars
  ) {
    warnings.push('瘦身目标上限（maxSchemaChars）低于生效门槛（minSchemaChars）：大多数 schema 不会被瘦身。')
  }
  const hideListEmpty =
    (Array.isArray(visibility.exact) ? visibility.exact.length : 0) === 0 &&
    (Array.isArray(visibility.prefixes) ? visibility.prefixes.length : 0) === 0
  if (visibility.enabled && hideListEmpty) {
    warnings.push('消隐已开启但名单为空：当前不会移除任何工具（空名单不等于全删）。')
  }
  if (!visibility.enabled && !hideListEmpty) {
    warnings.push('消隐名单已填写但开关关闭：名单不会生效，模型仍能看到这些工具。')
  }
  if (!freeze.enabled) {
    warnings.push('会话冻结已关闭：之后改配置会立刻作用于所有会话，可能击穿前缀缓存（重建一次约 ¥0.49）。')
  }
  if (ordering.enabled && typeof ordering.circuitBreaker === 'number' && ordering.circuitBreaker <= 0) {
    warnings.push('排序熔断已关闭：排序连续失败时不会自动停用，只能靠人工发现。')
  }
  if (storage.enabled === false) {
    warnings.push('持久化关闭：统计历史与自动备份不再写盘；精调存档本身仍会保存（否则关不掉）。')
  }
  return warnings
}

/**
 * 对比「用户提交的叶子」与「实际生效的叶子」，指出被 normalize 改掉的值。
 * @param {object} patch 用户提交的配置片段
 * @param {object} effective 规范化后的完整配置
 * @returns {string[]}
 */
export function clampWarnings(patch, effective) {
  const wanted = flattenPaths(patch)
  const actual = flattenPaths(effective)
  const warnings = []
  for (const [path, value] of Object.entries(wanted)) {
    if (!Object.hasOwn(actual, path)) {
      warnings.push(`${path}：未知配置项，已忽略。`)
      continue
    }
    if (!deepEqual(value, actual[path])) {
      warnings.push(`${path}：填写 ${format(value)}，实际生效 ${format(actual[path])}（被规范化规则修正）。`)
    }
  }
  return warnings
}

function format(value) {
  const text = JSON.stringify(value)
  if (typeof text !== 'string') return String(value)
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}
