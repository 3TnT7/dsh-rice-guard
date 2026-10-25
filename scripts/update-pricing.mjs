/**
 * 职责
 *   维护脚本：抓 DeepSeek 官方定价页 → 解析 → 重写 `src/pricing-data.js`。
 *   **运行时不会执行本文件**；插件本身不联网，价表以生成的快照为准。
 *
 * 用法
 *   node scripts/update-pricing.mjs               # 抓官方页，有变化则重写价表
 *   node scripts/update-pricing.mjs --check       # 只比对，不写；有差异退出码 1
 *   node scripts/update-pricing.mjs --from <html> # 离线：解析本地 HTML（调试/测试用）
 *
 * 退出码
 *   0 = 成功（含「无变化」）｜1 = --check 发现差异｜2 = 抓取或解析失败
 *
 * 关键决策与依据
 *   - 抓取与解析逻辑改编自 dsh-token-use@0.3.4（MIT，见 NOTICE.md）；解析器本体在
 *     `src/pricing.js`（纯函数），本脚本只负责 I/O 与文件生成。
 *   - **先写临时文件再 rename**：解析失败或中途异常时绝不留下半份价表。
 *   - 只改 `src/pricing-data.js`，不碰其它文件；改完需要重启宿主才会加载新价表。
 *
 * 已知边界
 *   - 官方页改版导致解析失败时，运行时继续用旧快照；本脚本退出码 2，不写文件。
 *   - 需要 Node ≥ 22（自带 `fetch` 与 `AbortSignal.timeout`）。
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_FILE = join(ROOT, 'src', 'pricing-data.js')
const SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
const TIMEOUT_MS = 15_000

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const fromIndex = args.indexOf('--from')
const fromPath = fromIndex >= 0 ? args[fromIndex + 1] : undefined

const { parsePricingDocument } = await import(pathToFileURL(join(ROOT, 'src', 'pricing.js')).href)

function fail(code, message) {
  console.error(`[update-pricing] ${message}`)
  process.exit(code)
}

async function loadHtml() {
  if (fromPath !== undefined) {
    return readFile(fromPath, 'utf8')
  }
  const response = await fetch(SOURCE_URL, {
    headers: { 'user-agent': 'dsh-rice-guard update-pricing (+https://github.com/)', accept: 'text/html' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/** 与生成文件一致的序列化：数字原样、结构稳定，便于 diff。 */
function renderData(parsed, asOf) {
  const models = parsed.models.map((model) => `  Object.freeze({
    id: ${JSON.stringify(model.id)},
    label: ${JSON.stringify(model.label)},
    hit: Object.freeze({ off: ${model.hit.off}, peak: ${model.hit.peak} }),
    miss: Object.freeze({ off: ${model.miss.off}, peak: ${model.miss.peak} }),
    out: Object.freeze({ off: ${model.out.off}, peak: ${model.out.peak} }),
  }),`).join('\n')
  const ranges = parsed.peak.hoursUtc.map((range) => `Object.freeze([${range[0]}, ${range[1]}])`).join(', ')
  return `/**
 * 职责
 *   DeepSeek 官方价表快照（由 \`scripts/update-pricing.mjs\` 生成，勿手改数值）。
 *   只放数据，不放逻辑；运行时零网络、零依赖。
 *
 * 依赖的 DSH 契约
 *   - 无：纯数据模块，可被裸 \`node --test\` 直接 import。
 *
 * 关键决策与依据
 *   - 价格单位统一「元 / 百万 token」，与官方页一致；不在这里做换算。
 *   - \`hoursUtc\` 是官方「北京时间」换算到 UTC 的结果（北京固定 −8，无夏令时）。
 *   - \`days\` 用 UTC 的 \`getUTCDay()\` 编号（周日 0）：周一至周五 = 1..5。
 *
 * 已知边界
 *   - 只收官方在售线；旧名由 \`resolveModel\` 归并，不单列。
 *   - 节假日不在这份数据里：本插件不维护假日表（那是 dsh-session-guard 的职责）。
 *
 * 生成信息：${asOf} ｜ ${SOURCE_URL} ｜ peakParsed=${parsed.peakParsed}
 */

/** 价表抓取/核对日期（UTC 日期，YYYY-MM-DD）。 */
export const PRICING_AS_OF = ${JSON.stringify(asOf)}

/** 官方定价页（中文，人民币）。 */
export const PRICING_SOURCE = ${JSON.stringify(SOURCE_URL)}

/** 币种；面板与文案都按它显示。 */
export const PRICING_CURRENCY = ${JSON.stringify(parsed.currency)}

/** 高峰时段（UTC）。 */
export const PRICING_PEAK = Object.freeze({
  days: Object.freeze([${parsed.peak.days.join(', ')}]),
  hoursUtc: Object.freeze([${ranges}]),
})

/**
 * 官方价表（元 / 百万 token）。
 * 每个模型三组价：\`hit\`（输入·缓存命中）、\`miss\`（输入·缓存未命中）、\`out\`（输出），
 * 每组分 \`off\`（空闲时段）与 \`peak\`（高峰时段）。
 */
export const PRICING_MODELS = Object.freeze([
${models}
])
`
}

function signature(parsed) {
  return JSON.stringify({
    currency: parsed.currency,
    peak: parsed.peak,
    models: parsed.models,
  })
}

try {
  const html = await loadHtml()
  const parsed = parsePricingDocument(html)
  if (parsed === null) fail(2, '解析失败：官方页结构可能与解析器不一致，未写入任何文件')

  const current = await import(pathToFileURL(DATA_FILE).href)
  const currentSignature = signature({
    currency: current.PRICING_CURRENCY,
    peak: current.PRICING_PEAK,
    models: current.PRICING_MODELS,
  })
  const nextSignature = signature(parsed)
  const asOf = new Date().toISOString().slice(0, 10)

  if (checkOnly) {
    if (currentSignature === nextSignature) {
      console.log('[update-pricing] 无差异：价表与官方页一致')
      process.exit(0)
    }
    console.error('[update-pricing] 有差异：请跑一次不带 --check 的命令来更新 src/pricing-data.js')
    process.exit(1)
  }

  if (currentSignature === nextSignature) {
    console.log(`[update-pricing] 无差异，保持 PRICING_AS_OF=${current.PRICING_AS_OF}`)
    process.exit(0)
  }

  const temp = `${DATA_FILE}.tmp`
  await writeFile(temp, renderData(parsed, asOf), 'utf8')
  await rename(temp, DATA_FILE)
  console.log(`[update-pricing] 已更新 src/pricing-data.js（${asOf}）：${parsed.models.map((model) => model.id).join(', ')}`)
  console.log('[update-pricing] 重启宿主后生效；记得在 README/NOTICE 里核对 asOf')
} catch (error) {
  fail(2, `抓取或解析失败：${error instanceof Error ? error.message : String(error)}`)
}
