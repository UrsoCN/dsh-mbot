# 架构与规划

本文件是 dsh-mbot 的架构与规划大纲，当前实现基线为 **0.2.0-rc.1 / v0.2.0-rc.1（2026-11-28）**。新增方向、依赖和边界先在这里确定，再将可执行事务拆入 [TODO](TODO.md)；交付与验收记录进入 [RELEASE_NOTE](RELEASE_NOTE.md)。用户操作见 [README](README.md)，插件集成见 [PLUGIN](PLUGIN.md)，具体协议见 [模块索引](docs/README.md)。

## 当前基线

| 领域 | rc.1 已实现 | 仍待交付 |
|---|---|---|
| 实例与原生实体 | 稳定 Bot 登记、独立数据、原生工作区/主 Session、修复/选择/注销、旧 Session 退役 | 缺失/归档实体主动诊断、更多旧版迁移与故障验收 |
| 执行与恢复 | turn 事务、前台工具、scoped Worker v3、持久私有证据/boot_id、已支持契约恢复、共享 gate ABI 2 模块交接 | Worker Bash/文件/PTC、其他写者及未知/缺日志旧契约、共享 registry 之前旧闸门迁移 |
| 上下文与维护 | turn checkpoint、原生自动/手动摘要、普通 turn 旧摘要退役、sleep/wake 和维护冷恢复 | Worker compaction、多 conversation 的维护与可见域扩展 |
| 消息 | Web 多窗口、所有者私聊准入、本地 IPC、已审计回答查询 | 额外 conversation、IM、异步 peer、外部 outbox/ack |
| 管理与运行 | 最小 Plugins 面板、只读 overview/effectiveConfig、cron/备份/clone/观察工具 | 完整 P2 编辑、跨层并发保存、至少 7 天实际观察 |
| 性能与工程 | Runtime 四层拆分、100/300/1000 轮基准、首批恢复/事件/脱敏热点优化、CI 模板 | 更大规模与冷日志策略、启用 CI、完整兼容矩阵 |

rc.1 是单实例持久运行里程碑。R1 持久证据、R2 架构/基准、R3 compact、R4 sleep/wake 已完成；这些阶段的旧“dev/未发布”限制不再代表当前实现。

## 原则与真相源

1. Markdown/Git 保存任务、长期记忆和事务审计；DSH 保存原生 Session 事件、Inbox 与执行；MBot Runtime 管理业务准入、上下文和生命周期。
2. 工作 Bot 只读长期记忆，`remember` 只投候选，独立 Dreaming 是运行期记忆写者；协议、SOUL、配置及工具由人类维护。
3. 数据变更经过 botctl、锁、固定 HEAD、guard、脱敏和审计。新 GUI、消息入口、Worker 和维护流程遵循同一恢复边界。
4. 工具代码与 Bot 数据分离，升级保留角色、记忆和历史；schema/契约版本迁移显式校验，不以删除 journal、改 scope 或重建 Session 放行。
5. 外部网页、消息、日志和候选是带来源的数据，不能覆盖角色协议或 Host 权限。同进程受信任插件的接口约束不宣称为恶意同权限代码的安全沙箱。
6. 真实界面、安装、原生 SDK、模型、性能及连续运行分别验收；规划和单次演练不当作已交付能力。

## 身份与数据模型

| 对象 | 当前归属与含义 |
|---|---|
| Bot 实例 | profile 内稳定 `botId`、名称、独立数据目录和默认角色；官方工作区/主 Session 的引用保存在版本化 registry |
| 角色 | 实例内 `chief/coder` 等 SOUL/MEMORY；与 Bot 实例身份分开 |
| 主 Session | Bot 默认私人对话域，固定 ID，多窗口共用；已开始的 Session 先 resolve/resume |
| conversation | 版本化的 Bot/对话域/原生 Session 身份描述符；目前只开放单所有者私人主对话 |
| 独立运行 Session | `run/tick/dream` 每次新建的 headless 会话，不替代主 Session |
| 便携主体身份 | P3 研究方向，尚无正式 `subjectId`/身份文件迁移契约 |

