# dsh-rice-guard

一个零第三方依赖的 DSH 插件 bundle。第一个模块是 **cache-pipeline**：不改变工具行为，只压缩每次请求都会重发的固定前缀，并让它逐字节稳定。

它注册两个监听器：

| 钩子 | 事件 | 做什么 |
|---|---|---|
| `shape-and-stabilize-tools` | `system-prompt/assemble` | 拿 `next()` 的权威结果，在**模型可见的工具投影**上处理：先按 `keepFull` → `shadowPrefixes` 过滤，命中且不在 `keepFull` 的工具按码点截断 `description`、压缩 `parameters`（深度坍缩 / description 截断 / 去注解）；再对整份列表做对象键排序（数组一律保序）。返回新的 assembly 对象；`sections` / `contexts` / `variables` 原引用不动。 |
| provider usage 记账 | `session/event` | 只读 `assistant/message.usage` 数字并记账，不读取 prompt 内容、不拦截请求。 |

模型看到的是瘦身投影，执行期仍按工具名回注册表取完整定义，所以 `dispatch` 行为不变；工具注册表一个字节都没动。

两个开关互相独立：`truncation.enabled` 控制瘦身，`ordering.enabled` 控制排序；同时开启时顺序固定为「先瘦身、后排序」。

默认处理所有 MCP 工具（`mcp__<server>__<tool>`），需要覆盖时改配置。未连接 MCP 时零命中，本插件空转，core 工具不受影响。

## 只读 Inspect Provider

宿主提供 `cordisInspect` 服务时，插件会注册一个只读 provider；服务缺失时插件照常激活，只是查不到它。

| 项 | 值 |
|---|---|
| provider id | `RiceGuard`（0.5.0 起；旧 id 为 `CachePipeline`） |
| 方法 | `inspect`（无输入） |
| 调用 | `cordis_inspect_query`：`platform: "host"`、`provider: "RiceGuard"`、`method: "inspect"` |

返回 `pipeline.inspect()` 的浅快照（`assembleCalls`、`shadowed`、`shadowedTotal`、`bytesSaved`、`canonicalFallbacks`、`failed`、`lastError`、`circuitOpen` 等全部统计字段），外加一份配置摘要：

```json
{
  "config": {
    "truncation": { "enabled": true, "dryRun": false, "shadowPrefixes": ["mcp__"], "keepFullCount": 8 },
    "ordering": { "enabled": true, "verify": "length" }
  }
}
```

- 只读：没有写操作，也不暴露工具定义或 schema 内容。
- 生命周期：注册挂在 `ctx.effect` 上，插件重载/卸载时自动释放；provider id 每进程唯一，重复注册只记一条 `warn`，不影响钩子。
- 快照在每次 query 时重新生成；从未失败时 `lastError` 按 JSON 语义省略，不在结果里出现。

## 左侧栏面板（Rice Guard）

web profile 下，插件会在左侧导航的「全局面板」里加一个 `Rice Guard` 入口（`order: 50`，排在「自动化任务」之后、「更多」之前）。点开是**三个页签**：

- **统计**：`今天` / `最近 7 天` / `最近 30 天`（按本机系统时区切日，面板会显示解析到的时区名，不写死）切换；卡片顺序为**瘦身率**、实测命中率、字节减少、token 减少、请求数、涉及对话数、影子工具、消隐工具；百分比直接标在卡片与「压缩效率」块里；新增「实测口径 · provider usage」块；还有省钱估算四行、「近 N 天按对话」表（短 id、首次/最后活动、请求数、省 token、**瘦身率**、按需显示命中率、省字节）；底部「本轮细节」「最近决策」折叠。统计**按对话落盘**（`$DSH_HOME/storages/dsh-rice-guard/stats/YYYY-MM.jsonl`），**重启不归零**；内存只保留 62 天窗口，更早的月份文件原样留在磁盘。
- **配置**：五个运行期开关 + 两个预设，保留二次确认；每项旁显示一句话说明、影响、默认值、推荐范围与「新会话生效」。保存会写入精调存档并自动备份上一份。
- **精调**：按分组渲染**全部 31 个配置项**，每项带功能说明、影响、默认值、推荐范围、风险徽标与生效时机；按类型提供开关 / 数字 / 枚举 / 文本 / 多行列表 / JSON 六种编辑器。改动逐项追踪、只提交 dirty 项；保存前自动备份，支持「恢复默认」与按备份「还原」（两者都要二次确认）。

