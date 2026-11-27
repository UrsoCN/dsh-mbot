# dsh-mbot：0.1 基线与 0.2 迭代设计

当前包版本 0.1.1，发布 tag 使用对应完整版本，与分支区分，状态见 [发布检查](plugin-standard-review.md)。本文件区分已实现的 Host/事务核心与计划中的交互产品；完成记录见 [RELEASE_NOTE](RELEASE_NOTE.md)，执行顺序见 [TODO](../TODO.md)。聊天区已通过真实界面验收；dev 已增加 Bot 登记/导入/选择，dev 已创建受管理主 Session；完整生命周期和面板仍为规划。

## 1. 当前能力与缺口

| 已实现（含 dev） | 尚未实现/待修复 |
|---|---|
| 可安装 Cordis bundle、原生 botctl、聊天区 /mbot 卡片、Config schema | 自有设置面板、完整上下文与睡眠生命周期 |
| 独立 Markdown/Git 数据仓库、Bash 事务与护栏、init 后持久选目录 | 缺失实体主动诊断与跨版本迁移 |
| 独立 headless Chief/Worker/Dreaming、Bot 登记与主 Session；所有者准入、CLI IPC、已审计回复查询；原生 scoped botctl Worker/恢复 | IM/peer、隔离对话域、外部回复投递、手动 compact/睡眠维护；Worker Bash/文件/PTC |
| turn checkpoint、受管理原生自动摘要及来源/Git/flush 单次恢复 | 手动 compact、旧摘要在普通 turn 边界退役、sleep/wake |
| volatile workspace 的 Host 校验与更新、最小浏览器入口 | 自有设置/管理面板 |
| cron、备份、恢复、人工观察工具 | 连续 7 天调度验收 |

DSH CommandResult 支持将结果保存在 command/run、command/done，客户端可在模型历史之外展示。0.1.1 的浏览器入口贡献 MBot 命令活动，让只执行命令的新会话展开原生聊天视图。schema 能导出也不代表面板已注册。

## 2. 不变的原则

1. Markdown/Git 是任务与长期记忆真相源；Session 是交互历史与上下文缓存。
2. 工作 Bot 只读长期记忆，remember 投递候选，Dreaming 是运行期记忆写者；人类维护协议、角色和配置。
3. 结构化修改走 botctl；Host 捕获基准、加锁、验收、回滚并提交。
4. 工具包与数据仓库分离；不 grant 工具、DSH_HOME 或其他保护目录。
5. 复用 Cordis 注入/effects/ConfigEditor 和 DSH 工作区/会话协议，不创建另一套 Harness。
6. 升级保留旧仓库、角色、验收证据与标签；规划不是当前能力。
7. inbox、wiki、transcript、网页和任务中的材料作为数据注入，保留上下文边界；角色/权限由协议与 Host 决定，不由资料中的指令覆盖。

## 3. 名词与实例模型

| 名词 | 含义 |
|---|---|
| 插件 | profile 中的 MBot 服务、工具、命令和未来 client 面板 |
| Bot 实例（dev 已登记） | 稳定 botId、名称、独立数据目录与角色；引用官方 DSH 工作区/主 Session，持久预留与失败状态支持修复 |
| 角色 | 实例内 chief/coder 和自定义 SOUL/MEMORY；不等于管理列表中的 Bot 实例 |
| 数据仓库 | MEMORY、BOARD、tasks、inbox、wiki、报告和 Git 历史 |
| DSH 工作区（dev 已登记） | Harness 原生实体，引用数据目录；目录存在不代表实体已登记 |
| 主 Session（dev 已创建） | MBot 管理上下文和准入的默认 Chief 交互会话；稳定 ID，多窗口共用；可有隔离的其他 conversation |
| 运行 Session | 0.1 run/tick/dream 每次新建的 headless 会话，与主 Session 区分 |

dev 的实例登记使用 Config.registry 的单个 volatile 文档，保存 schemaVersion、revision、selectedBotId 和少量 Bot 配置/引用；不复制 DSH 事件或工作区完整状态。由官方 ConfigEditor 按 profile 原子保存，普通 schema 可导出，Host 初次加载和保存前校验跨记录唯一性/引用。导入先 lint/boot 并 canonicalize 路径，保留原数据和历史；命令为 list/import/select，详见 [实例登记](bot-instances.md)。任务与记忆仍在原 Git 仓库。