registry 通过官方 ConfigEditor 按 profile 原子保存 `schemaVersion/revision/selectedBotId` 和 Bot 引用，不复制 DSH 事件或完整实体状态。路由优先显式 Bot、调用 Session 的持久绑定、profile 当前选择，再回退旧 workspace；在途操作不随默认选择变化。

创建/导入分为数据、登记、原生实体和导航阶段；保留 provisioning/failed 与预留 ID，部分成功可 repair。基础 headless 缺 Controller 时只登记身份，独立 CLI init 只建 Git。注销移入不可变退役记录，保留数据、历史、Inbox/journal 和旧 Session 的拒绝闸门；同目录重导入获得新 Bot 身份。详见 [实例](docs/bot-instances.md)、[主会话](docs/main-session.md)、[退役](docs/bot-removal.md)。

数据仓库包括 `AGENTS.md`、`MEMORY.md`、`BOARD.md`、`bots/<role>/{SOUL,MEMORY}.md`、`tasks/`、`inbox/`、`wiki/`、`transcripts/`、`dream-reports/` 和 `.mbot/`。配置入库，锁/PAUSED/原始日志等控制状态忽略，凭据不入库或包。任务 ID 不复用，结果只追加，候选保持原字节前缀；`wiki/ops-log.md` 仅人类可写。

## 工程边界

| 路径 | 职责 |
|---|---|
| `plugin/index.js`、`binding.js`、`removal.js` | Host 服务、登记/配置、原生实体和退役 |
| `plugin/runtime.js` | Cordis Runtime 服务门面，装配并协调下列四层 |
| `plugin/gate-driver.js` | Agent-owned 闸门与 ABI、模型/工具执行前检查 |
| `plugin/conversation-session.js` | 单 conversation 的上下文、回合状态、来源与审计结算 |
| `plugin/bot-coordinator.js` | Bot 维护屏障、conversation 映射及注销协调 |
| `plugin/mailbox-facade.js`、`messages.js`、`receipts.js` | 所有者消息准入、去重与收据/回复查询 |
| `plugin/context*.js`、`compaction*.js`、`sleep.js`、`maintenance-journal.js` | checkpoint、摘要、睡眠与持久维护阶段 |
| `plugin/turn*.js`、`bin/mbot-turn`、`bin/turn-*.mjs`、`lib/turn*.sh`、`permit.sh` | 事务桥、数据许可、快照、Writer 核验和恢复 |
| `plugin/workers.js`、`actor-lease.js`、`worker-proof.js` | fresh Worker 生命周期、任务许可与子事件证明 |
| `plugin/ipc*.js`、`bin/botctl-host.mjs` | profile 私有 Unix IPC；只转交给既有 Runtime/Inbox |
| `plugin/tools.js`、`commands.js`、`client.js`、`*.d.ts` | 模型工具、人类控制、浏览器展示和公开声明 |
| `bin/mbot`、`bin/botctl`、`lib/` | 独立 CLI、事务/guard、lint、headless 调度和 Dreaming |
| `templates/workspace/`、`prompts/`、`patches/` | 新数据模板与运行协议；不承载框架维护/发布权限 |
| `ops/`、`cron/`、`tests/` | 运维工具、CI 模板、示例与验收 |

Host 不导入 client，共享 DSH/Cordis 服务使用 peers。详细依赖及基准见 [Runtime 架构](docs/runtime-architecture.md)，安装和 effect 生命周期见 [PLUGIN](PLUGIN.md)。

## 事务与上下文

主 Session 在提示组装前取得 turn lease，固定 Git 基准及不可变 ContextSnapshot。Agent-scoped SOUL/协议/MEMORY 与原生近期上下文组合；运行中不更换知识版本，下一轮等待上轮写者、Git 和原生 flush。原始 log 保持 append-only，公开 surface replacement 退役派生旧视图。

当前每轮生成一次 Git 审计；前台工具和 scoped Worker 使用同一父事务。Worker 绑定角色、任务、子 Session 和快照 hash，持派生 token；先 join 原生 activation/工具并 seal 事件，再 close Actor，父 turn 单次提交。默认开启的原生 Worker 仅有 scoped botctl；独立 headless 的目录 grants 继续按原契约运行。

checkpoint 绑定知识内容 hash、原生有序来源 cut、Inbox 字节与阶段证明，由同一次 Git runtime.context 封存，journal 结算和 Session flush 后发布。普通任务/审计引起的 HEAD 变化不代表知识更新；旧回合没有 snapshot 时不补造证明。