- **会话冻结（重要）**：投影类改动按会话冻结——改动从**下一个新会话**生效，当前会话沿用第一次 assemble 时冻结的配置，不会击穿本会话的前缀缓存。保存成功后想看效果就开一个新会话。
- **二次确认**：会改变工具投影的三个开关（`truncation.enabled` / `ordering.enabled` / `visibility.enabled`）与两个预设，**第一次点击只进入待确认态**，5 秒内再点同一按钮才发请求；`dryRun` 单击直发。精调的「保存」不弹此确认（它有独立的风险徽标、保存前备份与错误回显）。
- **口径脚注**（常驻）：token 按 4 字符/token 估算，不是 provider 实报；「省下 token × 官价」是替代口径，**不是账单差额**；字节 ≠ token ≠ 钱，不可与其它插件的数字相加。
- **缺字段降级**：host 未提供某字段时显示 `—` 并禁用对应操作，不报错（客户端可能先于 host 更新）。


### 注册方式

浏览器半在 `src/client.js`，通过两个 root 作用域插槽注册，`id` / `key` 都是 `rice-guard`：

| 插槽 | 用途 | 注册项 |
|---|---|---|
| `sidebar.panellist` | 左侧导航的图标行 | `id: "rice-guard"`、`order: 50`、`label` 为本地化 thunk |
| `main` | 该行对应的主面板 | `key: "rice-guard"` |

`package.json` 里三样东西缺一不可：

- `exports["./client"]` 指向浏览器半；
- `dsh.client.platform = "web"`，并把 `dsh-client-runtime` / `dsh-client-locale` / `dsh-client-ui-layout` / `dsh-client-ui-sidebar` 放进 `dsh.client.inject`；
- `src/client.js` 用 `window.__ModuleLoader__.load()` 包一层（与官方客户端插件一致，无需构建）。

### HTTP 接口

面板数据来自 host 半注册的四条路由。只有 web profile（有 `webServer` 服务）才注册；headless / tui 下自动跳过，插件其余功能不受影响。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/rice-guard/stats?window=today\|d7\|d30` | `pipeline.inspect()` 快照 + `config` 摘要 + `windows`（三档窗口，含 `windows.*.usage`）+ 所选窗口的 `conversations`（含 `conversations[].usage`）+ `storage`（含 `storage.usageRecords`，为启动时从 JSONL 加载的 usage 行数，不含本进程新写入行；与 `recordsLoaded` 同口径）+ `timezone`，`cache-control: no-store` |
| `POST` | `/api/rice-guard/config` | 接受五个布尔开关；应用并写入精调存档，返回 `config` / `backupId` / `warnings` |
| `GET` | `/api/rice-guard/tuning` | 生效配置 `effective` + 31 项元数据 `meta` + 存档 `persisted` + `backups` + `warnings` |
| `POST` | `/api/rice-guard/tuning` | body `{ "patch": {…}, "note": "…" }`（增量）或 `{ "config": {…} }`（整份）；保存前自动备份，返回 `backupId` / `changed` / `warnings` |
| `POST` | `/api/rice-guard/tuning/restore` | body `{ "kind": "defaults" }` 或 `{ "kind": "backup", "id": "…" }`；还原前也会备份当前配置 |

```bash
curl -s 'http://127.0.0.1:<port>/api/rice-guard/stats?window=d7'

curl -s -X POST -H 'content-type: application/json' \
  -d '{"truncation":{"dryRun":true}}' \
  http://127.0.0.1:<port>/api/rice-guard/config

curl -s -X POST -H 'content-type: application/json' \
  -d '{"patch":{"truncation":{"maxDescriptionChars":300}}}' \
  http://127.0.0.1:<port>/api/rice-guard/tuning
