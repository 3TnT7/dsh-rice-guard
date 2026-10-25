# NOTICE — 上游署名与许可证

`dsh-rice-guard` 的 `cache-pipeline` 模块在**行为上**源自下面两个 MIT 许可的 DSH 插件。
没有逐行复制它们的代码：`src/cache-pipeline/truncate.js`、`slim.js`、`canonical.js`
是重新实现的，算法选择、默认值、关键字分类与失败策略沿用了它们的行为，并在本仓库做了
记录在案的修改。版权行按原文照抄。

---

## 1. dsh-cache-saver

- 项目：`dsh-cache-saver`（迁移前在 profile 中以 `@local/dsh-cache-saver@0.3.1` 运行）
- 仓库：https://github.com/ium9khbep8834-maker/dsh-cache-saver
- 许可证：MIT
- 版权行（原文）：

  ```text
  Copyright (c) 2026 dsh-cache-saver contributors
  ```

### 我们沿用的行为

- 工具 `description` 的按码点截断：句子/换行边界优先、边界最小保留比例、` …` 软后缀、
  首尾空白 trim。
- `parameters` 瘦身的默认参数：`minSchemaChars: 700`、`maxSchemaChars: 800`、
  `maxDepth: 3`、`topDescriptionChars: 140`、`nestedDescriptionChars: 60`、
  `descriptionDepth: 1`、`maxDescriptionChars: 260`、`maxBranches: 4`、
  `dropAnnotations: true`。
- JSON Schema 关键字分类：`properties` / `$defs` / `patternProperties` 等映射，
  `items` / `additionalProperties` 等单 schema，`oneOf` / `anyOf` / `allOf` 联合，
  `prefixItems` 元组，以及 `required` 修剪与注解丢弃。
- 预算循环（从高到低试深度，取第一个满足 `maxSchemaChars` 的候选）与
  顶层名字/类型 skeleton 兜底；「只有严格更小且 `selfcheck` 通过才采用」的拒绝策略。
- 过滤默认值与语义：`shadowPrefixes: ['mcp__rea__']`、8 个 `keepFull` 名字、
  空数组 = 处理全部、`keepFull` 优先于前缀。

### 我们改了什么

- **落点**：从 `agent/created` + 工具注册表覆盖，改到 `system-prompt/assemble`
  的模型可见投影（host 级插件看不到模型实际使用的 36 个工具，注册式路径不可行）。
- **联合类型默认不截断**：`truncateUnions` 默认 `false`（旧行为截到 4 个分支），
  理由见 README 与《cache-pipeline 整合实现方案》§6.2；`prefixItems` 永不截断。
- **长度自检基线**：从「原始列表 → 排序后列表」改为「已瘦身列表 → 排序后列表」，
  避免把瘦身收益误判成排序吃键。
- **失败策略**：阶段 A/B 各自隔离；排序失败保留瘦身结果；熔断只停排序。
- **`__proto__`**：用 `Object.defineProperty` 写成普通对象上的自有数据属性，
  不产出无原型对象。
- **统计与 `dryRun`**：改为按 assemble 的 gauge + 累计字段；`dryRun` 只统计不替换。
- **删除**：per-agent scope 注册、激活时补扫、`dispose`、状态工具与 Web/UI 设置页。

### MIT License（原文）

```text
MIT License

Copyright (c) 2026 dsh-cache-saver contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. dsh-cache-stabilizer

- 项目：`dsh-cache-stabilizer`（迁移前在 profile 中以 `dsh-cache-stabilizer@0.1.1` 运行）
- 仓库：https://github.com/dongsheng123132/dsh-cache-stabilizer
- 许可证：MIT
- 版权行（原文）：

  ```text
  Copyright (c) 2026 hfshfg
  ```

### 我们沿用的行为

- 在 `system-prompt/assemble` 之后递归排序对象键，让同一份工具 schema 逐字节稳定。
- 只排对象键；数组（`required` / `enum` / `oneOf` / `prefixItems`）保持源顺序。
- 默认 `maxDepth: 64`、`verify: 'length'`（排序前后序列化长度自检）、
  `circuitBreaker: 5`。
- 自检失败不采用排序结果并计入失败；连续失败后本进程内停用排序。
- `__proto__` 作为数据键保留，不触发原型 setter。

### 我们改了什么

- 排序对象从「注册表里的工具定义」改为「assembly 的工具投影」；不再有 per-agent
  scope 状态与 `/cache` 命令。
- 长度自检基线改为「已瘦身列表 → 排序后列表」；失败时保留瘦身结果，不退回原始列表。
- 熔断只停排序，不停瘦身。
- `__proto__` 用 `Object.defineProperty` 建成自有数据属性；非 plain object
  （Date/Map/class 实例）原样返回。
- 不再迁移 `cwd` 句子：本模块不碰 `cwd` / `{{cwd}}`（旧插件的 cwd 搬迁在当前 DSH
  上不会触发，也超出本模块职责）。

### MIT License（原文）

```text
MIT License

