# 发布说明

按实际版本记录交付；规划以 [DESIGN](DESIGN.md) 为准，未完成事项见 [TODO](TODO.md)。`0.1.1` 之后原先标记为“dev/未发布”的已交付阶段均归并到 `0.2.0-rc.1`，具体契约由模块文档维护。

## 待发布：0.2.0 准备（2026-11-28）

- 将 DESIGN、PLUGIN、RELEASE_NOTE 迁至根目录，更新所有引用及包资源；README 按 rc.1 能力更新，TODO 仅保留未完成事务，架构评审/P3 规划迁入 DESIGN。
- M0、M2–M5、P0 和早期插件验收合并为历史档案，当前说明整理为 headless、记忆、运维模块；新增 docs 索引，将 Runtime 架构文档改为稳定名称，纠正各模块过时的发布/生命周期描述。
- 本地 Markdown 文件/锚点、历史正文保留、`git diff --check`、包资源检查和四类安装验收通过（产物 `/tmp/mbot-plugin-install.jnGyL7`）。本次未修改 Runtime 行为，未重跑真实模型/GUI 或完整业务回归，包版本与既有标签保留。

### CI 与兼容基线

- 配置仓库 workflow：Node 24.9.0 / 24 各运行类型、串行 Host/Runtime、Bash 回归，以及 source/tarball/Git/Web tarball 安装矩阵；固定 Action commit、只读权限、失败日志保留 14 天。随包 `ops/ci.yml.example` 与 workflow 同步，R5 性能验证按授权暂缓。
- 安装脚本支持按模式复跑；恢复夹具遇到短命进程的 `/proc` 竞态时，仅在确认原 PID 已退出/为 zombie、Git/工作树/journal 未变化后有限重试公开恢复入口，活跃或不可核实进程继续失败。
- `engines.node` 对齐官方 DSH 下限 `>=24.9.0`，`engines.dsh` 收窄到与固定 peers 一致的 `0.2.2-rc.5`，package/lock 同步；上游固定 undici 的已知漏洞进入发布核验待办。
- 本地验收：Node 24.9.0 完整回归通过（198 项 Host/Runtime 通过、1 项真实 API 跳过，64 组 Bash）；四类安装通过。Node 24.22.3 首次完整回归有 1 项 Worker 恢复被短命 `/proc` 进程拒绝，确认 PID 退出并检查原现场后专项复跑通过，随后 64 组 Bash 和四类安装全部通过（`/tmp/mbot-plugin-install.QY3dSJ`）。保留失败日志及原夹具，没有放宽生产写者核验。
- `actionlint`、Bash 语法、测试失败退出码、恢复夹具重试约束、package/lock/peers 一致性、322 条文档链接及包资源检查通过。日志分别为 `/tmp/dsh-mbot-node249-test.log`、`/tmp/dsh-mbot-node249-install-retry.log`、`/tmp/dsh-mbot-node2422-test.log`、`/tmp/dsh-mbot-node2422-worker-retry.log`、`/tmp/dsh-mbot-node2422-bash.log` 和 `/tmp/dsh-mbot-node2422-install.log`。本阶段不运行 R5/真实 API/浏览器，GitHub 远端结果留待推送后确认。

## 0.2.0-rc.1（2026-11-28）

标签 `v0.2.0-rc.1`，单实例持久运行预发布里程碑，包含 R1–R4 和 R5 首批热点优化。

