/**
 * 职责
 *   按码点安全的文本截断：窗口按码点算，边界标记也在同一坐标系里找；
 *   优先在句子/换行边界处切，切完追加 ` …` 软后缀。
 *
 * 依赖的 DSH 契约（DSH 0.2.1-rc.2）
 *   - 无 DSH API：纯函数，零 import、不读环境；可在裸 `node --test` 下运行。
 *   - 输出是 `ToolSchema.description` 的候选字符串；「空结果保留原文」由调用方负责。
 *
 * 关键决策与依据
 *   - 码点而不是 UTF-16 单元：旧实现按 UTF-16 切片，可能把代理对切成两半
 *     （半个 emoji / 无效字符串）。`Array.from` + `for…of` 按码点迭代，
 *     截断点永远落在合法字符串边界内。
 *   - 不用 `Intl.Segmenter`：它能按字素簇切，但会让输出依赖宿主 ICU 版本，
 *     破坏「同输入同字节」；本模块把确定性放在首位（《变更说明》§4.2）。
 *   - 截断边界受 Unicode UAX #29（Unicode Text Segmentation）约束：码点安全
 *     **不等于** 字素安全，ZWJ 序列（👨‍👩‍👧）、组合字符、印度语连字仍可能在中间被切开。
 *     这是已知取舍，不是遗漏（README「已知限制」）。
 *   - 边界优先 + 最小保留比例 0.45：只有切点保留足够内容时才用边界，否则宁可切满
 *     窗口，避免产出过短的描述。
 *   - 后缀 ` …` 不占窗口：最终长度可能比 `max` 多 2 个码点；验收按 `max + 2` 判断
 *     （《变更说明》§6.1 A2）。
 *   - 行为与默认值源自 dsh-cache-saver（MIT,
 *     Copyright (c) 2026 dsh-cache-saver contributors；
 *     https://github.com/ium9khbep8834-maker/dsh-cache-saver）。
 *     本实现已重写并修改，不是逐行复制；差异见 NOTICE.md。
 *
 * 已知边界
 *   - 字素簇可能被切断（见上，UAX #29）；没有 `grapheme` 模式。
 *   - 首尾空白会被 trim，所以短文本也可能与原文差几个空白字节（《变更说明》§5.1 R6）。
 *   - 不是不动点：对已截断文本再截一次可能再切一刀（§4.2 D2）。
 *   - 空字符串/纯空白/非字符串返回空结果，由调用方决定保留原值。
 */

/**
 * 优先切点，顺序无关：换行、英文句号/分号（含空格，避免切断缩写）、
 * 中文句号/分号。全部按码点比较，不按 UTF-16。
 */
export const DEFAULT_BOUNDARY_MARKERS = Object.freeze(['\n', '. ', '; ', '。', '；'])

/**
 * 截断后缀固定为 ` …`（空格 + 省略号）：软提示「这里被截过」，且不占窗口，
 * 所以最终长度可比上限多 2 个码点（《变更说明》§6.1 A2）。
 */
export const DEFAULT_SUFFIX = ' …'

/**
 * 边界切点至少保住窗口的 45% 才采用：边界太靠前时宁可切满窗口，
 * 否则一条 260 码点的描述可能因为句号在开头而只剩几十个字。
 */
export const DEFAULT_MIN_KEEP_RATIO = 0.45

/**
 * 字符串的 Unicode 码点数。孤立代理项各计 1（与 `for…of` / `Array.from` 一致），
 * 这是截断点能落在 emoji 之间却不产生非法字符串的原因。
 *
 * @param {unknown} text
 * @returns {number}
 */
export function codePointLength(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let count = 0
  for (const _codePoint of text) count += 1
  return count
}

/**
 * 把描述截到至多 `maxCodePoints` 个码点，优先窗口内的句子/换行边界。
 *
 * @param {unknown} text
 * @param {number} maxCodePoints
 * @param {{ boundaryMarkers?: readonly string[], suffix?: string, minKeepRatio?: number }} [options]
 * @returns {{ text: string, truncated: boolean, beforeCodePoints: number, afterCodePoints: number }}
 */
export function truncateDescription(text, maxCodePoints, options = {}) {
  const empty = { text: '', truncated: false, beforeCodePoints: 0, afterCodePoints: 0 }
  if (typeof text !== 'string') return empty

  const max = Number.isFinite(maxCodePoints) ? Math.trunc(maxCodePoints) : 0
  if (!(max > 0)) return empty

  // 先 trim：与旧插件一致，短文本也可能因此比原文少几个空白字节（§5.1 R6）。
  const trimmed = text.trim()
  if (trimmed === '') return empty

  const codePoints = Array.from(trimmed)
  const beforeCodePoints = codePoints.length
  if (beforeCodePoints <= max) {
    return { text: trimmed, truncated: false, beforeCodePoints, afterCodePoints: beforeCodePoints }
  }

  const suffix = typeof options.suffix === 'string' ? options.suffix : DEFAULT_SUFFIX
  const markers = Array.isArray(options.boundaryMarkers)
    ? options.boundaryMarkers.filter((marker) => typeof marker === 'string' && marker.length > 0)
    : DEFAULT_BOUNDARY_MARKERS
  const ratio = Number.isFinite(options.minKeepRatio)
    ? Math.min(1, Math.max(0, options.minKeepRatio))
    : DEFAULT_MIN_KEEP_RATIO

  // 全程只在这一个码点数组上做事：窗口、边界查找、拼接不会出现坐标不一致。
  const window = codePoints.slice(0, max)
  const boundaryEnd = findLastBoundaryEnd(window, markers)
  const keep = boundaryEnd > max * ratio ? boundaryEnd : max
  const base = trimTrailingWhitespace(window.slice(0, keep).join(''))
  const output = base + suffix

  return {
    text: output,
    truncated: true,
    beforeCodePoints,
    afterCodePoints: codePointLength(output),
  }
}

/**
 * 窗口内最后一个边界标记的结束下标（exclusive），找不到返回 -1。
 * 标记按码点逐个比较，绝不用 UTF-16 的 `lastIndexOf`：后者可能落在代理对中间，
 * 与窗口的坐标系统不一致（UAX #29 的边界问题见文件头）。
 */
function findLastBoundaryEnd(window, markers) {
  let best = -1
  for (const marker of markers) {
    const markerCodePoints = Array.from(marker)
    if (markerCodePoints.length === 0 || markerCodePoints.length > window.length) continue
    for (let start = window.length - markerCodePoints.length; start >= 0; start -= 1) {
      let match = true
      for (let offset = 0; offset < markerCodePoints.length; offset += 1) {
        if (window[start + offset] !== markerCodePoints[offset]) {
          match = false
          break
        }
      }
      if (match) {
        const end = start + markerCodePoints.length
        if (end > best) best = end
        break
      }
    }
  }
  return best
}

function trimTrailingWhitespace(text) {
  // 只去掉边界切点前的空白，避免后缀前出现「.  …」这种双空格。
  return text.replace(/\s+$/u, '')
}
