# TODO：0.1 之后的迭代

0.1 是可运行的 Cordis Host 插件与 Bash 事务核心。已完成事项汇总在 [发布说明](docs/RELEASE_NOTE.md)，实现与后续边界见 [设计](docs/design.md)，维护约定见 [AGENTS](AGENTS.md)。本文件只保留未完成工作，按 P1 → P2 推进；每阶段独立验收、更新文档并提交。

P0 命令反馈与目录选择已完成，归入 [0.1.1 发布说明](docs/RELEASE_NOTE.md)。当前从 P1 推进主 Session；P2 的最小浏览器入口已随修复落地，管理面板尚未实现。

## P1 · 0.2.0：Bot 实例、DSH 工作区与主 Session

Bot 实例是用户创建的一套独立数据及会话绑定；chief/coder 是实例内角色。0.1 的每次 run 都是新的 headless 会话，尚无持久主 Session。

实例登记、init 身份保存、list/import/select、版本/revision 校验及路由基础已在 dev 实现，见 [实例登记](docs/bot-instances.md)。下面只列未完成部分。

Host 的 turn 事务桥、数据工具 permit 和遗留数据 turn 恢复已实现；[原生 Agent Runtime](docs/native-runtime.md) 已接入真实上下文、前台工具、取消和审计。实际主 Session 实体、init/import/open/repair 已接入，见 [主会话](docs/main-session.md)；[审计反馈与停止](docs/runtime-feedback.md) 已验收，[停止/故障计数](docs/turn-outcomes.md) 已区分。[所有者消息准入](docs/message-admission.md) 已提供可信 Host 门面、来源/flush 闸门及原生日志去重收据；[botctl 宿主 IPC](docs/host-ipc.md) 已接入外部 CLI、profile 隔离与端点归属；[请求结果](docs/request-replies.md) 已核验原生/Git/journal 并查回已审计回答。已支持 [Bot 注销与旧 Session 退役](docs/bot-removal.md)，原生工作区删除不自动丢弃身份。已支持 [前台 Runtime 中断恢复](docs/runtime-recovery.md)，已支持 [核心只读旧回合迁移](docs/legacy-migration.md) 与 [Runtime 模块交接](docs/runtime-handoff.md)；[原生 Worker](docs/native-workers.md) 的 scoped botctl 执行、[v3 恢复与模块交接](docs/worker-recovery.md) 已交付并默认开启；其 Bash/文件/PTC、未知写者恢复、非只读旧契约/原生日志缺失的恢复与睡眠/checkpoint 尚未交付。