## 4. 工程与数据布局

| 路径 | 职责 |
|---|---|
| plugin/index.js | mbot 服务、volatile workspace、受管理子进程、初始化与配置保存 |
| plugin/client.js | DSH lazy-CJS 浏览器入口；命令活动贡献，复用原生卡片 |
| plugin/turn.js、bin/mbot-turn、lib/permit.sh、lib/turn*.sh | dev 的 Host turn 事务桥与数据恢复：快照/锁/许可/审计、写者核实和准确 commit 识别；前台/原生 Worker 恢复已接入，其他写者与睡眠维护待完成 |
| plugin/binding.js | dev 的官方实体创建/修复、持久预留与只读主会话打开 |
| plugin/runtime.js、context.js | dev 的真实 Agent 上下文/前台工具/结束闸门；主 Session 实体已接入，scoped botctl Worker/恢复已接入，消息域与其他生命周期待完成 |
| plugin/messages.js | dev 的所有者私聊信封与原生日志请求投影；模型消费仍归 DSH Inbox，不另建队列 |
| plugin/ipc.js、ipc-protocol.js、bin/botctl-host.mjs | dev 的本地所有者 CLI/profile 私有 socket，端点归属/断连/关闭 drain；不复制模型队列 |
| plugin/tools.js、commands.js、*.d.ts | 模型工具、人类命令和公开 API |
| bin/mbot、bin/botctl、lib/ | 配置、事务、lint、运行、渲染、guard、Dreaming、调度、备份 |
| templates/workspace/ | 新仓库模板；gitignore 在 init 时生成 .gitignore |
| prompts/、patches/ | tick/Dreaming 指令、模型/Worker 能力覆盖 |
| ops/、cron/ | 人类/cron 运维入口，不自动部署 |
| tests/ | Bash、Cordis、真实安装与 API 验收 |
| AGENTS.md | 框架维护约定，区别于模板中的运行期协议 |

数据仓库包括 AGENTS.md、MEMORY.md、BOARD.md、bots/<role>/{SOUL,MEMORY}.md、tasks、inbox、wiki、transcripts、dream-reports 与 .mbot。config 入库，锁、PAUSED、失败计数、原始日志忽略；凭据不入库/包。升级不能重拷模板覆盖用户数据。

## 5. 任务、记忆与归属

| 数据 | 运行期写者/约束 |
|---|---|
| BOARD、tasks | 经 botctl；Chief 管状态，Worker 只处理分配任务 |
| inbox | remember 只追加，保留原字节前缀 |
| MEMORY、已有角色 MEMORY、wiki | 独立 Dreaming；预算/链接校验，删除需逐文件依据 |
| wiki/ops-log.md | 仅人类，Dreaming 也只读 |
| transcripts、报告元数据 | Host 生成，历史材料受保护 |
| AGENTS、SOUL、配置、工具 | 人类维护，运行期不得修改 |

默认 MEMORY ≤150 行且 ≤3000 UTF-8 字符，SOUL ≤5000 字符，wiki 每文件 ≤200 行，BOARD ≤80 行。任务状态 todo/doing/blocked/done，blocked 必须有原因；ID 包括归档任务且不复用，结果追加到固定段。

Chief 先写目标、输入、文件范围、验收，再标 doing/派 Worker。最多同时两个 fresh Worker、深度 1，开启 interrupt_agent，关闭 fork/Agent Teams/workflow 派活。跨运行依赖任务记录，不依赖旧 Worker 名单；done 原样归档，失败回滚。详见 [M4](m4-schedule.md)。

## 6. 现有运行与 Dreaming

### 6.1 受控运行

run/tick/dream 检查嵌套、PAUSED、全局 flock、干净工作树，捕获 HEAD/文件基准后调用 headless。任务修改经 botctl 锁；Host 收集 NDJSON、恢复越权/非追加变化、校验看板、生成脱敏 transcript/meta，统一提交。

运行上下文按 SOUL、共享/私有 MEMORY、看板、任务和本次请求组装。headless 使用 workspace-write/never 与框架 overlay；metadata 的 token 只统计顶层流，不宣称包含 Worker 总成本。

成功要求 DSH 退出 0、末事件 final、reason.kind=completed、无违规。模型失败保留审计与合法产出，三次失败熔断；HEAD/控制路径异常立即暂停。Git 元数据不可用保留原始证据；commit 失败保留现场并暂停。原始流在验收后归档，不属于脱敏输出。

