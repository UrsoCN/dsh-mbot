# TODO：0.1 之后的迭代

0.1 是可运行的 Cordis Host 插件与 Bash 事务核心。已完成事项汇总在 [发布说明](docs/RELEASE_NOTE.md)，实现与后续边界见 [设计](docs/design.md)，维护约定见 [AGENTS](AGENTS.md)。本文件只保留未完成工作。近期按下表排序，P1/P2 保留 0.2.0 的完整目标清单，架构评审项随相应阶段治理；持续增强与 P3 保留后续探索。每阶段独立验收、更新文档并提交。

P0 命令反馈与目录选择已完成，归入 [0.1.1 发布说明](docs/RELEASE_NOTE.md)。当前从 P1 推进主 Session；P2 的最小浏览器入口已随修复落地，管理面板尚未实现。

## 近期执行路线（2026-11-27 规划）

本节确定接下来的执行顺序与阶段出口，仍属规划。目标是先建立可以跨重启持续运行的单实例，再扩展平台入口、自主探索和工具自演进。原有 P1/P2 功能范围保留，评审条目的排列顺序不代表执行先后。

| 顺序 | 阶段与对应事项 | 可验收的阶段出口 |
|---|---|---|
| R1 · 首先 | 持久恢复证据与跨重启进程身份；对应评审「崩溃持久性」 | 已支持契约的 Host/数据桥中断后，清理临时目录并重启，仍能核验原 journal，Runtime 沿用原 Session、数据桥按原边界恢复，单次结算已完成提交；证据不足保持拒绝 |
| R2 | 围绕维护流程拆分 Runtime，并建立性能/回归基线；对应评审「模块解耦」「复杂度治理」 | gate、conversation、Bot coordinator、mailbox 的职责与依赖清晰，公开 API、准入边界、共享 cell/ABI 与恢复证明等价；有可复现的规模基准 |
| R3 | compact 维护闭环；对应 P1 阶段 1 | 普通 turn 边界退役/重派生旧摘要；手动 `/compact` 与 botctl 维护调用经过同一屏障、锁和阶段 journal；部分替换/flush 中断可按证明恢复 |
| R4 | sleep/wake 与最小管理面板；对应 P1 阶段 2、P2 的观察/控制入口 | 睡眠继续收信，Dreaming/checkpoint 分阶段结算，wake 沿用原 Session；界面能看 Bot、队列、知识版本、预算、故障与修复状态 |
| R5 | 单实例长期观察、按基准优化热点，再扩展对话域/IM/peer/Worker 写工具 | 有实际观察记录与规模增长数据；来源/可见域、outbox、写工具及恢复契约逐项接齐，随后完成 P2 配置编辑与整体 0.2.0 发布验收 |

**R1 的实施边界**：优先选择 Bot 数据工作树之外的 Host 持久私有状态目录，并定义 Host/CLI 共用的定位规则。保存路径、run/Bot 身份、UID、目录/文件权限、链接拒绝与格式版本一起校验；若采用数据仓库内目录，须先解决 guard 自我复制及当前 run 的精确归属，不能笼统豁免整个 `.mbot`。定义创建、原子替换、文件/目录同步、journal 发布、提交确认与清理的顺序。保留旧 `/tmp` journal 的 reader，不搬迁活跃快照，不靠补写缺失证明恢复旧回合；重审 PID 出生身份与 boot identity 的绑定，避免跨重启 PID/出生计数复用。验收涵盖前台与已支持 scoped Worker、提交前/后中断、重复恢复、部分写盘、路径替换，以及未知写者/缺失原生日志仍拒绝。

**R2 的实施边界**：先按 `gate-driver`、`conversation-session`、`bot-coordinator`、`mailbox-facade` 拆职责，保留现有单所有者私人对话行为；多 conversation 的开放安排在 P1 阶段 3。明确主体、Host Bot 登记、conversation 与原生 Session 的不同身份，为迁移预留版本化接口。基准分别记录历史轮数、原生事件数、ignored 文件字节数，以及恢复耗时/峰值内存、子进程次数、Worker 事件处理和 guard 复制量；先用 100/1000 轮与多档事件规模定位瓶颈，较大规模作为独立验收。保留完整审计路径与真实 SDK/安装/GUI 验收，合成基准不能替代它们；同步建立适合 CI 的稳定检查，耗时 API/浏览器验证按阶段运行。