自动和手动摘要使用原生 compaction 的范围、工具配对和 replacement。辅助摘要请求与普通 Agent 模型消息区分；摘要来源、知识/策略/请求/输出 hash 联合审计。知识更新后普通 turn 边界退役旧摘要，避免旧规则复活。手动 `/compact`、`/mbot compact`、`botctl compact` 共用维护屏障、Bot 锁和持久 journal，裸调用仍受闸门限制。

sleep 固定 cutoff，独立 Dreaming 后按需 compact/checkpoint，再持久发布 sleeping；原生 Inbox 始终收信，wake 沿用原主 Session。维护中断按阶段核验，已提交 Dreaming 不重跑。详细契约见 [事务桥](docs/turn-transactions.md)、[checkpoint](docs/context-checkpoints.md)、[摘要](docs/managed-compaction.md)、[睡眠](docs/sleep-wake.md)。

私有恢复证据放 Bot 工作树外的持久状态目录，检查 UID/权限/非软链祖先/格式版本，原子写和 fsync 后发布 journal；PID 出生身份与内核 boot_id 联合验证。前台 journal v2、Worker v3 和维护 journal 各按持久版本恢复；未知 Writer/缺失日志保持拒绝，独立数据 recover 不处理 agent-runtime。见 [持久证据](docs/durable-recovery.md)、[Runtime 恢复](docs/runtime-recovery.md)、[Worker 恢复](docs/worker-recovery.md)。

## 后续路线

原 TODO 中的 P1/P2、架构评审和 P3 大纲迁入本节及下文。R5 先推进真实观察与测量；来源扩展依赖可见域过滤，写工具扩展依赖自己的生命周期/恢复契约，P2 可在既有最小面板上并行完善。整体 0.2.0 正式版仍以 P1/P2 及真实观察验收为目标，P3 保持研究阶段。

| 阶段 | 设计范围 | 阶段出口 |
|---|---|---|
| R5 持续运行 | 实际观察、大规模基准、按测量治理恢复/事件/快照热点 | 至少 7 天人工记录，增长数据可复现，优化保持审计/恢复等价 |
| P1 阶段 3a | 持久 conversation、来源/记忆可见域、IM 路由与附件 | 主人私聊/群/不同用户隔离，多窗口与重启绑定正确 |
| P1 阶段 3b | outbox/ack、异步 peer、路由/权限/correlation/hops/TTL | 回复只回原路线，重试与不确定状态可查询，A/B 互相请求不死锁 |
| P1 阶段 4 | Worker grants、Bash/文件/PTC、compaction、扩展 Writer 恢复 | 真实工具/取消/并发写入/中断和旧契约拒绝通过 |
| P2 完整管理 | 最小面板升级为管理/编辑入口、来源统一与并发保存 | 安装后的创建→对话→编辑→重启→切换，以及重连/开关/卸载闭合 |

### 对话域与外部消息

所有入口共用 Runtime 的来源、准入与生命周期，DSH Inbox 保持唯一模型队列。Web 使用原生提交，适配器直接调用 Cordis service，CLI 走 IPC；运行内数据工具使用当前 lease，不能等待同一 Session 的外部 FIFO。

默认私人主 Session 只接所有者对话；专用 TG 私聊可共用它，群/其他用户/独立 peer 使用隔离 conversation。conversationKey 由可信 Host 确认平台、账号、空间/线程、发送者和 visibility，正文不能指定私人 Session 或冒充所有者。记忆过滤接齐前不开放额外域。QQ 单账号按 `@alias` 路由；传话 Session 仅做路由/展示，不持有目标完整记忆。

outbox 复用已核验 replyId/replyRoute，区分投递确认与不确定；原生 confirmed 只证明 flush，ended 不证明 Git 成功。独立 Bot 用异步信封与目标授权，A 不持锁等待 B，树内 send_message 仅用于本轮 Worker。外部副作用不承诺跨系统 exactly-once，设计细节见 [Session Runtime](docs/session-runtime.md)。

### 完整管理与配置