```

- **全部写操作都会落盘**到 `$DSH_HOME/storages/dsh-rice-guard/config.json`，重启后仍在；每次保存前把上一份生效配置备份到同目录 `backups/`，份数由 `storage.maxBackups` 控制（默认 20）。`恢复默认`会删掉存档并回到 profile 配置。
- **存档整份覆盖 profile**：面板会显示「配置来源（profile / store）」；要交还给 profile 配置就用「恢复默认」。
- **会话冻结（0.4.0 起，0.7.0 扩展到全部配置）**：写进实时配置后，已开始的会话继续用自己的快照，**新会话**才有新值。想让改动立刻作用于所有会话，把 `freeze.enabled` 设为 `false`（会击穿当前会话前缀缓存，不建议）。
- 请求体上限：`config` 8 KB、`tuning` 64 KB；非法 JSON 回 400，方法不符回 405。
- 路由跟随 DSH web 自身的访问控制，没有额外鉴权层；不要把 DSH 端口暴露到不可信网络。

### 验证

1. 重启 DSH（客户端包只在启动时加载；只热重载 host 半不会更新面板）。
2. 左侧栏出现 `Rice Guard`，三个页签都能打开；统计页切「今天 / 7 天 / 30 天」都有数。
3. 入口缺失时依次检查：当前是不是 web profile、`dsh.client.inject` 里四个包是否都在、插件是否在 profile 的 `bundles` 列表里。
4. 验会话冻结：开 A、B 两个会话；在 A 里改配置；A 的投影不变，B 的投影按新配置走。
5. 验落盘：重启后再看统计，30 天窗口不应归零；精调保存一项后重启，值仍在，备份列表里有上一份。
6. 验还原：精调页点某个备份的「还原」（二次确认）→ 生效配置回到该备份，当前配置先被自动备份。

## 配置

配置分七组（`truncation` / `visibility` / `ordering` / `freeze` / `storage` / `debug` / `pricing`），未知键丢弃，非法值回退默认，数字做区间 clamp。`normalizeConfig` **永不抛**：配置写错不会让 Harness 起不来。本插件**不导出 cordis `Config`**（校验失败 = 插件不启动，没有回退通道，见方案 §6.1）。

**每一项的完整说明（做什么 / 影响 / 默认值 / 推荐范围 / 风险 / 生效时机）都在面板「精调」页**，由 `src/config-meta.js` 单一维护；改配置前先看那里，本节只列默认值。

### `truncation`

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否在 `system-prompt/assemble` 时替换工具投影 |
| `shadowPrefixes` | `['mcp__']` | 只处理命中前缀的工具名；**空数组 = 处理全部**（旧语义） |
| `keepFull` | 8 个 `mcp__rea__*`（见下） | 永不瘦身的精确名单 |
| `minSchemaChars` | `700` | 小于此值的 schema 不动 |
| `maxSchemaChars` | `800` | 瘦身目标上限（JSON 字符数） |
| `maxDepth` | `3` | 超过此深度的对象坍缩 |
| `topDescriptionChars` | `140` | 第 0 层 description 上限（码点） |
| `nestedDescriptionChars` | `60` | 第 1 层起 description 上限（码点） |
| `descriptionDepth` | `1` | 保留 description 的最大深度 |
| `maxDescriptionChars` | `260` | 工具 description 上限（码点），`0` = 关闭 |
| `maxBranches` | `4` | 联合类型分支上限，仅在 `truncateUnions: true` 时生效（硬下限 2） |
| `truncateUnions` | `false` | `oneOf`/`anyOf`/`allOf` 截断，**默认关** |
| `dropAnnotations` | `true` | 丢弃 `examples` / `title` / `$comment` / `$schema` 等编辑期注解 |
| `dryRun` | `false` | **只统计不替换**：照常计算，但返回原始 tools（排序仍由 `ordering.enabled` 控制） |

`keepFull` 默认值：`mcp__rea__inspect_web_page`、`mcp__rea__list_names`、`mcp__rea__list_procedures`、`mcp__rea__procedure_pseudo_code`、`mcp__rea__procedure_assembly`、`mcp__rea__analyze_function`、`mcp__rea__search_procedures`、`mcp__rea__search_strings`。这 8 个名字来自上游作者环境的 rea MCP，只为兼容保留；它们同样命中 `mcp__` 前缀，但名字匹配即跳过，仍会被完整保留，本机不接 rea 时可以清空。

`shadowPrefixes` 默认 `['mcp__']`：未连接 MCP 时零命中；连接后自动对所有 MCP 工具生效；core 工具（`read` / `write` / `pwsh` 等，名字不以 `mcp__` 开头）不受影响。

过滤顺序固定：`keepFull` → 前缀匹配 → 处理。`shadowPrefixes` 是**大小写敏感的精确前缀**，不做通配/归一化/trim；`shadowPrefixes: []` 是公开的脚枪，会把基础工具也瘦身，建议用 `keepFull` 兜住关键工具。

### `visibility`

把命中的工具**从模型可见的工具列表里移除**（模型看不到、也调不到），`ctx.tools` 注册表与 `dispatch` 一律不动。默认关。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 是否在 `system-prompt/assemble` 时移除工具 |
| `dryRun` | `false` | 只统计不移除：记 `wouldHide` / `wouldHideBytes` |
| `exact` | `[]` | 精确工具名名单 |
| `prefixes` | `[]` | 名字前缀名单，**大小写敏感**的 `startsWith` |

- **`prefixes: []` 表示「不隐藏任何」**，与 `truncation.shadowPrefixes` 的「空数组 = 处理全部」**语义相反**：漏配不能变成误删。
- 优先级：`keepFull` > `exact` / `prefixes`（命中 `keepFull` 的工具永不隐藏）。
- 阶段顺序固定：**先消隐、再瘦身、后排序**；被消隐的工具不参与瘦身计算。
- 移除保序：剩余工具保持原顺序，`ordering` 只排对象键。
- **不可取回**：我们删掉的工具没有「取回」通道，模型真的调不到了。所以默认关、名单必须显式；第一次用建议先开 `dryRun` 看 `wouldHide`。
- **会改固定前缀**：开关一变，当前会话的缓存前缀就失效、需要重建。重建成本与会话长度成正比（一次 500k 上下文约 ¥0.49，而瘦身省下的每次仅约 ¥0.0002 热命中价），所以**不要在长会话里反复切**，名单最好在会话开始前定好（见 [竞品对比 §4.1/§4.2](<docs/design/竞品对比-上下文压缩三条路线-20261025.md>)）。

### `ordering`

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 整组开关（关掉即字节回到旧顺序） |
| `maxDepth` | `64` | 排序递归上限，超限原样返回（防环） |
| `verify` | `'length'` | 排序前后 `JSON.stringify` 长度自检；`'none'` 关闭 |
| `circuitBreaker` | `5` | **排序**连续失败达到后本进程内停机；`<= 0` 表示关闭熔断。熔断只停排序，不停瘦身 |

`verify: 'length'` 比较的是「已瘦身列表 → 排序后列表」：瘦身省下的字节是预期收益，不是排序吃键。

### `freeze`（会话冻结，0.4.0）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 运行期配置按 `context.agent.session.id` 快照：改动只影响之后的新会话；`false` 退回「切开关立刻生效」 |

快照在会话**第一次** `system-prompt/assemble` 时建立，之后同一会话一直用它；`context` 里没有 session id（单测、非 agent 调用）时走实时配置。快照只在进程内，插件重载后作废；超过 128 个会话按 LRU 淘汰，被淘汰的会话下次 assemble 会按当时的实时配置重新冻结。熔断（`ordering.circuitBreaker`）仍是进程级安全状态，不参与会话冻结。依据：投影改前缀会击穿前缀缓存（总纲 §10.20），会话中途换投影的重建成本远大于收益。

### `storage`（本地存档，0.7.0）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否持续写统计 JSONL 与自动备份；关闭后已有存档仍会加载，而「关闭」这一次保存本身仍会写盘（否则重启会自动开回来） |
| `maxBackups` | `20` | 精调自动备份保留份数；`0` = 不备份（不建议） |

数据目录固定 `$DSH_HOME/storages/dsh-rice-guard/`（`DSH_HOME` 默认 `~/.dsh`）：

```
config.json            精调存档（整份规范化配置，覆盖 profile）
backups/<id>.json      保存前快照（默认保留 20 份）
stats/YYYY-MM.jsonl    assemble 行（k: "a"，含会话 id、时间、字节/token 估算、瘦身计数）；usage 行（k: "u"，只含 provider usage 数字）；旧日志无 k 时按 assemble 处理
```

统计**只记数字，不记 prompt / 工具内容**；旧日志（`v=1`、无 `k`）继续可读。JSONL 是唯一事实源，启动时扫描最近两个月重建内存索引，重启不丢数。更早的月份文件不会自动删除。

### `debug`

| 键 | 默认 | 含义 |
|---|---|---|
| `logLevel` | `'warn'` | `warn` / `info` / `silent` |
| `logOnce` | `true` | 同一 `(reason, toolName)` 只记一次 |
| `maxLoggedTools` | `20` | 最多记录多少条去重后的工具级日志 |

### `pricing`（省钱估算，只影响展示）

| 键 | 默认 | 含义 |
|---|---|---|
| `model` | `'deepseek-flash'` | 官方在售模型；旧名（`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`）自动归并到 flash，`deepseek-v4-pro` 归并到 pro |
| `period` | `'off-peak'` | 面板默认高亮时段，`'off-peak'` 或 `'peak'`；**不参与任何自动判断** |
| `override` | `null` | 覆盖官方单价（元/百万 token），形如 `{ "hit": 0.02, "miss": 1, "out": 4 }`；三项都必须是有限非负数，否则回退官方值 |

价表本体在 `src/pricing-data.js`（官方页快照，当前 `asOf` 见 `PRICING_AS_OF`），**运行时零网络、零依赖**。官方调价时跑：

```bash
node scripts/update-pricing.mjs          # 抓官方页并重写快照（有变化才写）
node scripts/update-pricing.mjs --check  # 只比对，不写；有差异退出码 1
```

脚本会先写临时文件再 rename，解析失败时退出码 2、不写半份价表；改完需重启宿主。价格页解析逻辑改编自 `dsh-token-use`（MIT），见 `NOTICE.md` §3。

**四个口径并列**：峰时/谷时、缓存命中/未命中，各成一档；实际落哪一格取决于请求当时有没有命中缓存，由 provider 决定。所以 `inspect().pricing` 只给「价格与口径」，四个金额由面板按

```
金额 = 省下的 token × 对应单价 / 1e6
```

现算；`entry` 同时带 `off` / `peak` 两档。**仅预估，非实际账单**。本插件**不自动判断峰谷**：官方「不含中国法定节假日」的假日表在 `dsh-session-guard` 手里，我们不重复维护。

### 统计（`inspect()`）

`assemble` 每一步都会跑，所以「本次」与「累计」分开记：

- **本次 gauge**：`shadowed`（本次实际替换的投影数，`dryRun` 恒 0）、`wouldShadow`（`dryRun` 下本会替换的数量）、`skippedByPrefix` / `skippedByKeepFull` / `skippedBySize` / `skippedByInvalid`、`bytesBefore` / `bytesAfter` / `bytesSaved`、`wouldSaveBytes`、`collapsedNodesLast`、`rejectedBySelfcheckLast`；每次 assemble 前清零。
- **消隐 gauge**：`hidden`（本次移除数，`dryRun` 恒 0）、`wouldHide`（`dryRun` 下本会移除数）、`hiddenBytes`（本次从列表移掉的字节）、`wouldHideBytes`、`bytesAfterVisibility`（消隐后、瘦身前的列表长度）。字节账分三段：`bytesBefore − bytesAfterVisibility = hiddenBytes`，`bytesAfterVisibility − bytesAfter = bytesSaved`，两段相加才是列表总减少。
- **token 估算**（不是 provider 计费值）：`tokensBefore` / `tokensAfter` / `tokensSaved`，统一按 **4 个 UTF-16 单元/token 向下取整**；`tokensSaved` 是**消隐 + 瘦身的总净减少**，不是瘦身单项。
- **进程内累计**：`assembleCalls`、`toolsSeen`、`shadowedTotal`、`hiddenTotal`、`tokensSavedTotal`、`tokensBeforeTotal`、`tokensAfterTotal`（后两个用于算累计压缩率）、`skippedBy*Total`（含 `skippedByInvalidTotal`）、`collapsedNodes`、`rejectedBySelfcheck`、`canonicalFallbacks`、`protoKeysSeen`、`failed`、`lastError`。
- **会话冻结**：`sessionSnapshots`（累计建立过多少会话快照）、`frozenAssembles`（复用快照的 assemble 次数）、`sessionSnapshotsEvicted`（LRU 淘汰数）、`sessionsFrozen`（当前快照数，现场读）。
- **最小调用约束（0.6.0）**：`enumsKept` / `itemsKept` / `oversizeSlims`（本次）与 `enumsKeptTotal` / `itemsKeptTotal` / `oversizeSlimsTotal`（累计）——skeleton/collapse 保留的 enum/items 数量，以及「语义优先、允许超 `maxSchemaChars`」的瘦身次数。
- **价表快照**：`pricing = { status, asOf, source, currency, model, resolvedId, label, period, override, entry }`。`status` 为 `priced` / `unmatched` / `excluded`；`entry` 是 `{ hit: {off,peak}, miss: {off,peak}, out: {off,peak} }`（未定价时为 `null`）。**快照只给价格，不给金额**——金额由面板按「省下的 token × 单价 / 1e6」现算，避免宿主与前端两套算法漂移。
- **状态**：`circuitOpen`、`ledger`（最多 32 条的决策环形缓冲，最新在后；每条 `{ seq, tool, action, reason }`，同一 `(tool, reason)` 在窗口内只记一次；**只记异常与被保护原因**——隐藏命中、`keepFull`、`selfcheck`、`invalid`、`tool-error`；`prefix-miss` / `size` / `not-smaller` 这类常态跳过只进计数，避免一次 assemble 就把窗口刷满）。`ledger` 是排障用，不是统计口径；不落盘、重载清空。
- **口径提醒**：`bytesSaved` / `tokensSaved` 只覆盖本插件的工具投影作用面，**不可与其它插件的省流/省钱数字相加**。

`shadowed` 的语义与 v3 不同：v3 是「注册了几个 scope 覆盖版」，v4 是「本次 assemble 替换了几个工具投影」。后续 reporting 模块读这个字段时要按新语义。

### 扁平旧键兼容

为了从旧插件迁过来时不用重写配置，顶层出现 `shadowPrefixes`、`keepFull`、`minSchemaChars` / `minChars`、`maxSchemaChars`、`maxDepth`、`topDescriptionChars`、`nestedDescriptionChars`、`descriptionDepth`、`maxDescriptionChars`、`maxBranches`、`truncateUnions`、`dropAnnotations`、`dryRun` 时会映射进 `truncation.*`；顶层 `canonicalizeTools: false` 映射成 `ordering.enabled: false`；顶层 `visibilityEnabled` / `hiddenExact` / `hiddenPrefixes` 映射进 `visibility.*`。分组配置优先。

## 与其它插件共存

本插件只改**工具定义投影**（固定前缀），不改消息、不改工具结果、不改注册表；因此与「只观测」和「按需工具化」的插件天然共存，与「自动改写已发送历史的压缩器」在保前缀目标上互斥，或需要配 `prefixPolicy: preserve` 并关闭历史改写（[竞品对比 §1、§4.3、§6](<docs/design/竞品对比-上下文压缩三条路线-20261025.md>)）。

| 插件 | 它做什么 | 和我们什么关系 | 怎么配 |
|---|---|---|---|
| `dsh-context` | 主要做上下文观测；但不是纯只读，还会注入 section、补消息 id、包装工具注册方法 | 观测搭档，不挂 assemble；分类估算不是我们的精确收益，id 是否进入请求未验证 | 前后缀留空或配一次后固定；它写派生缓存并外发余额，介意就别用（竞品对比 §2.1、§4.6、§6、§7） |
| `dsh-context-compression-improved` | 压工具结果；Fresh/Aggregate 处理新结果，History/TailTrim 改已发送历史 | 分层互补但历史改写会破坏共同前缀；不争 assemble 钩子 | 锁 `prefixPolicy: preserve`，关 History/TailTrim，只留 Fresh/Aggregate（竞品对比 §2.2、§4.3、§6） |
| `dsh-context-lens`（`@goodandready/dsh-context-lens`） | 通过工具按需取代码骨架、聚焦内容与压日志，不自动改历史 | 几乎无冲突、弱互补，净效果未实测；默认 `mcp__` 前缀不命中它 | 两个工具用 `keepFull` 兜住，尤其扩大处理前缀范围时（竞品对比 §2.3、§6） |

**为什么**：缓存重建成本与需要重建的会话上下文长度成正比；相比只盯「一次改多少」，更要警惕**改前缀的频率**。一次性、大块、持续生效的压缩可能回本，频繁小改却不断付重建费——贵的是「压缩频率 × 重建规模」，不是压缩本身（[竞品对比 §4.2](<docs/design/竞品对比-上下文压缩三条路线-20261025.md>)）。本插件的开关也别在长会话里来回点。

**不要**把本插件的「省字节」与其它插件的「省 token／省钱」相加：单位、作用面与统计基线不同，不做全局省流合计（[竞品对比 §4.4、§4.8](<docs/design/竞品对比-上下文压缩三条路线-20261025.md>)）。

逐家审计与证据见 [竞品审计](<docs/design/竞品审计/>) 与 [竞品对比：上下文压缩三条路线](<docs/design/竞品对比-上下文压缩三条路线-20261025.md>)。

## 已知限制

本模块明确不做（方案 §4.7，照抄）：

- 不碰 `cwd`、不碰 `{{cwd}}`、不改 `deployment:persona-*` 任何 section。
- 不新增任何 prompt 变量占位符。【事实】0.2.1-rc.2 只注册了 `provider` 和 `model`，任何未注册的 `{{...}}` 会让 assemble 直接抛错。
- 不改 `sections` / `contexts` / `variables`。
- 不做工具级排序（core 已做；再排会与 `toolOrder` 配置打架）。
- 不在 `llm/stream` 上挂任何东西。
- 本模块不注册任何新工具（旧插件的 `cache_saver_status` 属于后续 reporting 模块）。
- 不改工具注册表：不调用 `tools.schemas/get/register`，不持有工具定义，`dispatch` 完全不受影响。

`tools/change`（方案 §6.12，照抄）：

- `tools/change` 是未过滤的 emit 事件，注册/注销/作用域限制变化都会触发。v4 不订阅。
- 本模块不在任何 scope 里注册副本，所以不存在「工具注销后仍能看到/调用残留副本」的问题。

另外几条实现层限制（方案 §3.1 / §3.2.3）：

- **模型看到瘦身 schema，执行期仍用完整 schema**：模型可能生成「瘦身版允许、完整版拒绝」的参数（尤其坍缩后的对象），表现为工具调用失败，不是请求 400。这是所有「改 schema 投影」方案的固有代价；关键工具请用 `keepFull` 兜住。
- **码点安全 ≠ 字素安全**：ZWJ emoji 序列（`👨‍👩‍👧`）、印度语连字、变音符组合仍可能在中间被切开。v4 默认按码点，`grapheme` 只留扩展点、不实现。
- **深度坍缩有已知语义风险**：把带 `required` 的对象压成 `{ type: 'object', additionalProperties: true }`，严格 provider 端可能不认，表现为一次 400。保留旧行为（未实测前不改），`collapsedNodes` 进统计，作为以后切 stub 的触发信号。
- **不保证不动点**：截断函数不是 `f(f(x)) = f(x)`，不加「已截断」标记或特征检测。每次 assemble 拿到的都是 core 新 clone 的原始投影，不会把自己的输出再喂给自己。
- **确定性是硬要求**：同一输入两次运行输出字节必须一致（不读时间/随机/locale，不缓存，不重排数组，只排对象键）。
- **每次 assemble 都现算，不缓存**：core 每次都 `structuredClone` 一份新的 `parameters`，对象身份每次都变，按身份缓存命中率为 0；按内容哈希缓存会引入内存增长和「旧 schema 残留」风险，v4 明确不做。
- **消隐不可取回**：`visibility` 移掉的工具，模型调不到，也没有「取回」工具（不像压缩类插件可以用 retrieve 找回原文）。误删的代价是能力缺失，不是上下文变脏；名单必须显式，先开 `dryRun`。
- **`selfcheck` 不校验 `enum` 非空**：它只保证形状与 JSON 合法性，不判断 schema 是否可满足；`enum: []` 这类输入不会被拦（本模块也不会主动造出空 `enum`）。
- **最小调用约束优先于预算（0.6.0）**：`skeleton` / `collapse` 不再静默丢 `enum` / `items`——保留枚举全集、数组元素类型/枚举、对象元素一层字段与 `required`。代价是候选可能超过 `maxSchemaChars`（该值本来就不是硬上限），这类「语义优先、超预算」的瘦身计入 `oversizeSlims`；`$ref` / 组合分支 / 深层对象字段仍不做猜测式重写。
- **会话冻结是进程内快照**：插件重载后全部作废，会话按当时的实时配置重新冻结；超过 128 个会话按 LRU 淘汰，被淘汰的会话下次 assemble 会重新快照（可能拿到新配置）。没有按会话查询投影的接口。
- **冻结覆盖全部配置（0.7.0 起）**：精调保存的任意配置（含投影名单 `exact` / `prefixes` / `shadowPrefixes` / `keepFull`）都只影响新会话；`freeze.enabled`、`pricing`、`debug`、`storage` 例外，是进程级/实时值。
- **统计是估算口径**：token = `floor(bytes / 4)`，不是 provider 实报；窗口金额 = 「省下的 token × 当前价表」，历史记录不保存当时价格，所以不是账单差额。
- usage 通道只读 `assistant/message.usage` 的数字，不含 prompt 内容；标题生成等辅助 LLM 调用没有 usage，不计入。
- 「工具定义占比」只统计配到 assemble 的请求；估算口径仍是 tools 投影，不是整份 prompt。
- **统计只从 0.7.0 起算**：升级前没有会话归属的历史不会回填；面板的窗口从新版本第一次记录开始累积。
- **落盘失败不阻断投影**：只读盘/沙箱下统计与存档会失败，插件照常工作；`storage.error` 会显示原因，最坏结果是重启后统计归零、精调值丢失。
- **子代理单独成条对话**：每个 session 独立统计，暂不汇总到父会话。

## 迁移：先禁用旧插件

1. 在 profile 的 patch 里给两个旧插件加 `disabled: true`：
   - `@local/dsh-cache-saver`
   - `dsh-cache-stabilizer`
2. 插入本 bundle（`cordis.patch.yml` 已写好）。
3. 跑顺 2–3 天，确认行为对齐。
4. 再从 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉两个旧插件。

**任何时候都不允许「旧 cache-saver + 本插件」同时启用**：旧插件走 `agent/created` + scope 注册路径（在当前 DSH 版本上多半已失效；一旦某个版本生效，同一份 schema 会被瘦两次），本插件走 `system-prompt/assemble` 投影。两条瘦身来源同时存在比 v3 的注册冲突更隐蔽。禁用一个字段就能立刻回滚。

## 测试

本机没有独立 node，用 Electron 当 Node；必须带 `--test-isolation=none`（否则测试运行器为每个文件 spawn 子进程，在沙箱下直接 `spawn EPERM`）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\DSH\DeepSeek Harness.exe' --test --test-isolation=none 'test/*.test.mjs'
```