| 交付 | 行为与详细说明 |
|---|---|
| Bot 实例、主 Session 与退役 | profile 内稳定登记、独立数据、原生工作区/主 Session、创建/导入/选择/修复/安全注销；旧 Session 归属和数据保留。见 [实例](docs/bot-instances.md)、[主会话](docs/main-session.md)、[退役](docs/bot-removal.md) |
| 原生 Runtime 与审计反馈 | 模型组装前取得 lease，固定上下文，前台工具/取消/guard/Git/flush 闭合；独立卡片与正常停止计数，创建失败不死锁。见 [Runtime](docs/native-runtime.md)、[反馈](docs/runtime-feedback.md)、[outcome](docs/turn-outcomes.md) |
| 持久恢复与模块交接 | 工作树外私有快照、原子写/fsync、PID 出生身份和内核 boot_id；前台/Worker 支持范围内单次恢复、旧只读回合迁移、共享 gate ABI 2 交接。见 [持久证据](docs/durable-recovery.md)、[恢复](docs/runtime-recovery.md)、[迁移](docs/legacy-migration.md)、[交接](docs/runtime-handoff.md) |
| 四层 Runtime 与基准 | gate-driver、conversation-session、bot-coordinator、mailbox-facade；Bot 维护屏障、规模基准与 CI 模板。见 [架构与基准](docs/runtime-architecture.md) |
| 消息、IPC 与已审计回答 | 所有者私聊准入、原生 Inbox 去重、profile 私有 Unix 端点、`receipt --wait` 联合核验原生/Git/journal。见 [准入](docs/message-admission.md)、[IPC](docs/host-ipc.md)、[请求结果](docs/request-replies.md) |
| 原生 Worker v3 | 默认开启 scoped botctl，固定角色/任务/子 Session、派生许可、连续事件证明和一次父审计；中断恢复不重启子模型。见 [许可](docs/worker-leases.md)、[执行](docs/native-workers.md)、[恢复](docs/worker-recovery.md) |
| checkpoint 与摘要 | turn 来源快照、知识内容 hash/epoch、原生自动/手动摘要、普通 turn 旧摘要退役、维护中断冷恢复。见 [checkpoint](docs/context-checkpoints.md)、[摘要](docs/managed-compaction.md) |
| sleep/wake 与最小面板 | cutoff → Dreaming → 可选 compact/checkpoint → 持久 sleeping；睡眠收信、同主 Session 唤醒、已提交 Dreaming 不重跑；只读 overview/effectiveConfig 和 Plugins 面板。见 [生命周期与面板](docs/sleep-wake.md) |

性能记录（2026-11-28 本机合成基准，非生产延迟承诺）：1000 轮 checkpoint 全量恢复由 **45.48s 降到 1.05s（约 43x）**；Worker `actor-event` 单事件由 37.9ms 降到 29.8ms，减少全量 JSON 解析与 ledger 重写。`SecretRedactor` 增加基于 mtime/inode/size 的缓存、动态凭据指纹，以及 PEM/URL query 脱敏。原始数据与复跑见 [性能基线](docs/runtime-architecture.md)。

版本内验收覆盖类型、串行 Host/Runtime、64 组 Bash，以及 source/tarball/Git/Web tarball 安装。浏览器专项覆盖主 Session、原生停止、Worker 崩溃恢复、模块交接和原生摘要/刷新；普通 Runtime 使用本地 scripted adapter，真实 DeepSeek 摘要另行验收。逐阶段证据仍保留在相应模块文档及 Git 历史，复跑见 [PLUGIN](PLUGIN.md)。CI 已提供 [模板](ops/ci.yml.example)，尚未启用仓库 workflow。

尚未交付：隔离对话域与真实 IM/peer/outbox、Worker Bash/文件/PTC 及 compaction、未知/其他写者恢复、完整 P2 配置编辑和至少 7 天真实调度观察。正式版范围与依赖见 [DESIGN](DESIGN.md#后续路线)。

## 0.1.1（2026-11-27）

- 修复只执行 `/mbot` 命令的新会话没有结果：最小 lazy-CJS client 激活聊天视图，复用原生命令事件，支持展开、多窗口、刷新/重启重放，不进入模型 role content。
- `init` 通过 ConfigEditor 保存实际目录，保留并发的新配置；创建/保存失败明确报告部分结果。
- 修正中英文 locale 展示字段，增加无开发依赖 Git fixture。类型、16 项 Cordis、64 组 Bash、源码/tarball/Git 安装与 Chromium 验收通过。

此版本尚无 Bot 实例与主 Session；这些能力随 `0.2.0-rc.1` 交付。历史根因、临时证据和复跑见 [0.1.1 验收](docs/archive/0.1-acceptance.md#p0)。

## 0.1.0（2026-11-26）

首个可运行 Cordis Host 插件：独立 Markdown/Git 数据、双 CLI、任务/候选工具、受控 headless run、guard/脱敏/统一审计、Dreaming 续读/回滚、Chief/fresh Worker 星型调度、tick/原样归档，以及 cron/备份/clone 冷启动/人工观察工具。

Linux、Node 22.23.2、DSH 0.2.2-rc.5 下通过类型、11 项 Cordis、64 组 Bash、源码与 tarball 安装和真实模型闭环。M0–M5 的样本、提交和限制统一保存在 [历史验收](docs/archive/0.1-acceptance.md)；其中 M5 只完成第零天演练，未完成 7 天持续观察。操作说明已整理到 [headless](docs/headless.md)、[记忆](docs/memory.md)、[运维](docs/operations.md) 与 [PLUGIN](PLUGIN.md)。

已有标签 `v0.1.0`、`v0.1.1` 保留。Git 标签、npm 发布与 GitHub Release 是不同发布渠道，实际发布情况以对应渠道记录为准。