native botctl 的 Host 操作要求完整权限或一次 DSH 审批，不扩大 Session 权限。受控 run 内禁止原生工具与 /mbot 绕过 Bash guard。服务 argv 不经 shell，捕获一次 workspace，传递取消，卸载时终止并等待进程。详见 [M2](m2-run.md)、[插件验收](plugin.md)。

### 6.2 Dreaming

remember 追加候选，独立 Dreaming 执行 Analyze → Merge → Rewrite → Report。输入优先 inbox，再 transcript/归档任务，按完整 UTF-8 行限制新材料字节数。成功 checkpoint 保存 blob/offset/pending，下一次续读，失败不推进；替换/重命名按当前版本处理，不复活删除材料。

只接受允许的记忆/本次报告改动；lint、链接、删除依据或模型失败，恢复全部记忆，仅提交 dream(failed) 报告；成功提交 dream。git revert 恢复记忆/checkpoint。单行放不进预算时保留进度并失败，不调用模型。详见 [M3](m3-dream.md)。

### 6.3 配置与运维

独立 Bash 目录优先级：-C → MBOT_WS → XDG 用户配置 → ~/.mbot-ws。0.1 原生服务使用非空 Cordis workspace，否则回退这些来源。显式 /mbot init <path> 成功后通过 ConfigEditor 保存实际目录；独立 CLI init 不保存 profile 选择。

.mbot/config 静态读取，不 source/插值，环境优先。grants 是物理绝对目录的冒号列表，仅 run/tick 使用，拒绝保护目录、别名、空项、重复项。默认超时 300 秒，新材料预算 64000 字节。

cron 每两小时 tick，03:17 archive 成功后接 dream。锁忙/暂停/空闲可能退出 0，需核对报告；日志在数据仓库外。备份默认关闭，只推既有 upstream，拒绝/超时保留本地成功；clone 恢复在 /tmp 清空 grants/推送后做只读冷启动。7 天观察未完成。详见 [M5](m5-ops.md)。

## 7. 已实现：聊天区反馈与目录选择

控制结果在发起 Session 的聊天区显示开始、成功、失败、跳过、取消，init 包含实际目录、选择结果和下一步。默认复用 CommandResult 与持久命令事件，不伪造 assistant 回复、不触发模型，不把全部 status/日志塞进模型 role content。

UI 可见、Session 事件持久化、模型可见是不同问题。Chief 确需消费结果时，选择性注入业务摘要或让它读任务；展示层不决定长期记忆。按命令身份关联结果，避免 flow、通知、卡片重复。

根因是 DSH 0.2.2-rc.5 的 Chat activity predicate 排除了普通 command 节点，新会话因此保留 Hero 空白页。最小 client 在独立活动 target 上识别 /mbot command/run 并激活对应 Conversation，原生 Chat 是唯一卡片写者；既有历史重放后也可见，不修改 DSH 核心或模型历史。

Host 串行初始化，通过 ConfigEditor 原子保存 canonical directory；保存时核对调用前的 workspace 值，保留并发的新选择。缺少 profile 保存能力时创建前报错；初始化失败保留旧选择，仓库创建后保存失败明确报告部分成功。每次业务操作仍捕获一次 workspace，在途操作不被重定向。真实 tarball 浏览器验收覆盖命令显示、错误/跳过、多标签页、刷新与重启；取消由 commands.execute/AbortSignal 验证。

## 8. dev：创建与主 Session

Web profile 的插件 /mbot init 已接入以下流程，详见 [主会话](main-session.md)：

1. 校验数据路径/实例身份，识别新建或导入，初始化/校验 Git 仓库。
2. 通过 DSH 原生能力登记工作区，创建或恢复 Chief 主 Session。
3. 保存 botId/workspaceId/mainSessionId 绑定和当前选择。
4. 在发起 Session 显示结果，默认打开主 Session，保留旧会话；不以跳转掩盖失败。

跨文件、Git 与 DSH 实体没有单一事务，须定义阶段状态/补偿：重试去重、部分成功可修复，不删除用户已有仓库/Session；基础 headless profile 缺少 DSH Controller 时只登记身份并明确提示；open/repair 要求原生能力，不留下虚假绑定。创建不调用模型。CLI init 保留独立行为。

