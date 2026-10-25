/**
 * 职责
 *   插件自己的数据目录解析。只回答「放哪」，不碰任何文件。
 *
 * 依赖的 DSH 契约
 *   - `$DSH_HOME` 覆盖默认家目录；默认 `~/.dsh`。与官方
 *     `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` 语义一致，但本插件
 *     不引该包（零运行时依赖，profile 里不一定解析得到它）。
 *
 * 关键决策与依据
 *   - 数据放 `$DSH_HOME/storages/<plugin>/`，与 `dsh-cost-meter`
 *     （`storages/cost-meter/ledger.json`）同一约定，用户知道去哪清理。
 *   - 目录固定、不做配置项：存档位置一旦可配，就会出现「配置说 A、文件在 B」
 *     的启动自举矛盾（要读配置先得知道配置在哪）。需要换盘时用 `DSH_HOME`。
 *
 * 已知边界
 *   - `DSH_HOME` 只按字符串原样使用，不展开 `~`；这是官方包的行为，保持一致。
 *   - 沙箱/只读挂载下目录可能建不出来；调用方把写入失败当「无持久化」处理，不抛。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 插件在 `storages/` 下的目录名（与插件 id 一致，便于用户辨认）。 */
export const STORE_DIR_NAME = 'dsh-rice-guard'

/**
 * 解析 DSH 家目录，永不抛。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} 绝对路径
 */
export function resolveDshHome(env = process.env) {
  try {
    const configured = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
    if (configured !== '') return configured
  } catch {
    /* 敌意 env 直接退回默认 */
  }
  return join(homedir(), '.dsh')
}

/** 本插件的数据根目录（统计 JSONL、精调存档与备份都在这下面）。 */
export function defaultStoreDir(env = process.env) {
  return join(resolveDshHome(env), 'storages', STORE_DIR_NAME)
}
