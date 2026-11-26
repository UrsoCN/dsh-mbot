# dsh-mbot：0.1 基线与 0.2 迭代设计

当前包版本 0.1.0，首版能力以 0.1 命名；发布 tag 推荐采用 v0.1.0，与分支区分，状态见 [发布检查](plugin-standard-review.md)。本文件区分已实现的 Host/事务核心与计划中的交互产品；完成记录见 [RELEASE_NOTE](RELEASE_NOTE.md)，执行顺序见 [TODO](../TODO.md)。本地安装反馈是下一轮输入，聊天区与面板必须以真实界面验收。

## 1. 当前能力与缺口

| 已实现的 0.1 | 尚未实现/待修复 |
|---|---|
| 可安装 Cordis bundle、原生 botctl、/mbot handler、Config schema | 实际界面 init/status 反馈不可见问题 |
| 独立 Markdown/Git 数据仓库、Bash 事务与护栏 | init 显式目录不会自动成为后续选择 |
| 每次独立 headless Chief、fresh Worker、独立 Dreaming | Bot 实例登记、DSH 工作区登记、持久主 Session |
| volatile workspace 的 Host 校验与更新 | 自有设置/管理面板及浏览器入口 |
| cron、备份、恢复、人工观察工具 | 连续 7 天调度验收 |

DSH CommandResult 支持将结果保存在 command/run、command/done，客户端可在模型历史之外展示。当前界面为何没显示仍须复现追踪，不能由直接 handler 测试推断 UI 可用。schema 能导出也不代表面板已注册。

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
| Bot 实例（计划） | 稳定 botId、名称、独立数据目录、DSH 工作区与 Chief 主 Session 的绑定 |
| 角色 | 实例内 chief/coder 和自定义 SOUL/MEMORY；不等于管理列表中的 Bot 实例 |
| 数据仓库 | MEMORY、BOARD、tasks、inbox、wiki、报告和 Git 历史 |
| DSH 工作区（计划登记） | Harness 原生实体，引用数据目录；目录存在不代表实体已登记 |
| 主 Session（计划） | 每个实例唯一默认的 Chief 交互入口，可关闭、恢复、修复绑定；不是唯一记忆源 |
| 运行 Session | 0.1 run/tick/dream 每次新建的 headless 会话，与主 Session 区分 |

实例登记只保存少量配置与引用，如 botId、workspacePath、workspaceId、mainSessionId、createdAt、schemaVersion；不复制 Session 事件或工作区完整状态。按 profile 隔离，优先核实官方持久化能力；需要轻量 JSON 时采用版本标记与原子写入，不引入新数据库。任务与记忆仍在原 Git 仓库。

## 4. 工程与数据布局

| 路径 | 职责 |
|---|---|
| plugin/index.js | mbot 服务、volatile workspace、受管理子进程 |
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

独立 Bash 目录优先级：-C → MBOT_WS → XDG 用户配置 → ~/.mbot-ws。0.1 原生服务使用非空 Cordis workspace，否则回退这些来源。显式 /mbot init <path> 只影响该次初始化，这是 P0 体验问题。

.mbot/config 静态读取，不 source/插值，环境优先。grants 是物理绝对目录的冒号列表，仅 run/tick 使用，拒绝保护目录、别名、空项、重复项。默认超时 300 秒，新材料预算 64000 字节。

cron 每两小时 tick，03:17 archive 成功后接 dream。锁忙/暂停/空闲可能退出 0，需核对报告；日志在数据仓库外。备份默认关闭，只推既有 upstream，拒绝/超时保留本地成功；clone 恢复在 /tmp 清空 grants/推送后做只读冷启动。7 天观察未完成。详见 [M5](m5-ops.md)。

## 7. 下一轮：聊天区反馈

控制结果在发起 Session 的聊天区显示开始、成功、失败、跳过、取消，包含目录、选择和操作链接。默认复用 CommandResult 与持久命令事件，不伪造 assistant 回复、不触发模型，不把全部 status/日志塞进模型 role content。