本机 `node` 不在 PATH，用 profile 运行时里的 `node.exe`；必须带 `--test-isolation=none`（否则测试运行器为每个文件 spawn 子进程，在沙箱下直接 `spawn EPERM`）：

```powershell
& 'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' `
  --test --test-isolation=none 'test/*.test.mjs'
```

0.8.0 新增 `test/usage.test.mjs`；当前 198 项（196 通过 / 2 skip / 0 失败）。注意：本机 Node 24.21 下传**目录**会 `ERR_UNSUPPORTED_DIR_IMPORT`，请用 glob 或省略参数（默认发现）。`npm test` 脚本在装有 node 的机器上可直接跑：

```bash
npm test
```

单元测试不需要启动 Harness：除 `src/index.js` / 两个 store 用 `node:fs` 落盘外，纯函数模块不 import 任何 DSH 包；两条 store 测试都用临时目录，不碰真实 `$DSH_HOME`。

## Credits / 致谢

本模块的行为源自两个 MIT 许可的前身插件，属于重新实现，不是逐行复制：

- [`dsh-cache-saver`](https://github.com/ium9khbep8834-maker/dsh-cache-saver) — MIT，Copyright (c) 2026 dsh-cache-saver contributors。截断/瘦身的默认参数、JSON Schema 关键字分类、按码点截断与边界策略沿用其行为。
- [`dsh-cache-stabilizer`](https://github.com/dongsheng123132/dsh-cache-stabilizer) — MIT，Copyright (c) 2026 hfshfg。键排序语义、数组保序、长度自检与熔断沿用其行为。

沿用了什么、改了什么、以及两家的 MIT 许可证原文，见 [NOTICE.md](NOTICE.md)。
