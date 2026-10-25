/**
 * 职责
 *   DeepSeek 官方价表快照（手写一次；后续由 `scripts/update-pricing.mjs` 生成）。
 *   只放数据，不放逻辑；运行时零网络、零依赖。
 *
 * 依赖的 DSH 契约
 *   - 无：纯数据模块，可被裸 `node --test` 直接 import。
 *
 * 关键决策与依据
 *   - 价格单位统一「元 / 百万 token」，与官方页一致；不在这里做换算。
 *   - `hoursUtc` 是官方「北京时间 09:00–12:00、14:00–18:00」换算到 UTC 的结果：
 *     09:00→01:00、12:00→04:00、14:00→06:00、18:00→10:00。北京无夏令时，固定 −8。
 *   - `days` 用 UTC 的 `getUTCDay()` 编号（周日 0）：周一至周五 = 1..5。
 *   - 官方调价时：跑 `node scripts/update-pricing.mjs`，不要手改数值；手改也只需改
 *     本文件并更新 `PRICING_AS_OF`。
 *
 * 已知边界
 *   - 只收 `deepseek-flash` / `deepseek-v4-pro` 两条官方在售线；旧名
 *     （`deepseek-v4-flash` 等）由 `resolveModel` 归并到对应条目，不单列。
 *   - 节假日不在这份数据里：官方写「不含中国法定节假日」，本插件不维护假日表
 *     （那是 dsh-session-guard 的职责），`isPeakAt` 只按星期与小时判断。
 */

/** 价表抓取/核对日期（UTC 日期，YYYY-MM-DD）。 */
export const PRICING_AS_OF = '2026-10-25'

/** 官方定价页（中文，人民币）。 */
export const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/** 币种；面板与文案都按它显示。 */
export const PRICING_CURRENCY = 'CNY'

/** 高峰时段：UTC 周一至周五 01:00–04:00、06:00–10:00（北京时间 09–12、14–18）。 */
export const PRICING_PEAK = Object.freeze({
  days: Object.freeze([1, 2, 3, 4, 5]),
  hoursUtc: Object.freeze([Object.freeze([1, 4]), Object.freeze([6, 10])]),
})

/**
 * 官方价表（元 / 百万 token）。
 * 每个模型三组价：`hit`（输入·缓存命中）、`miss`（输入·缓存未命中）、`out`（输出），
 * 每组分 `off`（空闲时段）与 `peak`（高峰时段）。
 */
export const PRICING_MODELS = Object.freeze([
  Object.freeze({
    id: 'deepseek-flash',
    label: 'DeepSeek-V4.1-Flash-1017',
    hit: Object.freeze({ off: 0.02, peak: 0.04 }),
    miss: Object.freeze({ off: 1, peak: 2 }),
    out: Object.freeze({ off: 4, peak: 8 }),
  }),
  Object.freeze({
    id: 'deepseek-v4-pro',
    label: 'DeepSeek-V4-Pro-0813',
    hit: Object.freeze({ off: 0.15, peak: 0.3 }),
    miss: Object.freeze({ off: 4.5, peak: 9 }),
    out: Object.freeze({ off: 13.5, peak: 27 }),
  }),
])
