# Runtime 模块解耦与规模性能基线（dev · R2）

2026-11-28。本阶段（R2）围绕维护流程拆分了原 906 行单文件 `plugin/runtime.js`，保留全部公开 API、准入边界、共享 cell/ABI 2 与恢复证明等价性；同时建立了可复现的规模性能基准与 CI 检查。包版本仍为 0.1.1（dev 分支）。

## 四层模块边界

| 模块 | 职责 | 依赖方向 |
|---|---|---|
| [plugin/gate-driver.js](../plugin/gate-driver.js) | Agent-owned 闸门安装、ABI 1→2 升级、系统提示/pre-step/tools/llm 拦截与维护屏障检查 | 依赖 `context.js`、`messages.js`、`compaction.js`、`runtime-cells.js` |
| [plugin/conversation-session.js](../plugin/conversation-session.js) | 单 conversation 回合状态机（`ConversationSession`）、版本化 `conversation` 身份描述符、原生事件观察、输入确认/停放与审计结算 | 依赖 `workers.js`、`redact.js`、`messages.js`、`context-checkpoint.js`、`compaction.js` |
| [plugin/bot-coordinator.js](../plugin/bot-coordinator.js) | Bot 级维护屏障（`acquireBarrier` / `isBlocked` / `drainAll`）、`botId -> (conversationKey -> sessionId)` 映射登记，以及两阶段注销协调（`prepareRemoval`） | 依赖 `@deepseek-ai/dsh-session-persistence` |
| [plugin/mailbox-facade.js](../plugin/mailbox-facade.js) | 可信 Host 的 `ownerMailbox` 门面（继续保持 `owner-private` 单所有者主 Session 准入约束；多对话域开放留在 P1 阶段 3） | 依赖 `messages.js`、`receipts.js` |
| [plugin/runtime.js](../plugin/runtime.js) | Cordis `MBotRuntime` 服务门面（约 375 行）：装配上述四层、管理 Worker/恢复句柄与对外 API | 协调上述模块 |

- 身份边界显式区分：Host `botId`、会话内 `conversation` 描述符（`{ schemaVersion: 1, botId, conversationKey, visibility, sessionId }`）与原生 `sessionId`，为后续 P1 阶段 3 多对话域和 P3.1 便携主体身份预留版本化扩展点，不改变现有单所有者私人主对话的准入约束。
- 维护屏障通过 `BotCoordinator.acquireBarrier(botId, kind)` 统一协调，屏障期间 `status()` 报告 `maintaining`、`requireState()` 与 `admit()` 拒绝新业务执行而原生 Inbox 保留输入，供 R3（手动 compact）与 R4（sleep/wake）直接复用。

## 可复现规模基线（`npm run bench:runtime`）

基准脚本见 [tests/bench-runtime.mjs](../tests/bench-runtime.mjs)（`--quick` 供 CI 冒烟，完整运行测 100/300/1000 轮）。以下为 2026-11-28 在 Linux / Node v22.23.2 本机实测基线（父进程峰值 RSS 63.8 MiB）：

### 1. Context Checkpoint 恢复（`bin/context-checkpoint.mjs --restore`）

| 历史轮数 | 原生事件数 | stdin JSON 字节 | stdout JSON 字节 | R2 基线耗时 (ms) | R5 优化后耗时 (ms) | 加速比 |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 400 | 196,394 | 10,429 | 3,882.14 | 96.90 | 40.1x |
| 300 | 1,200 | 591,094 | 27,682 | 11,967.93 | 242.36 | 49.4x |
| 1,000 | 4,000 | 1,975,699 | 88,584 | 45,481.85 | 1,054.98 | 43.1x |

**优化说明（R5）**：将逐轮 `git show`/`git rev-parse`/`jq` 子进程收敛为单次 `git log` + 常驻 `git cat-file --batch` 管道、单趟事件按 turn 建索引及等价进程内 `computeManagedOutcome`（完整校验语义与 `lib/turn-outcome.jq` 保持一致），1000 轮全量恢复由 ~45.5s 降至 ~1.05s（父进程峰值 RSS 72.3 MiB），且未减弱任何密码学或链式证明核验。

### 2. Worker `actor-event` 记录（`bin/turn-actor.mjs`）

| 事件数 | 子进程次数 | R2 基线总耗时 (ms) | R2 单事件 (ms) | R5 优化总耗时 (ms) | R5 单事件 (ms) | 事件文件字节 |
|---:|---:|---:|---:|---:|---:|---:|
| 25 | 25 | 934.91 | 37.40 | 739.30 | 29.57 | 2,071 |
| 100 | 100 | 3,789.66 | 37.90 | 2,979.50 | 29.80 | 8,372 |

**优化说明（R5）**：`actor-event` 顺序追加时改为直接计数校验连续 `seq` 并 `append+fsync`，消除每条事件的 `O(E^2)` 全量 JSON 解析与双 ledger 重写；完整 `workerProof` 与双 ledger 落盘集中在 `actor-seal`/`delegate`/`revoke`。

### 3. Guard Ignored 文件快照（`lib/guard.sh mbot_guard_snapshot`）

| Ignored 体积 (MiB) | 文件数 | 快照耗时 (ms) |
|---:|---:|---:|
| 1 | 1 | 8.97 |
| 10 | 10 | 31.72 |
| 50 | 50 | 132.48 |

**瓶颈定位**：快照时间随历史 `.mbot/runs/*.jsonl` 累积体积线性增长（50 MiB 约 132ms），后续长期运行至数百 MiB 时应在 R5 引入按月归档冷目录或不可变 manifest（inode/size/sha256）校验。

## CI 与验证

- 新增 CI 模板 [ops/ci.yml.example](../ops/ci.yml.example)（复制到 `.github/workflows/ci.yml` 即可启用；当前远端 PAT 无 `workflow` scope，故作为运维模板随仓库维护）：在 Node 22 上运行 `check:types`、`bash tests/run.sh`、串行 `plugin.test.js` + `runtime.test.js`、`npm pack` 产物审查与 `bench-runtime.mjs --quick`。
- 合成基准用于定位热点，不替代完整审计路径、四类安装与真实浏览器验收。
