# 发布待办（RELEASE-TODO）

> **状态：暂缓。** 老板决定「整体实现完成后再上传」，当前不上 git、不改目录名、不改工作区。
> 记录日期：2026-10-24

## 一、现状

| 项 | 状态 |
|---|---|
| 项目位置 | `C:\MyDrive\DSH\workspace\dsh-rice-guard`（留在工作台 `workspace` 内，不搬） |
| Git | **未安装**（PATH 与常见安装路径均无）；本项目未 `git init` |
| package.json | 有 `files` 白名单；**无 `private` 字段**（可发布）；缺 `license` / `repository` / `keywords` / `author` |
| DSH 引用 | profile 通过 `link:C:/MyDrive/DSH/workspace/dsh-rice-guard` 加载本项目 |
| 工作区 title | 曾改成 `dsh-rice-guard`，但物理目录仍是 `workspace`（建议改回 `workspace`，避免以后自己混淆） |

## 二、发布前清单（整体实现完成后按序执行）

1. **安装 Git**
   - `winget install Git.Git`（需要管理员/UAC）
   - 或便携版 MinGit 解压到 `C:\MyDrive\DSH\.tools\git`（无需管理员），再把该目录加入使用时的 PATH
2. **`git init`** + 写 `.gitignore`：`node_modules/`、`.artifacts/`、`*.log`
3. **补 package.json 元数据**：`license`、`repository`、`keywords`、`author`、`homepage`
4. **`npm pack --dry-run` 验证包内容**
   - `files` 已限定为 `src / cordis.patch.yml / README.md / NOTICE.md`，不会带上工作台里的缓存
5. 首次提交 → 建远程仓库 → push
6. （可选）发布到 npm

## 三、改名 / 拆分清单（同样放在最后做）

如果最终想把项目移出工作台（`workspace\dsh-rice-guard` → `C:\MyDrive\DSH\dsh-rice-guard`）：

1. 关闭 DSH
2. 备份 `~/.dsh/storages/workspace.json`
3. 移动目录
4. 改 profile `package.json` 里的 link 路径
5. 在 profile 目录跑 `pnpm install`
6. 重启 DSH，确认插件仍正常加载
7. 若连工作区一起改名：改 `workspace.json` 的 `path`，并重命名 `~/.dsh/sessions/--C-MyDrive-DSH-workspace--` 目录

> **提醒：这一步的成本不会随时间降低，只会升高**——越往后，引用点越多（MCP 路径、会话 slug、其它配置），所以做的时候要按清单逐条核对，别凭印象。

## 四、项目边界（防止将来误提交）

**属于本项目（进仓库）**：`src/`、`test/`、`package.json`、`cordis.patch.yml`、`README.md`、`NOTICE.md`

**不属于本项目（不要进仓库）**：同级的 `.pnpm-store`（42MB）、`.mcp`（4MB）、`.pylib`（2MB）、`fetched`、`_audit`、`_backup`、`dsh-flash-presets`、`dsh-mcp-client-官方包`

**已归位**：设计文档与实施总纲已并入 `docs/design/`（cache-pipeline / peak-scheduler / rate-limiter / spend-guard / tool-budget / ui-manager / 实施总纲），随项目进仓库。注意 `docs/design/` 目前不在 `files` 白名单内，不会随 npm 包发布——这是预期行为。

## 五、决策记录

- **2026-10-25**：P1 spend-guard / P2 peak-scheduler 取消自研，改为直接使用 `dsh-session-guard` / `dsh-cost-meter`（见总纲 v1.5）；这两个插件属外部依赖，**不进本项目仓库**。项目实际路径已是 `C:\MyDrive\DSH\dsh-rice-guard`，本文件里的旧 `workspace` 路径仅作历史。