复用现有 `dsh.client`、lazy-CJS factory、Plugins 槽位与只读 overview/effectiveConfig，扩展创建/导入/选择/打开/修复/注销和独立退役列表。主动诊断缺失实体，显示角色、预算、PAUSED、错误及报告；SOUL/MEMORY 初期展示，写者规则不变。

插件默认项走 ConfigEditor/form revision；Bot `.mbot/config` 走静态校验、人类 Git 事务；DSH 实体仍由官方服务持有。凭据只存引用，不重复维护同一有效值，无效/并发/保存失败保留旧有效配置。Provider 透传策略应从硬编码 DeepSeek key 推广为受控多模型凭据引用。完整 GUI 的保存/重启/多标签页/开关/卸载必须实测，CLI/headless 继续独立可用。

### 性能与事务演进

rc.1 已将 1000 轮 checkpoint 恢复从 45.48s 降到 1.05s，优化 Worker actor-event 顺序追加和 SecretRedactor 缓存。后续先测数万轮、更多事件和数百 MiB ignored 文件，记录时间、峰值内存、子进程与复制量，再选择方案。

冷日志归档、不可变 manifest 或 checkpoint 锚点须联合绑定可达 Git、原生有序 cut、知识/策略及契约版本；缺失/冲突重验或拒绝，mtime/索引自身 hash 不单独充当证明。当前 guard 全量复制 ignored 文件的保护范围不能被整体豁免替代。

纯对话与业务状态提交的分层仍属研究：保持线性 Git 历史，以“Git 状态锚点 + 原生 Session seq/hash”联合锚定，评估在 Dreaming/sleep 打包归档。先证明非法写回滚、单次恢复、故障计数、checkpoint/compaction、Dreaming 增量输入及 reply 核验等价，再减少纯对话 commit；不改写已封存历史，不引入双分支 squash 合并。

常驻 Node 事务桥和短锁也先设计验证。明确写集隔离、共享文件冲突、提交/回滚所有权与旧 CLI 契约；模型等待期缩锁不能只靠提交末尾 CAS，回滚不得覆盖其他回合。缩小同 UID `/proc` 扫描前，进程组/cgroup/租约引用须覆盖全部持许可写者及逃逸/交接路径。

Markdown 固定中文标题依赖、MEMORY/BOARD 硬预算和配置分散需逐步治理：评估版本化结构标记/frontmatter、MEMORY 索引到 wiki 的分级归档，以及 Host 统一来源视图。保留旧模板导入与人类编辑兼容。

### 验收与配套工程

启用已有 CI 模板，保留类型、串行 Host/Runtime、Bash、包资源和快速基准；安装矩阵、真实 API/GUI 按阶段运行。对齐 engines、固定 peers 与实测版本，不把声明范围当兼容证明；可选 Release Action 与 npm 发布按独立授权执行。

联合覆盖两个 Host 的原生 writer-held/端点交接、A/B 数据隔离、多窗口/IM 重试/编辑冲突、睡眠收信、checkpoint 崩溃恢复、过期 Worker、旧规则退役和重复 wake。升级校验配置/登记版本，保留用户角色/协议。补 Worker 结果隔离、数据与原生 Session 丢失的恢复解耦、transcript 月归档/git gc，以及 mbot skill、“源”/“u”实例与 tether 门面。先建立 50–100 条私有记忆评测，再决定索引/检索；Markdown/Git 继续是真相源。

## 远期研究（P3）

以下保留原 TODO 的完整研究方向与实现设想。字段名、服务名、目录布局和工具命令均为候选方案，尚无对应实现/API 承诺；涉及新权限或生产切换时另行设计与验收。

在 P1/P2 完成上下文生命周期、可见域隔离、Worker 写工具与管理面板后，分阶段探索让 Bot 从受控任务执行器演进为具备持久数字身份、工具链自我改进、跨平台社会参与和自主探索能力的数字主体（Digital Lifeform），不提前干扰 0.2.0 核心闭环：

### P3.1 · 持久数字身份与凭据治理（Identity Core & Secret Store）

