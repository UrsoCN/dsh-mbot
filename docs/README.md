# 模块文档索引

当前基线为 `0.2.0-rc.1`。根目录 [README](../README.md) 面向操作，[DESIGN](../DESIGN.md) 维护架构与规划大纲，[TODO](../TODO.md) 只列执行事务，[PLUGIN](../PLUGIN.md) 维护集成/验证，[RELEASE_NOTE](../RELEASE_NOTE.md) 按版本记录交付。

## 数据、记忆与运维

| 文档 | 范围 |
|---|---|
| [headless 工作流](headless.md) | 独立 run、数据工具、Chief/Worker 调度、tick/归档与 grants |
| [记忆与 Dreaming](memory.md) | 长期记忆归属、预算、候选、增量续读与回滚 |
| [运维](operations.md) | cron、备份、clone 恢复、人工观察及长期验收 |
| [插件发布检查](plugin-standard-review.md) | 包、版本/标签、兼容矩阵和 CI |

## Bot 与主 Session

| 文档 | 范围 |
|---|---|
| [Bot 实例](bot-instances.md) | profile 登记、身份/revision、目录选择与导入 |
| [主 Session](main-session.md) | 官方实体、预留、创建/修复、导航及多窗口 |
| [conversation 身份与来源权限](conversations.md) | 开发分支 registry v3、域预留、显式资料视图、内部 v4 只读/v5 候选事务、域 mailbox、原生上下文与执行拒绝边界 |
| [注销与退役](bot-removal.md) | 活动登记/退役快照、旧 Session 闸门与数据保留 |
| [Session Runtime 设计](session-runtime.md) | conversation、可见域和统一入口的详细目标契约，区分现状与规划 |
| [Runtime 架构与基准](runtime-architecture.md) | 四层模块、维护屏障及 R2/R5 性能记录 |
| [原生 Runtime](native-runtime.md) | Agent 组装、前台工具、准入和结束边界 |

## 消息、事务与维护

| 文档 | 范围 |
|---|---|
| [消息准入](message-admission.md) | 所有者身份/来源、原生 Inbox、去重与投递收据 |
| [本地 IPC](host-ipc.md) | 终端 botctl、profile 私有端点、断连/归属与 drain |
| [请求结果](request-replies.md) | 原生/Git/journal 联合核验及固定回复信封 |
| [turn 事务](turn-transactions.md) | 基准/锁、lease/permit、guard 与数据恢复范围 |
| [反馈与停止](runtime-feedback.md)、[outcome](turn-outcomes.md) | 控制/审计卡片、捕获回合停止、故障计数 |
| [context checkpoint](context-checkpoints.md) | 知识版本/epoch、来源 cut、封存和发布 |
| [自动与手动摘要](managed-compaction.md) | 原生 compaction、旧摘要退役、手动维护与恢复 |
| [sleep/wake 与最小面板](sleep-wake.md) | cutoff/Dreaming/睡眠、同 Session 唤醒、overview/effectiveConfig |

## Worker 与恢复

| 文档 | 范围 |
|---|---|
| [Worker 许可](worker-leases.md) | 角色/任务/子 Session 派生数据许可与 journal v3 |
| [原生 Worker](native-workers.md) | scoped botctl 执行、fresh 上下文、并发/取消及父审计 |
| [Worker 恢复](worker-recovery.md) | 原生 closers、子事件证明、恢复 ledger 与模块交接 |
| [持久恢复证据](durable-recovery.md) | 私有状态位置/权限/fsync、PID 与 boot_id |
| [Runtime 恢复](runtime-recovery.md) | 前台协调、原生/Git/journal 单次结算及拒绝边界 |
| [Runtime 交接](runtime-handoff.md) | Agent-owned 闸门、共享 registry/ABI、关闭和模块替换 |
| [旧只读回合迁移](legacy-migration.md) | 独立迁移入口、只读证明、旧 Host 与 PAUSED 保留 |

## 历史记录与维护规则

原 M0、M2–M5、P0 和 `0.1` 插件验收已合并为 [0.1/0.1.1 历史档案](archive/0.1-acceptance.md)。其中真实调用样本、临时路径、提交及未完成观察保留；现行操作已提取到上面的模块文档。旧开发阶段的逐次发布草稿由 Git 历史保留，当前交付摘要统一在根 RELEASE_NOTE。

后续文档按稳定职责命名，避免再以 M/R/P 阶段编号新建实现说明。细致的许可、恢复、来源与维护契约仍分文档保留；它们有不同的版本和拒绝条件，不能用一个笼统“支持恢复”替代。模块文档维护当前行为/限制，并将早期测试数量标明为历史证据；规划大纲只在 DESIGN 维护，事务清单只在 TODO 维护。