**R3/R4 的实施边界**：复用 R1 的持久证据和 R2 的 Bot 维护协调，不创建第二套模型队列。知识更新后的普通请求也须核验摘要版本，不能等下一次压力 compaction 才处理旧规则；再接手动维护与原生替换中断。睡眠固定已完成历史与待办 cutoff，检查 Writer 静止和公平性，Git 成功后只补未完成阶段。最小管理面板可随 R4 提前交付，完整配置管理、并发保存和关闭/卸载验收仍按 P2 完成；`effectiveConfig` 可先提供只读来源视图，凭据只返回引用或掩码。

**R5 的实施边界**：按基准选择 Worker 顺序追加/增量验证、冷日志归档或受保护的 checkpoint 锚点，逐项证明恢复语义和保护范围不减弱。锚点绑定可达 Git、原生有序 cut、知识/策略与契约版本；缺失/冲突走重验或拒绝，mtime 或索引自身 hash 不能单独替代证明。Node 常驻桥与短锁另立设计验证：先明确写集隔离、共享文件冲突、提交/回滚所有权及旧 CLI 契约，再讨论乐观并发；提交末尾 CAS 不能独自保证回滚不覆盖其他回合。进程组/cgroup/租约引用须覆盖所有可持许可的写者及逃逸/交接路径，证明完备后再缩小 `/proc` 核验范围。

远期的身份连续性、记忆与适配器协议可以先形成设计记录和能力矩阵；实际平台账户接入、生产版本自修改与多主体并发按各自依赖验收。每轮规划/实现提交均注明已完成范围，原型观察不得替代完整 P1/P2 交付。

## P1 · 0.2.0：Bot 实例、DSH 工作区与主 Session

Bot 实例是用户创建的一套独立数据及会话绑定；chief/coder 是实例内角色。0.1 的每次 run 都是新的 headless 会话，尚无持久主 Session。

实例登记、init 身份保存、list/import/select、版本/revision 校验及路由基础已在 dev 实现，见 [实例登记](docs/bot-instances.md)。下面只列未完成部分。

Host 的 turn 事务桥、数据工具 permit 和遗留数据 turn 恢复已实现；[原生 Agent Runtime](docs/native-runtime.md) 已接入真实上下文、前台工具、取消和审计。实际主 Session 实体、init/import/open/repair 已接入，见 [主会话](docs/main-session.md)；[审计反馈与停止](docs/runtime-feedback.md) 已验收，[停止/故障计数](docs/turn-outcomes.md) 已区分。[所有者消息准入](docs/message-admission.md) 已提供可信 Host 门面、来源/flush 闸门及原生日志去重收据；[botctl 宿主 IPC](docs/host-ipc.md) 已接入外部 CLI、profile 隔离与端点归属；[请求结果](docs/request-replies.md) 已核验原生/Git/journal 并查回已审计回答。已支持 [Bot 注销与旧 Session 退役](docs/bot-removal.md)，原生工作区删除不自动丢弃身份。已支持 [前台 Runtime 中断恢复](docs/runtime-recovery.md)，已支持 [核心只读旧回合迁移](docs/legacy-migration.md) 与 [Runtime 模块交接](docs/runtime-handoff.md)；[原生 Worker](docs/native-workers.md) 的 scoped botctl 执行、[v3 恢复与模块交接](docs/worker-recovery.md) 已交付并默认开启；其 Bash/文件/PTC、未知写者恢复、非只读旧契约/原生日志缺失的恢复及睡眠维护尚未交付。