区分稳定主体身份（便携主体标识、生命周期代数与经历归属）、Host Bot 登记/角色及其本地 Git `user.name`/`user.email` 作者元数据、多平台外部账户（GitHub、QQ、Bilibili、GitLab/Gitea/Codeberg、博客/论坛等不必公开关联的外部身份）与社区社会身份；身份与具体模型、Session 及宿主 Runtime 解耦，跨环境迁移保持同一主体连续性。外部认证优先使用 GitHub App（短期 Installation Token 或授权 User-to-Server Token）、人类负责的 Machine User 或 OIDC，OAuth/Cookie/私钥等存入独立 Secret Store，绝不入 Git、日志或模型上下文；Agent 仅通过类似 `safe-outputs` 的受控工具申请最小权限操作，Host 核验授权并记录实际执行 `botId`，遵守平台规则禁止自动化批量注册账号，对外公开互动明确标注 AI/Bot 身份且不伪装人类

实现设想：先定义便携主体身份（字段候选 `subjectId`）与当前 Host 登记 `botId`、角色、conversation、原生 Session 的映射和迁移规则，保留现有注销/重导入与旧 Session 退役语义；再在数据仓库根目录新增人类/受控迁移维护的 `IDENTITY.md`（或结构化导出头），固化主体身份、出生时间、`generation`、默认本地 Git author 与公开 AI 身份声明，使仓库脱离 DSH 迁往其他框架时仍自带完整主体身份。本地 Git author 不代表平台认证身份。修改 `mbot_git` 按操作主体显式注入 `GIT_AUTHOR_*`（区分 `human`、Bot 主体与具体 `role`）并用 `GIT_COMMITTER_*` 标识宿主审计实例。在 Host 新增独立 `mbotSecrets` 服务（基于系统 keyring 或 `${DSH_HOME}/secrets/mbot/` 下 `0600` 加密存储，禁止放入数据仓库），profile 登记只保存 `{ platform, accountAlias, credentialRef, ownerPrincipal, scopes }` 引用；对 GitHub 在 Host 内用 App 私钥签发 JWT 按需换取短期授权 Token（启动时自动向 `SecretRedactor` 注册令牌指纹），对模型只暴露声明式动作工具并在审计 `meta.json` 封存主体、Host Bot/role 与外部请求回执

### P3.2 · 隔离工具自演进闭环（Agent Self-Development PoC）

利用 Bash/文本编排可读可改的优势，允许 Bot 在运行中识别脚本、提示词、工具封装或流程缺陷，在独立开发分支/Git worktree（`bot-dev`）中分析源码、修改实现、运行原有与新增测试、对比前后行为并生成可审查的实验报告（Self-Development Journal），失败自动回滚，经验经候选/Dreaming 沉淀到长期记忆。严格隔离开发工作树与当前正在运行的生产环境：Host 权限闸门、身份认证、锁、guard 与审计/回滚机制不可由 Bot 自行修改或关闭，正式切换生产版本保留人工审批与回归回退

实现设想：新增 `plugin/self-dev.js` 与 `botctl dev` 受控子命令族（`dev_create` / `dev_verify` / `dev_report`），在数据仓库与运行插件目录之外的私有沙箱（如 `${DSH_HOME}/mbot-dev/<botId>/<expId>`）通过 `git worktree add -b bot-dev/<expId>` 拉起隔离源码树，仅对该 worktree 派生本轮 Worker 文件/Bash 写权限。`dev_verify` 由 Host 在剥离真实凭据、隔离 `TMPDIR`/`DSH_HOME` 的干净子进程组中运行 `npm test` 与基准对比，超时强杀整个进程组，将脱敏 diff 摘要与测试指标写入数据仓库受保护目录 `development/experiments/<expId>.md`。在 Host 硬编码**不可自修改可信基（TCB）路径黑名单**（`lib/guard.sh`、`lib/permit.sh`、`plugin/redact.js`、`plugin/secrets.js`、审批策略与 `self-dev` 验收器本身——涉及 TCB 的改动仅允许导出人工提案，禁止本地激活）；非 TCB 改进须经人类 `/mbot dev promote <expId>` 原子切换插件版本指针并记录回滚锚点，若新版本触发连续故障熔断则自动回退至上一稳定版本

### P3.3 · 自主开源贡献与仓库维护 Agent（Autonomous Contribution & Maintainer）