按 [Session Runtime](docs/session-runtime.md#8-实施与验收) 的阶段顺序推进，先完成主 Session 上下文闭环，再扩展来源和写工具：

- [ ] **阶段 1 · checkpoint/compact**：在已交付 [turn 上下文 checkpoint 基础](docs/context-checkpoints.md) 上接近期摘要/尾部、原生 compaction ID 与摘要 hash/来源证明；接真实手动 `/compact` 闸门与自动 compaction，验收工具配对、来源/可见域保留、旧规则退役、空摘要、flush/替换崩溃和重启恢复。知识内容 hash、memoryCommit/contextEpoch、原始日志 cut、有序 surface/Inbox 来源与原生/Git 单次恢复已接入，不能将此基础视为 compact 已完成
- [ ] **阶段 2 · sleep/wake**：Bot 维护屏障与 Writer 静止，Dreaming → 各 conversation compact/checkpoint 的阶段 journal；睡眠继续接收原生 Inbox 消息，固定执行 cutoff，Git 成功后失败只补未完成阶段，epoch 不提前发布。wake 保留主 Session ID，衔接准入失败后的待办，同 ID 重试不合成业务消息或调用私有 Agent API；验收多窗口发送/编辑/停止、睡眠公平性和中断单次结算
- [ ] **阶段 3a · 对话域/入口**：在 ownerMailbox/CLI IPC 基础上实现持久 conversation 绑定、来源/可见域权限及真实适配器；所有者专用私聊可连主 Session，群/其他用户/peer 默认隔离，未实现记忆过滤前不开放。适配器通过 Cordis Runtime 门面，Web 保留原生提交闸门；附件/路由恢复复用 DSH Inbox，不另造消费状态，继续验收跨 Host 原生 writer-held 与端点交接
- [ ] **阶段 3b · 回复/peer**：按已核验 replyRoute 实现 outbox、外部 ack/不确定状态；独立 Bot 异步信封带来源、correlation/causation、目标权限与 hops/TTL，不能复用所有者身份或树内 send_message。验收 A/B 互相请求不持锁等待、断连/崩溃转交、IM 重试、@alias、编辑冲突与回复不串域，不把 confirmed/ended 或展示记录当事务证明
- [ ] **阶段 4 · Worker 写工具**：在 [原生 Worker](docs/native-workers.md) 上补结构化目录 grants、Bash/文件/PTC 原生权限与生命周期、并发写入/取消及扩展版本的 Writer 恢复契约；真实 PTC/run_code 的保留名称不能用自定义工具覆盖，不用全局 process.env 保存多 Bot 身份，不沿用仅 scoped botctl 的 v3 恢复证明
- [ ] 在上述已接齐的 Writer 契约上扩展 IPC/其他写者及非只读/未知旧契约、原生日志/原所有者丢失的迁移和恢复；不能用前台契约或 data-subprocesses 的核实替代其他写者证明
- [ ] 在已交付 [Runtime 模块交接](docs/runtime-handoff.md) 上补共享 registry 之前旧闸门的支持迁移，核实其他插件/后台写者的静止；保留原 Agent/主 Session，不通过清除 provider 或全 Host 重启掩盖未知所有权
- [ ] 在列表/管理页主动检查缺失/归档实体，显示修复入口；已完成调用 Session 路由、持久绑定与 open/repair，继续验收多 Host writer-held、实体意外返回与故障重启

**验收**：A/B 各有独立目录、DSH 工作区与主 Session，直接对话使用受管理上下文；多窗口并发、重复提交、睡眠中消息、cancel、checkpoint 崩溃恢复与旧规则不复活通过；wake 不重复实体，内部工具不死锁；导入/切换/重启正确；权限、审计与 headless 兼容。

## P2 · 0.2.0：MBot 设置与管理面板

0.1 只有 Host Config 与 volatile workspace schema，没有自有设置面板；此前把 schema 验收写成设置页交付，需要纠正。

- [ ] 扩展已有最小 client 为管理面板；保留 dsh.client、./client、bare dsh-mbot 根行及 Host/headless 独立使用约定
- [ ] 用受支持的 Plugins/Settings 扩展注册 MBot 面板，不修改 DSH 核心；明确页面路径以及关闭/卸载清理
- [ ] 显示实例列表、当前选择、目录、主 Session、角色与运行状态；提供创建、导入、选择、打开、修复和注销，展示独立的退役列表
- [ ] 管理插件默认项和各 Bot 已支持的预算、超时、grants、备份等配置；SOUL/MEMORY 先展示，长期记忆仍遵守既有写者规则
- [ ] 区分插件 Config、Bot 的 .mbot/config 与 DSH 实体；Host 校验后原子保存，数据配置形成 human commit，不重复维护同一值
- [ ] 使用 ConfigEditor/form revision 和 volatile 更新；无效值、并发或保存失败不改变有效配置；凭据只使用引用
- [ ] 显示缺失实体、PAUSED、预算超限、错误与最近报告；面板/日志不展示明文 key
- [ ] 构建、打包可加载 client bundle；真实界面验收创建、编辑、重启、切换、开关和卸载，不能只查 schema 或调用 handler

**验收**：安装后面板可见，创建 Bot → 主 Session → 配置保存 → 重启恢复可走通；A/B 不串；刷新/多标签页不重复注册；CLI/headless 不依赖浏览器。

## 持续验收与后续增强

- [ ] 发布工程：使用与包版本对应的完整 tag（推荐 v0.1.0）；增加 CI；按需增加上传 tgz/校验和的 Release Action，发布不是安装必需项
- [ ] 将 engines.dsh、DSH peers 和实际兼容测试矩阵对齐，避免把宽范围声明视为已验证；规范检查见 [发布检查](docs/plugin-standard-review.md)
- [ ] 至少 7 天真实调度观察：每日检查记忆预算、nightly 提交/报告、违规处理，在 wiki/ops-log.md 记录；第零天不等于完成
- [ ] IM 接入：适配器通过统一门面路由，专用所有者私聊可连主 Session，群/不同用户按可见域隔离；QQ 单账号支持 @alias，传话 Session 只做路由/展示，验证回复不会广播串会话
- [ ] 独立 Bot 间异步信封、reply/correlation、目标权限与 hops/TTL；send_message 仅保留 Worker 树内通信；验证 A/B 相互请求不阻塞彼此 actor
- [ ] 两 Host 写者争用、过期 Worker 回写、配置/队列并发编辑、IM 重试与投递不确定状态的故障验收；不把 FIFO 或 accepted 收据视为跨系统 exactly-once
- [ ] 升级/迁移：配置与登记 schemaVersion、模板兼容；不覆盖自定义协议/角色；验证旧 0.1 仓库及 profile
- [ ] Worker 结果文件隔离；数据仓库恢复与原生 Session 丢失解耦；transcripts 按月归档与 git gc
- [ ] 打包 mbot skill；复活“源”/“u”为真实 Bot；tether 等入口复用同一消息门面
- [ ] 建立 50–100 条私有评测，再决定全文索引/检索；不引入记忆数据库作为真相源

分支和标签按 Git refs 区分，不将某个 tag 的指向写死在规划中。新发布推荐完整版本标签，与 package.version 对应；具体状态及建议见 [发布检查](docs/plugin-standard-review.md)。修复与新功能使用相应提交/版本。