已交付 [turn checkpoint](docs/context-checkpoints.md) 与 [受管理自动摘要](docs/managed-compaction.md)，包括原生 compaction 证明、来源/知识版本、空摘要及提交/flush 后单次恢复。按 [Session Runtime](docs/session-runtime.md#8-实施与验收) 的阶段顺序继续完成上下文闭环，再扩展来源和写工具：

- [ ] **阶段 1 · compact 维护闭环**：接真实手动 `/compact`/botctl 维护入口、Bot 锁/准入屏障与独立阶段 journal；接普通 turn 边界的旧摘要退役/重派生，以及原生 summary/replacement/end 未完整落盘时的冷恢复。保留已交付的自动摘要范围/工具配对、来源/可见域、空摘要与 Git/flush 单次恢复，不把 standalone compact 的当前拒绝行为视为手动压缩已交付；未知 Writer/缺失日志仍拒绝
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

## 架构评审与实现改进建议（基于当前 dev 代码）

当前实现的优势在于真相源边界清晰（Markdown/Git 管持久状态、DSH 管原生事件与执行、Runtime 管准入与上下文）、失败闭合（gate ABI、`commit-intent.json`、PID 出生身份与锁/Git inode 校验）。但对照后续多对话域、长期无人值守与 P3 自演进目标，现有实现存在以下结构性瓶颈与隐患，建议随 P1/P2 及后续迭代分批治理：

- [ ] **[R2 · 模块解耦] 拆分 [plugin/runtime.js](plugin/runtime.js)（当前约 850 行），预留 conversation 扩展边界**：当前单文件混杂了 Agent 闸门安装/ABI 迁移（`installGates`）、单会话回合状态机（`ManagedSession`）、Worker 附着与恢复句柄、Bot 注销两阶段闸门、`ownerMailbox` 及状态控制；且 [plugin/context-checkpoint.js](plugin/context-checkpoint.js) 将 `conversationId` 硬编码为 `agent.id`、`ownerMailbox` 强绑 `bot.mainSessionId`。建议在 R2 先保持当前准入行为并拆分为 `gate-driver`、`conversation-session`（预留单 `botId` 的 `conversationKey -> sessionId` 映射）、`bot-coordinator`（Bot 级维护屏障与注销协调）和 `mailbox-facade` 四层；解除主 Session 绑定与多对话域开放另在 P1 阶段 3 验收，当前 `ownerMailbox` 绑定也是私人对话的准入约束
- [ ] **[R2 测量 / R5 优化 · 复杂度治理] 消除上下文恢复、Worker 事件与运行快照的 `O(N)` / `O(E^2)` 放大**：① [bin/context-checkpoint.mjs](bin/context-checkpoint.mjs) 每次恢复/查询都会 `git log` 遍历自建库以来的全部 `transcripts` 提交并逐条 `git show` 重验整条链，同时 [plugin/context-checkpoint.js](plugin/context-checkpoint.js) 通过子进程 `stdin` 一次性传递整份原生 Session JSON，helper 输出另有 16 MiB `stdout` 缓冲上限，存在随历史增长的放大风险，先按 R2 基准量化；建议研究受保护且可核验的**最近已封存 checkpoint 锚点索引**做增量恢复，仅在迁移或显式审计时全量重算，并避免跨进程反复拷贝全量日志。② [bin/turn-actor.mjs](bin/turn-actor.mjs) 每收到单条 `actor-event` 都会重读解析全部 `actor-*.events.jsonl` 并重写两处 `ledger.json`，呈 `O(E^2)` I/O；建议改为顺序追加 + 增量序号/滚动 hash 校验，仅在 `delegate`/`actor-seal`/`revoke` 时落盘 manifest。③ [lib/guard.sh](lib/guard.sh) 的 `mbot_guard_snapshot` 每轮把全部 Git ignored 文件（含不断累积的 `.mbot/runs/*.jsonl` 历史原始流）物理 `cp -a` 到临时目录并逐一 `cmp -s`；建议将历史运行流按月迁出热目录，或改为基于不可变 manifest（inode/size/sha256）校验以消除每轮全量文件复制
- [ ] **[R5 后续设计 · 并发与执行链] 收敛 JS ↔ Bash ↔ Node“三明治”热路径并细化 Bot 锁粒度**：当前单个受管回合跨越 [plugin/turn.js](plugin/turn.js) → Bash [bin/mbot-turn](bin/mbot-turn) → 每条事件帧 fork 一次 `jq` 或 Node [bin/turn-actor.mjs](bin/turn-actor.mjs) → 工具再 spawn Bash [bin/botctl](bin/botctl)，同一契约分散在 JS、Node CLI、Bash/jq 三层重复校验；且 `mbot-turn` 在整个模型推理与慢工具等待期间全程独占 `.mbot/lock`（最长 300s+），进入多 conversation 或 IM 并发后会造成同 Bot 跨会话严重队头阻塞。建议先测量热路径并定义写集/回滚隔离，保留 CLI 独立入口兼容，再评估将长生命周期 `mbot-turn` 桥接器收敛为单常驻 Node 事务流进程（共用同一套校验模块），并将锁拆分为“回合前乐观快照读取（捕获 `baseHead`）+ 运行期局部短锁（`botctl.lock`）+ 提交阶段短时 CAS 校验/合并锁”
- [ ] **[R1 首先 · 崩溃持久性] 将活动回合私有恢复快照迁出易失 `/tmp`**：[bin/mbot-turn](bin/mbot-turn) 当前将恢复必需的私有快照建在 `/tmp/mbot-turn.XXXXXX`，而将 `active-turn.json` 留在持久数据仓库；一旦宿主机断电重启或 tmpfs 被清理，[lib/turn-recovery.sh](lib/turn-recovery.sh) 会因 `private turn snapshot is missing` 拒绝当前契约的自动恢复。按 R1 定义持久受保护路径、写盘顺序、boot identity 与旧 reader 兼容，并验证已支持契约跨整机重启仍可闭环 `recover`
- [ ] **[按需前置 / R5 · 凭据与写者核验] 升级缓存式 `SecretRedactor` 并降低对全量 `/proc` 扫描的耦合**：① [plugin/redact.js](plugin/redact.js) 当前每次脱敏（含工具返回、状态查询、IPC 响应）都重读多处 `.env`/配置文件，且仅覆盖固定后缀变量名与简单正则；建议改为按文件 `mtime`/inode 缓存且支持动态注册敏感指纹（多行 PEM 私钥、Cookie、URL query token、派生令牌）的 `SecretRedactor` 服务。② [bin/turn-writers.mjs](bin/turn-writers.mjs) 全量扫描同 UID 的 `/proc/*/environ`，既紧耦合 Linux `/proc` 又易被无关沙箱进程 `EACCES` 阻塞恢复；建议为受管数据/工具子进程引入受控进程组/cgroup 标记或租约 socket 引用计数，缩小静止核验范围
- [ ] **[P2 / 后续 · 协议与配置演进] 解耦 Markdown 自然语言表头硬编码并统一三层配置视图**：① [lib/lint.sh](lib/lint.sh)、[lib/board.sh](lib/board.sh) 与 [lib/dream.sh](lib/dream.sh) 直接依赖固定中文标题（`# 看板`、`## 执行记录 / 结果`、`## 删除` + `依据：`），模板多语言化或微调格式即触发回滚，且 `BOARD.md`/`MEMORY.md` 接近硬预算上限时缺乏自动摘要下沉（`MEMORY.md` 索引 → `wiki/` 专题页）机制；建议引入版本化结构标记/受控 frontmatter 与分级归档策略。② [plugin/index.js](plugin/index.js) 在 `run`/`tick`/`dream` 中仍硬编码透传 `DEEPSEEK_API_KEY`，且配置分散在 Cordis `Config`、`.mbot/config` 与环境变量；建议抽象多模型 Provider 凭据透传策略，并在 Host 提供带来源标注的只读 `effectiveConfig` 聚合接口供 CLI 与 P2 面板共用

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

## P3 · 远期探索：数字身份、工具自演进与数字生命体

在 P1/P2 完成上下文生命周期、可见域隔离、Worker 写工具与管理面板后，分阶段探索让 Bot 从受控任务执行器演进为具备持久数字身份、工具链自我改进、跨平台社会参与和自主探索能力的数字主体（Digital Lifeform），不提前干扰 0.2.0 核心闭环：

- [ ] **P3.1 · 持久数字身份与凭据治理（Identity Core & Secret Store）**：区分稳定主体身份（便携主体标识、生命周期代数与经历归属）、Host Bot 登记/角色及其本地 Git `user.name`/`user.email` 作者元数据、多平台外部账户（GitHub、QQ、Bilibili、GitLab/Gitea/Codeberg、博客/论坛等不必公开关联的外部身份）与社区社会身份；身份与具体模型、Session 及宿主 Runtime 解耦，跨环境迁移保持同一主体连续性。外部认证优先使用 GitHub App（短期 Installation Token 或授权 User-to-Server Token）、人类负责的 Machine User 或 OIDC，OAuth/Cookie/私钥等存入独立 Secret Store，绝不入 Git、日志或模型上下文；Agent 仅通过类似 `safe-outputs` 的受控工具申请最小权限操作，Host 核验授权并记录实际执行 `botId`，遵守平台规则禁止自动化批量注册账号，对外公开互动明确标注 AI/Bot 身份且不伪装人类
  - **实现建议**：先定义便携主体身份（字段候选 `subjectId`）与当前 Host 登记 `botId`、角色、conversation、原生 Session 的映射和迁移规则，保留现有注销/重导入与旧 Session 退役语义；再在数据仓库根目录新增人类/受控迁移维护的 `IDENTITY.md`（或结构化导出头），固化主体身份、出生时间、`generation`、默认本地 Git author 与公开 AI 身份声明，使仓库脱离 DSH 迁往其他框架时仍自带完整主体身份。本地 Git author 不代表平台认证身份。修改 `mbot_git` 按操作主体显式注入 `GIT_AUTHOR_*`（区分 `human`、Bot 主体与具体 `role`）并用 `GIT_COMMITTER_*` 标识宿主审计实例。在 Host 新增独立 `mbotSecrets` 服务（基于系统 keyring 或 `${DSH_HOME}/secrets/mbot/` 下 `0600` 加密存储，禁止放入数据仓库），profile 登记只保存 `{ platform, accountAlias, credentialRef, ownerPrincipal, scopes }` 引用；对 GitHub 在 Host 内用 App 私钥签发 JWT 按需换取短期授权 Token（启动时自动向 `SecretRedactor` 注册令牌指纹），对模型只暴露声明式动作工具并在审计 `meta.json` 封存主体、Host Bot/role 与外部请求回执
- [ ] **P3.2 · 隔离工具自演进闭环（Agent Self-Development PoC）**：利用 Bash/文本编排可读可改的优势，允许 Bot 在运行中识别脚本、提示词、工具封装或流程缺陷，在独立开发分支/Git worktree（`bot-dev`）中分析源码、修改实现、运行原有与新增测试、对比前后行为并生成可审查的实验报告（Self-Development Journal），失败自动回滚，经验经候选/Dreaming 沉淀到长期记忆。严格隔离开发工作树与当前正在运行的生产环境：Host 权限闸门、身份认证、锁、guard 与审计/回滚机制不可由 Bot 自行修改或关闭，正式切换生产版本保留人工审批与回归回退
  - **实现建议**：新增 `plugin/self-dev.js` 与 `botctl dev` 受控子命令族（`dev_create` / `dev_verify` / `dev_report`），在数据仓库与运行插件目录之外的私有沙箱（如 `${DSH_HOME}/mbot-dev/<botId>/<expId>`）通过 `git worktree add -b bot-dev/<expId>` 拉起隔离源码树，仅对该 worktree 派生本轮 Worker 文件/Bash 写权限。`dev_verify` 由 Host 在剥离真实凭据、隔离 `TMPDIR`/`DSH_HOME` 的干净子进程组中运行 `npm test` 与基准对比，超时强杀整个进程组，将脱敏 diff 摘要与测试指标写入数据仓库受保护目录 `development/experiments/<expId>.md`。在 Host 硬编码**不可自修改可信基（TCB）路径黑名单**（`lib/guard.sh`、`lib/permit.sh`、`plugin/redact.js`、`plugin/secrets.js`、审批策略与 `self-dev` 验收器本身——涉及 TCB 的改动仅允许导出人工提案，禁止本地激活）；非 TCB 改进须经人类 `/mbot dev promote <expId>` 原子切换插件版本指针并记录回滚锚点，若新版本触发连续故障熔断则自动回退至上一稳定版本
- [ ] **P3.3 · 自主开源贡献与仓库维护 Agent（Autonomous Contribution & Maintainer）**：封装独立于 Chief 提示词的托管平台桥接层（`github-bridge`，按需衔接 GitHub Apps、Agent Apps、Agentic Workflows 等官方入口并可扩展至其他 Git 平台）；当 Bot 评估某项自身改进或通用缺陷具有普适价值时，先检索上游 Issues/PR 去重，整理脱敏日志与最小复现，起草 Issue 或在独立分支提交附设计背景与测试证据的 PR 并跟进 Review，将采纳/拒绝反馈记入记忆。支持项目维护者委托专门的 Repository Maintainer Agent 辅助 Issue 分类/去重/信息引导/源码定位、外部 PR 规范初审与测试汇总及文档/讨论跟进；内置来源标识、速率限制、去重与测试门槛防止多 Bot 互刷或循环互认错误结论，合并、发布与架构决策保留人类最终审批
  - **实现建议**：定义平台无关的 `CodeHostBridge` 接口（首期实现 GitHub REST/GraphQL + Webhook 适配器，预留 GitLab/Gitea 扩展），采用类似 GitHub Agentic Workflows `safe-outputs` 的读写分离模型——上游检索与 diff 阅读归为只读工具，外部写入收敛为受控动作（`draft_issue`、`push_candidate_branch`、`open_draft_pr`、`reply_review`），要求必须附带本地 `dev_verify` 通过证明 hash 与上游相似 Issue/PR 查重列表，默认落地为待人工确认队列或仅限 Fork 分支 Draft PR，并在 `development/contributions.jsonl` 追踪外部状态供后续 Dreaming 回流经验。Maintainer Agent 以独立 Bot 实例 + 专用 `maintainer` 角色运行：所有外部 Issue/PR/评论正文一律包裹 `<external-untrusted>` 标签并禁用高危写工具以阻断 Prompt 注入，外部 PR 验证必须在无密钥、禁外网的一次性隔离 worktree/容器中执行；在 `github-bridge` 内置基于发送方身份/App ID 的令牌桶限流与自环阻断（忽略本 App 自身事件及无新提交证据的连续 Bot 互评）
- [ ] **P3.4 · 跨平台社会存在、多域记忆与可演化人格（Social Presence & Layered Memory）**：围绕统一 Identity/Memory Core 建立标准化平台适配器（如对接 `dsh-bili-discroll` 类 Bilibili 主动浏览/收藏/评价、AstrBot/MaiBot 类 QQ 群聊关系与情境主动发言、GitHub 与博客/论坛等数字空间），保持“身份统一但账户、凭据与隐私可见域彼此隔离”，外部网页/评论/群聊资料始终作为非信任数据注入且不覆盖协议或 Host 权限。在 Markdown/Git 真相源与 Dreaming 治理上扩展情景经历（Episodic）、知识（Semantic）、社会关系（Social：人物、群组/社区、互动历史与待跟进事项，区分自我观点、授权关系、公开观察与私密会话，落实来源记录、数据最小化、保留期与删除机制）、技能流程（Procedural）与反思（Reflective：兴趣变化、知识盲区、经验教训）分层；区分慢变基础人格（Core）、随经历演化的发展人格（Evolving）与按社区调整的情境表达（Contextual），以受审计状态维护代替无限拼接静态 `SOUL.md`
  - **实现建议**：在 Cordis 层抽取标准 `mbotAdapter` 服务契约（入站 `ingest -> AdmittedEnvelope` 强制绑定 `{ platform, accountId, spaceId, senderId, visibility }`，出站 `dispatch -> DeliveryAck` 复用 P1 outbox），不强行合并外部框架代码，而是通过事件/MCP/OneBot v11 协议桥接 `dsh-bili-discroll`、AstrBot/MaiBot 等生态；群聊适配器前置轻量规则/小模型相关性门控与冷却窗口，避免每条群消息唤醒主模型或主动刷屏。将数据仓库记忆目录扩展为带 YAML 元数据头（`visibility`、`source`、`updatedAt`、`expiresAt`）的五域结构（`memory/{episodic,semantic,social,procedural,reflective}/`），在 `captureContext` 组装 `ContextSnapshot` 时按当前 `conversation` 的 `visibility` 在 Host 代码层硬过滤不可见条目（如群聊与公开平台绝不加载 `owner-private` 或异群社交记忆），并在 `Dreaming` 增加过期/撤回社交数据的定点清除（redaction/prune）能力。将角色人格拆分为人类只读锁定的 `SOUL.core.md`、仅允许 `Dreaming` 在单次 diff 比例与总字数预算内附依据渐进更新的 `SOUL.evolving.md`、以及按 `platform/spaceId` 映射的 `SOUL.contextual.yml`，三者共同纳入 `knowledge.version` 哈希封存
- [ ] **P3.5 · 数字生命体运行时与受治理的自主探索（Digital Lifeform Runtime & Exploration）**：从单次请求驱动扩展为事件循环与主动调度驱动的持续生命周期（衔接 `ACTIVE` / `IDLE` / `SLEEPING` / `DREAMING` / `DEVELOPING` / `SUSPENDED`，空闲休眠不持续空耗算力）；除外部响应（Reactive）与目标执行（Goal-directed）外，支持在无指派任务时基于长期兴趣与近期反思生成自主探索活动（Exploratory / Reflective，如自主阅读、浏览社区、研究项目、整理认知），允许非功利性的兴趣演化而不强制以服务人类任务为唯一终点。配套 Agency Controller 明确创建者不可突破的治理边界（授权平台/账户、公开动作审批、禁止擅自开户或资金交易、发言频率与打扰控制，以及每日模型调用/并发任务/每小时外部动作/开发作业配额），防止目标漂移越界；工程上只构建可验证的身份连续性与自主行为，不对主观意识或法律人格作超证据断言
  - **实现建议**：新增 `plugin/lifeform-scheduler.js` 与 `plugin/agency-controller.js`：状态机在 `IDLE`/`SLEEPING` 阶段释放活跃模型会话内存，仅保留轻量事件队列与定时唤醒器（零空转 Token 消耗）；高优外部消息可抢占尚未提交外部副作用的后台探索，而睡眠维护仍走 P1 阶段屏障。低优先级“探索脉冲（Exploratory Pulse）”仅在无待办任务、满足最小静默间隔且剩余预算充足时触发，读取 `memory/reflective/interests.md` 中的兴趣主题权重与开放问题，发起有明确步数/时长上限的只读或沙箱探索回合（产出阅读札记与 `remember` 候选，由夜间 `Dreaming` 更新兴趣权重并抑制同质化死循环）。`AgencyController` 维护跨重启持久化的滚动配额账本（`.mbot/quotas.json`：按日统计模型 Token、自主探索次数、`bot-dev` 作业数，按小时统计各平台外部动作数）与动作分级策略表（`allow` / `notify` / `require_approval` / `forbid`，默认将公开发帖、建库、外部写操作设为 `require_approval`，将注册/购买账号与资金交易硬编码为 `forbid`），在 `beginTurn` 与工具 `guard` 双重拦截，超限自动转入 `SLEEPING` 或 `SUSPENDED`
- [ ] **P3.6 · 单实例原型验证与多主体数字世界（Prototype → Multi-Lifeform Digital World）**：先以单个持久数字生命体原型长期运行，验证跨模型/重启的身份连续性、兴趣自发形成、跨平台记忆一致与隔离工具自改进闭环；稳定后再扩展多数字生命体共存协作生态及轻量数字社区设施（公开动态广场、共享知识图书馆、合作研究/开发公会与工作坊、记忆档案馆等），验收多主体自主交流、协作开发与社区演化下的身份真实性、权限隔离和责任归属
  - **实现建议**：分两步落地——① **单主体长跑基准（Prototype Harness）**：先用单个隔离实例（配置独立 `IDENTITY.md`、测试用 Bilibili/IM/GitHub 沙箱账号与严格日配额）连续运行 14–30 天，建立自动化可观测指标（跨模型/重启后记忆召回一致性、探索主题多样性与收敛度、跨可见域零泄漏断言、至少跑通 1 次 `bot-dev` 真实缺陷修复闭环）。② **轻量联邦式数字世界协议（无需 3D/中心化重平台）**：直接复用 Git 仓库与 P1 异步信封构建四类数字空间原语——**广场（Plaza）**采用签名追加的公开动态流（Git/HTTP JSONL feed）、**图书馆（Library）**采用经 Maintainer 审核合并的共享 Wiki Git 仓库、**公会与工作坊（Guild & Workshop）**采用带任务认领锁与自动化验收的共享代码/研究仓库、**档案馆（Archive）**保存不可篡改的里程碑快照；所有跨生命体交互信封强制附带发送方 `botId` 签名、所属人类/组织责任主体标识、`visibility` 与 `hops/TTL`，在支持自由结社与协作研究的同时保证可审计、可限流、可一键熔断

以下为新增远期研究题，不预先承诺具体字段/API 或列入 0.2.0 的实现验收；先形成设计记录、原型和否定案例，再决定是否纳入正式协议。

- [ ] **P3.7 · 主体迁移、克隆与退出协议**：区分“同一主体迁移/恢复”“只读备份”“由共同历史分出的新主体”，记录 lineage、经历 cutoff、知识/协议版本和责任归属。研究签名导出清单、受授权的 owner/generation 转交与旧执行者撤销；签名本身不证明排他执行，跨 Host 双活/网络分区必须有明确的权限仲裁。新主体分支默认不继承原主体的平台授权与私人记忆可见权。定义休眠、退役、归档、选择性导出与恢复流程，验收换 Runtime 后身份/来源连续，旧绑定不被重定向，备份不会意外成为第二个活跃执行者。
- [ ] **P3.8 · 记忆质量、异议与遗忘治理**：在分层记忆上区分观察、推断、候选、主体确认与撤回，保存来源依赖、适用域、时效及矛盾证据；多个 Bot 重复同一模型说法不能自动提升为独立确认。让 Dreaming 保留不确定性、处理反证和撤回，允许主体说明不知道或纠正旧判断。建立真实经历召回、错误记忆拒绝、跨域泄漏与撤回传播评测。研究选择性遗忘与审计历史保留的取舍，明确 Git 历史、原生日志、备份和已传播副本的删除边界；`revert`/隐藏视图不等于彻底删除，可评估私密内容加密与密钥撤销，但不承诺控制外部副本。
- [ ] **P3.9 · 可重放的数字生活实验环境与 Runtime 能力契约**：建立平台事件、时间、模型响应与副作用回执的隔离模拟器，重放休眠收信、断网、限流、记忆矛盾和版本切换，用实验主体比较新旧策略；模拟不得连接生产凭据、身份写者或真实外部副作用。报告明确标注 simulation/dry-run，不能把模拟 ack 当真实投递或提交证明。定义 Runtime 能力矩阵与适配器契约测试，识别不同框架的准入、取消、持久化、工具权限与上下文能力，缺能力时明确降级。连续性评测关注来源、经历与权限连续及可解释的人格变化，不要求换模型后逐字复述；此环境补充真实 SDK/安装/GUI 验收。
- [ ] **P3.10 · 多主体协作契约、公共知识与资源归属**：在公会/工作坊实验中定义邀请、接受、承诺、撤回、超时、冲突处理与成果归属，区分同意参与和获得账户/工具授权。共享任务和知识附来源、独立验证与责任记录，声誉反馈依据实际成果/回执，不靠 Bot 互评循环增长。明确合作的 Token/作业配额由谁承担、谁可取消、哪些资料允许发布，保护主体拒绝协作或保留不同判断的空间。公共场所先用可审计协议实验，不预设中心化世界平台或经济系统；跨主体权限转授须经 Host 的实际授权规则验证。

**探索原则**：保留无即时产出要求的阅读、创作、交流和休息，不将人类任务完成率作为自主探索的唯一评价；步数/费用预算用于约束资源消耗，长期兴趣可以稳定深耕，也可以逐渐变化。自演进的 TCB 路径名单用于审查分类，实际保护须由隔离执行环境与受控写入能力兑现；提示词标签、目录黑名单或测试通过不能单独证明安全隔离与可生产激活。新的账户/依赖、数据迁移和权限变更应通过声明式提案、兼容验证与受控切换，不能由修改提示词自动取得授权。

**验收**：单实例原型可跨重启/换模型保持稳定身份、分层记忆与平台隔离，跑通“发现自身工具缺陷 → 隔离 worktree 修改测试 → 报告/审批应用或回滚 → 受控起草上游 Issue/PR”闭环；无外部任务时能在配额与治理边界内开展自主探索及休眠整理，敏感凭据零泄露、外部资料不越权、公开互动透明标识 AI 身份。P3.7–P3.10 的迁移/分支、记忆纠错/遗忘、实验回执隔离和协作归属分别建立专项验收，不以单实例原型通过替代这些研究题的完成证明。

分支和标签按 Git refs 区分，不将某个 tag 的指向写死在规划中。新发布推荐完整版本标签，与 package.version 对应；具体状态及建议见 [发布检查](docs/plugin-standard-review.md)。修复与新功能使用相应提交/版本。