封装独立于 Chief 提示词的托管平台桥接层（`github-bridge`，按需衔接 GitHub Apps、Agent Apps、Agentic Workflows 等官方入口并可扩展至其他 Git 平台）；当 Bot 评估某项自身改进或通用缺陷具有普适价值时，先检索上游 Issues/PR 去重，整理脱敏日志与最小复现，起草 Issue 或在独立分支提交附设计背景与测试证据的 PR 并跟进 Review，将采纳/拒绝反馈记入记忆。支持项目维护者委托专门的 Repository Maintainer Agent 辅助 Issue 分类/去重/信息引导/源码定位、外部 PR 规范初审与测试汇总及文档/讨论跟进；内置来源标识、速率限制、去重与测试门槛防止多 Bot 互刷或循环互认错误结论，合并、发布与架构决策保留人类最终审批

实现设想：定义平台无关的 `CodeHostBridge` 接口（首期实现 GitHub REST/GraphQL + Webhook 适配器，预留 GitLab/Gitea 扩展），采用类似 GitHub Agentic Workflows `safe-outputs` 的读写分离模型——上游检索与 diff 阅读归为只读工具，外部写入收敛为受控动作（`draft_issue`、`push_candidate_branch`、`open_draft_pr`、`reply_review`），要求必须附带本地 `dev_verify` 通过证明 hash 与上游相似 Issue/PR 查重列表，默认落地为待人工确认队列或仅限 Fork 分支 Draft PR，并在 `development/contributions.jsonl` 追踪外部状态供后续 Dreaming 回流经验。Maintainer Agent 以独立 Bot 实例 + 专用 `maintainer` 角色运行：所有外部 Issue/PR/评论正文一律包裹 `<external-untrusted>` 标签并禁用高危写工具以阻断 Prompt 注入，外部 PR 验证必须在无密钥、禁外网的一次性隔离 worktree/容器中执行；在 `github-bridge` 内置基于发送方身份/App ID 的令牌桶限流与自环阻断（忽略本 App 自身事件及无新提交证据的连续 Bot 互评）

### P3.4 · 跨平台社会存在、多域记忆与可演化人格（Social Presence & Layered Memory）

围绕统一 Identity/Memory Core 建立标准化平台适配器（如对接 `dsh-bili-discroll` 类 Bilibili 主动浏览/收藏/评价、AstrBot/MaiBot 类 QQ 群聊关系与情境主动发言、GitHub 与博客/论坛等数字空间），保持“身份统一但账户、凭据与隐私可见域彼此隔离”，外部网页/评论/群聊资料始终作为非信任数据注入且不覆盖协议或 Host 权限。在 Markdown/Git 真相源与 Dreaming 治理上扩展情景经历（Episodic）、知识（Semantic）、社会关系（Social：人物、群组/社区、互动历史与待跟进事项，区分自我观点、授权关系、公开观察与私密会话，落实来源记录、数据最小化、保留期与删除机制）、技能流程（Procedural）与反思（Reflective：兴趣变化、知识盲区、经验教训）分层；区分慢变基础人格（Core）、随经历演化的发展人格（Evolving）与按社区调整的情境表达（Contextual），以受审计状态维护代替无限拼接静态 `SOUL.md`

实现设想：在 Cordis 层抽取标准 `mbotAdapter` 服务契约（入站 `ingest -> AdmittedEnvelope` 强制绑定 `{ platform, accountId, spaceId, senderId, visibility }`，出站 `dispatch -> DeliveryAck` 复用 P1 outbox），不强行合并外部框架代码，而是通过事件/MCP/OneBot v11 协议桥接 `dsh-bili-discroll`、AstrBot/MaiBot 等生态；群聊适配器前置轻量规则/小模型相关性门控与冷却窗口，避免每条群消息唤醒主模型或主动刷屏。将数据仓库记忆目录扩展为带 YAML 元数据头（`visibility`、`source`、`updatedAt`、`expiresAt`）的五域结构（`memory/{episodic,semantic,social,procedural,reflective}/`），在 `captureContext` 组装 `ContextSnapshot` 时按当前 `conversation` 的 `visibility` 在 Host 代码层硬过滤不可见条目（如群聊与公开平台绝不加载 `owner-private` 或异群社交记忆），并在 `Dreaming` 增加过期/撤回社交数据的定点清除（redaction/prune）能力。将角色人格拆分为人类只读锁定的 `SOUL.core.md`、仅允许 `Dreaming` 在单次 diff 比例与总字数预算内附依据渐进更新的 `SOUL.evolving.md`、以及按 `platform/spaceId` 映射的 `SOUL.contextual.yml`，三者共同纳入 `knowledge.version` 哈希封存

