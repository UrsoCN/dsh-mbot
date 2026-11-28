# 睡眠、唤醒与最小管理面板

当前基线 `0.2.0-rc.1`。本说明记录 R4 交付的受控 `sleep` / `wake` 维护闭环、只读 `overview` / `effectiveConfig` 视图与 DSH 最小管理面板。前置基础见 [持久恢复证据](durable-recovery.md)、[Runtime 架构与基线](runtime-architecture.md) 与 [自动与手动摘要](managed-compaction.md)。

## 1. 分阶段 Sleep 生命周期

调用 `runtime.sleep(botId, options)`、`/mbot sleep [botId]` 或 `botctl sleep --profile NAME --bot ID [--skip-dream] [--compact]` 时，Host 按固定阶段执行：

1. **Bot 级维护屏障**：通过 `BotCoordinator.acquireBarrier(botId, 'sleep')` 核实当前前台回合与受管写者已静止，再阻止新回合执行模型或打开事务；当前遇到活动回合会返回 busy，应先 stop/等待收尾。若存在未结算 turn journal 或 `.mbot/PAUSED`，拒绝进入睡眠并要求先修复/恢复。
2. **固定历史 cutoff（不阻断原生收信）**：刷新（flush）主 Session 并在阶段 journal 中记录 `cutoffHead`（当前 Git `HEAD`）、`beforeKnowledgeVersion` 与各 conversation 的 `throughSeq`；在此期间与整个睡眠期间，DSH 原生 Inbox 继续接收外部与多窗口消息（不会丢失或伪造第二套队列）。
3. **持久阶段 journal**：写入 `<stateRoot>/maintenance/<workspaceHash>/current.json`（`0600`、原子替换 + `fsync`、绑定 `ownerPid`/`ownerStart`/`bootId`），`kind: 'sleep'`，阶段依次推进 `dreaming` → `checkpointing` → `sleeping`。
4. **独立 Dreaming**：除非显式传入 `skipDream: true`（测试/离线模式），否则在维护屏障下执行 `mbot dream`（由 `mbot dream` 持自身 Bot 数据锁完成候选整理与 Git 提交）。若 Dreaming 失败，不推进知识 epoch、不进入 `sleeping`，保留失败审计并清理阶段 journal。
5. **可选 compact 与 checkpoint 刷新**：若传入 `compact: true` 且该 Session 已装配原生 `compaction`，在 Bot 数据锁与维护许可下执行受管摘要并 flush；随后调用 `restoreContext` 对齐最新 `knowledgeVersion`。
6. **发布持久睡眠态**：将维护 journal 原子推进至 `phase: 'sleeping'` 并在 `BotCoordinator` 标记 `sleeping`。此时 `runtime.status(agent).state === 'sleeping'`；新到达的原生消息停留在 Inbox，不会被模型消费。Host 重启或 Runtime 重新附加该 Bot 时，会从持久 journal 恢复 `sleeping` 状态，不会意外唤醒。

## 2. Wake 与未闭合睡眠恢复

- **Wake（`runtime.wake(botId)` / `/mbot wake` / `botctl wake`）**：
  - 若存在未完成（`phase !== 'sleeping'`）的维护 journal，拒绝唤醒并要求先执行 `/mbot recover`。
  - 清除 `sleeping` 持久标记与内存阻断态，**严格沿用原 `mainSessionId`**（通过 `sessionController.resolveAgent` 解析已有 Agent，绝不新建替代 Session），刷新 context checkpoint 并返回当前 `head`、`knowledgeVersion` 与保留在原生 Inbox 中的 `queued` 数量。
- **冷恢复（`recoverSleepMaintenance`，集成于 `/mbot recover` / `coordinateRecovery`）**：
  - 当睡眠在 `dreaming` 或 `checkpointing` 阶段中断且原 Host 已退出（通过 `bootId` + PID 出生身份核验）时，获取维护屏障与 Bot 数据锁；
  - 检查 `currentHead` 是否已包含 `dreamCommit` 或已从 `cutoffHead` 前进（`dreamAlreadyCommitted`）；**Git 提交已落地时绝不重复执行 Dreaming**，仅完成原生 Session flush 与 `restoreContext` 同步并清理维护 journal。

## 3. 只读 Overview 与 EffectiveConfig

- `runtime.overview()`、`/mbot overview` 与 `botctl overview --profile NAME` 返回所有已登记与退役 Bot 的聚合只读快照：
  - `botId`、`name`、`role`、`workspacePath`、`workspaceExists`、`mainSessionId`、`bindingState`、`bindingError`、`needsRepair`
  - `runtimeState`（含 `sleeping`/`maintaining`/`cold`）、`queued`（`nextTurn`/`nextStep`）、`paused`、`failures`、`head`、`knowledgeVersion`、`hasTurnJournal`、`maintenancePhase`
  - `board`（`todo`/`doing`/`blocked`/`done` 计数）、`memory`（行数/字符数）与 `budgets`（对照 `.mbot/config` 上限）
  - `effectiveConfig`：按来源标注（`env` / `workspace-config` / `cordis` / `default`）的配置视图；凭据仅以 `credentialRefs` 引用及 `[REDACTED]` 掩码返回，不暴露明文 key。

## 4. 最小管理面板（`plugin/client.js`）

- 保留 lazy-CJS 工厂格式（无构建步骤、兼容 headless Host，Host 永不导入 `client.js`），通过官方 `plugins.bundle.config` 槽位（`key: 'dsh-mbot'`）与 `ctx.configForms.get('mbot')` / `ctx.configForms.get('mbot-runtime')` 挂载在 DSH Plugins 页面内。
- 展示：
  - 活跃 Bot 实例列表、选中标记、数据目录、默认角色、主 Session ID、绑定健康/错误状态及一键「打开主会话」按钮（经 `uiWorkspace.openSession` 导航）；
  - Runtime 当前配置（`workers`、`compactMaxBytes`）与控制命令提示（`/mbot overview`、`/mbot sleep`、`/mbot wake`、`/mbot repair`、`/mbot recover`）；
  - 独立的已退役 Bot 列表。
- 完整的可编辑配置表单、跨层（Plugin Config / `.mbot/config` / DSH 实体）原子保存、并发编辑冲突与卸载全流程验收仍归属 P2。