UI 可见、Session 事件持久化、模型可见是不同问题。Chief 确需消费结果时，选择性注入业务摘要或让它读任务；展示层不决定长期记忆。按命令身份关联结果，避免 flow、通知、卡片重复。

复现需覆盖 commands.execute、事件传播、projection/flow、renderer、重连/重启。Host handler 有 text，但用户看不到结果，根因未确认；直接 handler/无界面验收不能关闭问题。

## 8. 下一轮：创建与主 Session

插件 /mbot init 的目标流程：

1. 校验数据路径/实例身份，识别新建或导入，初始化/校验 Git 仓库。
2. 通过 DSH 原生能力登记工作区，创建或恢复 Chief 主 Session。
3. 保存 botId/workspaceId/mainSessionId 绑定和当前选择。
4. 在发起 Session 显示结果，默认打开主 Session，保留旧会话；不以跳转掩盖失败。

跨文件、Git 与 DSH 实体没有单一事务，须定义阶段状态/补偿：重试去重、部分成功可修复，不删除用户已有仓库/Session；缺失 DSH 能力先报错，不留下虚假绑定。创建不调用模型。CLI init 保留独立行为。

主 Session 初期为只读 Chief 交互入口，读 SOUL/MEMORY/看板，业务执行仍委托有 guard 的 headless run。直接执行任务需另行接入每轮基准、锁、权限、验收与审计；不能为续聊绕过记忆规则。Worker/Dreaming 不复用主 Session。

选择优先服从显式实例与调用 Session 绑定，再用调用方选择/profile 默认；旧 workspace 为兼容来源。具体 API/语法和迁移在 P1 定稿。全局选择不能重定向 A/B 已绑定会话；缺失/归档 Session 可见并可修复。重启不销毁数据，clone 可重建 DSH 绑定。

## 9. 下一轮：设置与管理面板

新增浏览器 half：声明 dsh.client、./client，提供 DSH 可加载的 lazy-CJS factory bundle，附着 bare dsh-mbot 根行。Host 不导入浏览器代码，headless 不要求 UI；包须带构建产物，源码/安装的构建约定重新验收。

通过官方 Plugins/Settings 扩展注册 MBot 页面。Host 持有实例 CRUD、绑定、路径/权限/版本校验与保存，浏览器只走支持的远程协议，不执行 Bash、直接改配置或读凭据。关闭/卸载/重连清理注册和订阅。

面板展示实例、目录、主 Session、角色、看板/预算/PAUSED/最近报告，并支持创建/导入/选择/打开/修复及已支持的配置编辑。插件默认项走 ConfigEditor/form revision；数据配置走静态校验/human Git 事务；DSH 原生实体由官方服务持有，不重复维护值。无效/并发/保存失败不改变有效配置，key 只使用引用。

真实 GUI 的创建、保存、重启、多实例切换、开关/卸载是验收条件；schema、组件、接口检查不能替代完整用户流程。

## 10. 升级、发布与证据

0.1.1 修交互缺陷，0.2.0 增加实例和管理产品。新登记带 schemaVersion，导入先验证再迁移，模板采用差异合并，不 reset/re-init 用户数据。保留 Bash、模型工具、headless、源码/tarball 安装兼容矩阵。

0.1 已有公开类型、11 项 Cordis、64 组 Bash 检查，两种真实安装/API 验收；界面反馈和面板未被证明。依据见 [M0](m0-spike.md)、[M2](m2-run.md)、[M3](m3-dream.md)、[M4](m4-schedule.md)、[M5](m5-ops.md)、[plugin](plugin.md)。

包版本为 0.1.0，具体发布标签由作者在要发布的提交上创建，以 Git refs 为准；不将它固定绑定到某个实现提交。完整版本 tag 有利于索引发现；GitHub Release/Actions 非必需。每阶段同步 TODO、发布说明与 README，按 [AGENTS](../AGENTS.md) 提交。