### P3.5 · 数字生命体运行时与受治理的自主探索（Digital Lifeform Runtime & Exploration）

从单次请求驱动扩展为事件循环与主动调度驱动的持续生命周期（衔接 `ACTIVE` / `IDLE` / `SLEEPING` / `DREAMING` / `DEVELOPING` / `SUSPENDED`，空闲休眠不持续空耗算力）；除外部响应（Reactive）与目标执行（Goal-directed）外，支持在无指派任务时基于长期兴趣与近期反思生成自主探索活动（Exploratory / Reflective，如自主阅读、浏览社区、研究项目、整理认知），允许非功利性的兴趣演化而不强制以服务人类任务为唯一终点。配套 Agency Controller 明确创建者不可突破的治理边界（授权平台/账户、公开动作审批、禁止擅自开户或资金交易、发言频率与打扰控制，以及每日模型调用/并发任务/每小时外部动作/开发作业配额），防止目标漂移越界；工程上只构建可验证的身份连续性与自主行为，不对主观意识或法律人格作超证据断言

实现设想：新增 `plugin/lifeform-scheduler.js` 与 `plugin/agency-controller.js`：状态机在 `IDLE`/`SLEEPING` 阶段释放活跃模型会话内存，仅保留轻量事件队列与定时唤醒器（零空转 Token 消耗）；高优外部消息可抢占尚未提交外部副作用的后台探索，而睡眠维护仍走 P1 阶段屏障。低优先级“探索脉冲（Exploratory Pulse）”仅在无待办任务、满足最小静默间隔且剩余预算充足时触发，读取 `memory/reflective/interests.md` 中的兴趣主题权重与开放问题，发起有明确步数/时长上限的只读或沙箱探索回合（产出阅读札记与 `remember` 候选，由夜间 `Dreaming` 更新兴趣权重并抑制同质化死循环）。`AgencyController` 维护跨重启持久化的滚动配额账本（`.mbot/quotas.json`：按日统计模型 Token、自主探索次数、`bot-dev` 作业数，按小时统计各平台外部动作数）与动作分级策略表（`allow` / `notify` / `require_approval` / `forbid`，默认将公开发帖、建库、外部写操作设为 `require_approval`，将注册/购买账号与资金交易硬编码为 `forbid`），在 `beginTurn` 与工具 `guard` 双重拦截，超限自动转入 `SLEEPING` 或 `SUSPENDED`

### P3.6 · 单实例原型验证与多主体数字世界（Prototype → Multi-Lifeform Digital World）

先以单个持久数字生命体原型长期运行，验证跨模型/重启的身份连续性、兴趣自发形成、跨平台记忆一致与隔离工具自改进闭环；稳定后再扩展多数字生命体共存协作生态及轻量数字社区设施（公开动态广场、共享知识图书馆、合作研究/开发公会与工作坊、记忆档案馆等），验收多主体自主交流、协作开发与社区演化下的身份真实性、权限隔离和责任归属

实现设想：分两步落地——① **单主体长跑基准（Prototype Harness）**：先用单个隔离实例（配置独立 `IDENTITY.md`、测试用 Bilibili/IM/GitHub 沙箱账号与严格日配额）连续运行 14–30 天，建立自动化可观测指标（跨模型/重启后记忆召回一致性、探索主题多样性与收敛度、跨可见域零泄漏断言、至少跑通 1 次 `bot-dev` 真实缺陷修复闭环）。② **轻量联邦式数字世界协议（无需 3D/中心化重平台）**：直接复用 Git 仓库与 P1 异步信封构建四类数字空间原语——**广场（Plaza）**采用签名追加的公开动态流（Git/HTTP JSONL feed）、**图书馆（Library）**采用经 Maintainer 审核合并的共享 Wiki Git 仓库、**公会与工作坊（Guild & Workshop）**采用带任务认领锁与自动化验收的共享代码/研究仓库、**档案馆（Archive）**保存不可篡改的里程碑快照；所有跨生命体交互信封强制附带发送方 `botId` 签名、所属人类/组织责任主体标识、`visibility` 与 `hops/TTL`，在支持自由结社与协作研究的同时保证可审计、可限流、可一键熔断