主 Session 的目标是受插件管理的真实交互会话：按版本组合 SOUL、MEMORY、近期摘要/原始尾部与本次请求，配合 compact 和睡眠。DSH 持有 Session 日志/Inbox/Agent，MBot Runtime 持有业务上下文、准入、来源和写事务；启用业务对话前接入每轮基准、锁、guard 与审计，不再以长期“只读入口”作为目标。0.1 headless 入口保留兼容，Worker/Dreaming 不复用主 Session。详见 [Session Runtime](session-runtime.md)。

dev 已实现 [turn 事务桥](turn-transactions.md) 与数据恢复，并通过 [真实 Agent Runtime](native-runtime.md) 将租约接到 system-prompt/assemble waterfall，在返回提示前重建固定上下文；pre-step 再核实最终提示并用公开 surface replacement 退役旧快照。前台工具、取消、结束审计及下一轮闸门已验收；[聊天区审计卡片与 runtime/stop](runtime-feedback.md) 进一步区分 Agent 空闲和 Host 完成，验证原生停止保留队列。规范化 [turn outcome](turn-outcomes.md) 区分用户取消与故障，并在 Git 结算/恢复时使用相同规则。dev 的 [所有者准入](message-admission.md) 已接入 Host 门面、原生 Web/steer 请求关联、来源与持久化闸门、日志去重及投递收据；[本地 CLI IPC](host-ipc.md) 将外部 botctl 接到同一 Runtime，提供 profile 私有端点、所有者身份、断连与重载去重。[请求结果](request-replies.md) 已核验原生事件/Git/journal 并查回固定回复信封；dev 已接入 [前台 Runtime/Agent 中断恢复](runtime-recovery.md)，复用原生 resume closers、独占 Session writer、Bot 闸门和 Git/原生审计证明；核心只读旧回合已接入 [迁移证明](legacy-migration.md)；[scoped botctl Worker 恢复](worker-recovery.md) 已接入；Worker 其他工具、后台/IPC 写者、非只读/未知旧契约与缺失原生日志的恢复，以及 IM/peer、outbox、手动 compact/睡眠维护仍待完成。

UI、IM、CLI 和跨 Bot 消息共用 botctl 门面/Runtime；运行内数据工具凭当前运行权限直接执行事务，不能再次等待同一会话 FIFO。主会话默认私人对话域，群聊/不同主体可用隔离 conversation；同一所有者的专用 TG 私聊可绑定主会话。上下文、消息路由、多窗口并发与睡眠 checkpoint 的完整边界见上述设计。

botctl 统一的是服务协议；Web 保留原生提交并经过 Runtime 闸门，适配器直接调用 Cordis service，CLI 通过 IPC，不要求所有入口执行 shell。MBot 只管理绑定的 Bot Session。近期摘要由 Runtime 决定取材/来源，由 DSH 原生 compaction 写入 surface；checkpoint 联合绑定 Git 知识版本、原生来源 cut 和维护阶段，不复制原生历史/消费队列。独立 Bot 默认使用 peer 对话域及异步回复，进入私人主 Session 需显式授权；树内 send_message 仅用于 Worker。

接下来先交付 checkpoint/compact，再交付睡眠/唤醒，随后扩展对话域与 IM/peer/outbox，最后扩展 Worker Bash/文件/PTC 写工具。知识内容 hash 区分人格/记忆更新与普通任务 Git 提交；每轮 Snapshot 固定，checkpoint epoch 只在成功发布时推进。详细恢复和来源规则见 [Session Runtime](session-runtime.md)。

dev 已接入 [turn 上下文 checkpoint 基础](context-checkpoints.md)：知识 Git blob/hash、epoch、有序原生 surface 来源与 Inbox 输入 hash 在模型执行前捕获，同一次 Git 审计封存，结算/flush 后发布；原生 resume、Runtime 交接与 recover 联合核验。后续 [受管理自动摘要](managed-compaction.md) 已接入真实原生自动 compaction，辅助请求不复制人格/记忆，摘要绑定原生来源与知识版本，Git/journal/flush 中断恢复不重复模型或 replacement。手动 compact、普通 turn 的旧摘要退役与睡眠继续在阶段 1/2。