Copyright (c) 2026 hfshfg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. dsh-token-use

- 项目：`dsh-token-use@0.3.4`（本机 profile 中曾安装，2026-10-25 起由用户禁用/准备卸载）
- 仓库：https://github.com/huangyuheng/dsh-token-use
- 许可证：MIT
- 版权行（原文）：

  ```text
  Copyright (c) 2026 huangyuheng
  ```

### 我们沿用的行为

- 官方定价页的**读取与解析思路**：抓 `api-docs.deepseek.com` 定价页 → 取第一张 `<table>` →
  按 `rowspan` 语义继承「缓存命中 / 缓存未命中 / 输出」字段名 → 按「空闲时段 / 高峰时段」
  分档 → 每行取最后 N 列作为各模型价格（`src/pricing.js` 的 `parsePricingDocument`）。
- 峰谷时段从页面文字解析（北京时间 → UTC 换算），以及「按模型家族词（去掉版本号与
  `deepseek` 前缀）宽松匹配官方条目」的思路（`resolveModel`）。
- 价格页 URL 与「空闲时段 = 高峰价一半」的口径。

### 我们改了什么

- **只在维护脚本里联网**：抓取逻辑放在 `scripts/update-pricing.mjs`（手动运行），
  插件运行时只读生成的 `src/pricing-data.js` 快照；原实现是宿主内每日后台抓取。
- 解析器改为**永不抛**：结构不符返回 `null`（原实现抛错），脚本据此退出码 2、不写半份文件。
- 去掉快照历史 / 磁盘缓存 / 每日定时器 / USD 双语自动判断（只保留 CNY 页，币种可显式传参）。
- 峰谷解析改为「遍历所有含『高峰时段』的句子，取第一句真正带时间区间的」——官方页的
  价格表里也出现「高峰时段」但没有时间，原正则会先命中表内那句。
- 省钱口径重写：本插件只算「省下的 token × 官价」，返回**峰/谷 × 命中/未命中四个数**，
  并明确标注「估算，不是账单」；不实现「按 usage 反推费用」的完整计价。

### MIT License（原文）

```text
MIT License

Copyright (c) 2026 huangyuheng

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

上述三节只覆盖被沿用行为的上游项目；本仓库的修改由本仓库维护者负责。

---

## 4. 仅致谢「思路来源」的项目（未复制代码）

下面几个项目我们**没有复制任何代码**，只在设计与文档里借鉴了思路；按《实施总纲》§6.3
的约定不做代码级署名，只在此致谢（节选自查证过的公开仓库）：

| 项目 | 我们借了什么 | 备注 |
|---|---|---|
| [LarryE135/dsh-flash-presets](https://github.com/LarryE135/dsh-flash-presets) | 「显式移除工具」这一工具可见性思路（落在 cache-pipeline 的 `visibility`，独立实现） | 纯数据包，无运行时代码可复制 |
| [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) | 上下文占用「量尺」与来源标注的展示思路（本项目未采用其派生缓存/余额外发） | 未安装、未依赖 |
| [drscrewdriver/dsh-context-compression-improved](https://github.com/drscrewdriver/dsh-context-compression-improved) | 前缀策略、会话冻结、分口径统计、决策留痕的概念 | 未安装、未依赖 |
| [GooDAnDReaDY/dsh-context-lens](https://github.com/GooDAnDReaDY/dsh-context-lens) | 「预防优于压缩」「按需工具化」的取舍判断 | 未安装、未依赖 |

> 若上述作者认为此处署名方式不妥，请告知调整；本表不构成对代码来源的声明。