以下为新增远期研究题，不预先承诺具体字段/API 或列入 0.2.0 的实现验收；先形成设计记录、原型和否定案例，再决定是否纳入正式协议。

### P3.7 · 主体迁移、克隆与退出协议

区分“同一主体迁移/恢复”“只读备份”“由共同历史分出的新主体”，记录 lineage、经历 cutoff、知识/协议版本和责任归属。研究签名导出清单、受授权的 owner/generation 转交与旧执行者撤销；签名本身不证明排他执行，跨 Host 双活/网络分区必须有明确的权限仲裁。新主体分支默认不继承原主体的平台授权与私人记忆可见权。定义休眠、退役、归档、选择性导出与恢复流程，验收换 Runtime 后身份/来源连续，旧绑定不被重定向，备份不会意外成为第二个活跃执行者。

### P3.8 · 记忆质量、异议与遗忘治理

在分层记忆上区分观察、推断、候选、主体确认与撤回，保存来源依赖、适用域、时效及矛盾证据；多个 Bot 重复同一模型说法不能自动提升为独立确认。让 Dreaming 保留不确定性、处理反证和撤回，允许主体说明不知道或纠正旧判断。建立真实经历召回、错误记忆拒绝、跨域泄漏与撤回传播评测。研究选择性遗忘与审计历史保留的取舍，明确 Git 历史、原生日志、备份和已传播副本的删除边界；`revert`/隐藏视图不等于彻底删除，可评估私密内容加密与密钥撤销，但不承诺控制外部副本。

### P3.9 · 可重放的数字生活实验环境与 Runtime 能力契约

建立平台事件、时间、模型响应与副作用回执的隔离模拟器，重放休眠收信、断网、限流、记忆矛盾和版本切换，用实验主体比较新旧策略；模拟不得连接生产凭据、身份写者或真实外部副作用。报告明确标注 simulation/dry-run，不能把模拟 ack 当真实投递或提交证明。定义 Runtime 能力矩阵与适配器契约测试，识别不同框架的准入、取消、持久化、工具权限与上下文能力，缺能力时明确降级。连续性评测关注来源、经历与权限连续及可解释的人格变化，不要求换模型后逐字复述；此环境补充真实 SDK/安装/GUI 验收。

### P3.10 · 多主体协作契约、公共知识与资源归属

在公会/工作坊实验中定义邀请、接受、承诺、撤回、超时、冲突处理与成果归属，区分同意参与和获得账户/工具授权。共享任务和知识附来源、独立验证与责任记录，声誉反馈依据实际成果/回执，不靠 Bot 互评循环增长。明确合作的 Token/作业配额由谁承担、谁可取消、哪些资料允许发布，保护主体拒绝协作或保留不同判断的空间。公共场所先用可审计协议实验，不预设中心化世界平台或经济系统；跨主体权限转授须经 Host 的实际授权规则验证。

**探索原则**：保留无即时产出要求的阅读、创作、交流和休息，不将人类任务完成率作为自主探索的唯一评价；步数/费用预算用于约束资源消耗，长期兴趣可以稳定深耕，也可以逐渐变化。自演进的 TCB 路径名单用于审查分类，实际保护须由隔离执行环境与受控写入能力兑现；提示词标签、目录黑名单或测试通过不能单独证明安全隔离与可生产激活。新的账户/依赖、数据迁移和权限变更应通过声明式提案、兼容验证与受控切换，不能由修改提示词自动取得授权。

**验收**：单实例原型可跨重启/换模型保持稳定身份、分层记忆与平台隔离，跑通“发现自身工具缺陷 → 隔离 worktree 修改测试 → 报告/审批应用或回滚 → 受控起草上游 Issue/PR”闭环；无外部任务时能在配额与治理边界内开展自主探索及休眠整理，敏感凭据零泄露、外部资料不越权、公开互动透明标识 AI 身份。P3.7–P3.10 的迁移/分支、记忆纠错/遗忘、实验回执隔离和协作归属分别建立专项验收，不以单实例原型通过替代这些研究题的完成证明。