dev 已支持 [显式注销与持久 Session 退役](bot-removal.md)：独立 Bot 身份不随原生工作区删除；注销持有数据锁及可回退的准入闸门，ConfigEditor 保存活动登记到不可变 retiredBots 后撤销入口。旧主/预留 Session 在重启时继续受闸门约束，数据、历史、Inbox 与 journal 保留。重新导入创建新身份；未完成的执行/审计先 stop 收尾，注销不等于恢复。登记文档 v2 兼容 v1 读取，禁止配置重置丢弃既有 Session 归属。

当前选择优先服从显式 botId、调用 Session 的已存绑定、profile 的 selectedBotId，再回退旧 workspace；导入不自动切换默认项，init 成功会选择新 Bot。Bash CLI 保留自身目录来源。实际 Session 绑定已接入；对话域、迁移与完整生命周期仍在 P1 完成。全局选择不能重定向已绑定会话；缺失/归档 Session 可见并可修复，wake 走 resolve/resume，不反复 create。重启不销毁数据，clone 可重建 DSH 绑定。

dev 已交付 [Worker 数据许可](worker-leases.md)：父 turn 可预留角色/任务/子 Session 身份，派生数据许可和固定快照，共享一次 Git 结算。普通前台仍写 journal v2；委派契约使用 v3，其他 writer 的恢复不沿用原契约。[原生 Worker](native-workers.md) 已在该许可上接入 fresh Agent、固定角色上下文、scoped botctl、并发/取消和父审计，scoped botctl 已支持 [v3 恢复、provider 替换与实际 Runtime 模块交接](worker-recovery.md)，默认开启。恢复保留原 journal/子事件，单独派生已核验的 Actor 结算输入，不创建子模型；Bash/文件/PTC、未知写者/缺失日志与其他生命周期继续在 P1。

dev 已接齐 [Runtime 模块交接](runtime-handoff.md)：Agent 持有一次注册的闸门，版本化共享 cell 把执行交给当前模块；等待旧前台写者/审计/消息持久化，整组 attachment 成功后才 ready。失败审计与退役归属保留，原生 Inbox 和主 Session 稳定。共享 registry 之前旧闸门的支持迁移、其他插件/后台写者及真实旧 Host 续聊继续验收。

## 9. 下一轮：设置与管理面板

新增浏览器 half：声明 dsh.client、./client，提供 DSH 可加载的 lazy-CJS factory bundle，附着 bare dsh-mbot 根行。Host 不导入浏览器代码，headless 不要求 UI；包须带构建产物，源码/安装的构建约定重新验收。

通过官方 Plugins/Settings 扩展注册 MBot 页面。Host 持有实例 CRUD、绑定、路径/权限/版本校验与保存，浏览器只走支持的远程协议，不执行 Bash、直接改配置或读凭据。关闭/卸载/重连清理注册和订阅。

面板展示实例、目录、主 Session、角色、看板/预算/PAUSED/最近报告，并支持创建/导入/选择/打开/修复/注销及已支持的配置编辑。插件默认项走 ConfigEditor/form revision；数据配置走静态校验/human Git 事务；DSH 原生实体由官方服务持有，不重复维护值。无效/并发/保存失败不改变有效配置，key 只使用引用。

真实 GUI 的创建、保存、重启、多实例切换、开关/卸载是验收条件；schema、组件、接口检查不能替代完整用户流程。

## 10. 升级、发布与证据

0.1.1 已修交互缺陷，0.2.0 增加实例和管理产品。新登记带 schemaVersion，导入先验证再迁移，模板采用差异合并，不 reset/re-init 用户数据。保留 Bash、模型工具、headless、源码/tarball 安装兼容矩阵。

0.1 保留公开类型、11 项 Cordis、64 组 Bash 和真实模型的历史验收；0.1.1 新增 commands.execute 与浏览器验收，见 [P0](p0-feedback.md)；dev 的 Runtime 审计/停止新增真实模型适配器与浏览器流程，见 [反馈](runtime-feedback.md)。dev 主 Session 已补齐实体与导航；完整生命周期/面板仍待实现。依据见 [M0](m0-spike.md)、[M2](m2-run.md)、[M3](m3-dream.md)、[M4](m4-schedule.md)、[M5](m5-ops.md)、[plugin](plugin.md)。

包版本为 0.1.1，具体发布标签在验收通过的提交上创建，以 Git refs 为准；不将它固定绑定到某个实现提交。完整版本 tag 有利于索引发现；GitHub Release/Actions 非必需。每阶段同步 TODO、发布说明与 README，按 [AGENTS](../AGENTS.md) 提交。
