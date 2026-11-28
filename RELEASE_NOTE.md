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

### 首次 CI 修复

- GitHub run `46121170070`（`bed565a`）的两个回归任务通过，8 个安装任务均返回 127，另有 10 条 Actions Node 20 弃用警告。详细日志未取得；隔离 PATH 重跑相同提交，复现 `spawn pnpm ENOENT`：原 workflow 安装了 DSH，但遗漏其插件安装命令需要的 pnpm，先前本地验收使用了开发机已有命令。
- 安装任务显式安装 `pnpm@12.23.0`；脚本在创建 profile 前检查依赖，安装/启动/卸载失败时输出日志末尾并保留退出码。checkout/setup-node/upload-artifact 更新为固定 commit 的 v6（Node 24 runtime），同步随包模板和安装说明。
- 本地在 `bed565a` 的独立副本中仅应用 CI 安装脚本修复，使用隔离 PATH、DSH `0.2.2-rc.5` 和新安装的 pnpm `12.23.0`，Node 24.9.0 / 24.22.3 各通过四类安装（`/tmp/mbot-plugin-install.ET5UGn`、`/tmp/mbot-plugin-install.0jSwgl`）。缺失依赖/失败退出码、`actionlint`、Bash 语法、324 条文档链接和包资源检查通过。未混入在途 P1 功能，也未重复完整业务回归；修复后的 GitHub 实际运行仍待推送验收。

- 后续远端核验（2026-11-28）：修复提交 `9b0824a` 的 run `46123034693`、开发提交 `31ee106` 的 run `46125306335` 均为 success；两个 run 各有 2 个回归与 8 个安装任务全部通过，各 check-run annotations 均为空，原 Node 20 弃用告警已消失。中间提交 `47a3100` 的 run `46124415704` 也成功。证据为 GitHub Actions API（本地摘要 `/tmp/dsh-mbot-ci-verified.json`），不代表尚未推送提交的远端验收。

### Conversation 身份与权限预留

- registry v3 兼容 v1/v2，持久保存不同用户/群/线程/peer 的来源、发送者许可、回复路线与稳定 Session ID；ConfigEditor 保存支持并发 revision、幂等和失败保留，既有归属不能重置、降级或改绑。预留记录随 Bot 退役保留，详见 [conversation 模块](docs/conversations.md)。
- 本阶段只提供 `reserved` 基础，不创建原生实体或开放额外域执行。已物化的预留 Session 自动取得 Runtime 闸门，拒绝模型、数据工具、摘要和所有者命令；拒绝时 Inbox 保留，Runtime 重载和 Host 崩溃恢复后仍受同一身份约束。记忆/工具可见域、实际激活与逐域消息仍在 P1。
- Node 24.9.0 完整回归通过：204 项 Host/Runtime、1 项真实 API 跳过、64 组 Bash。随后补充状态与 Unicode 边界校验，类型及 8 项相关测试通过。安装曾发现字符串长度约束不能导出为 DSH JSON Schema，改为字符正则后，源码/tarball/Git/Web tarball 四类安装全部通过（`/tmp/mbot-plugin-install.gzHj4d`）。
- tarball Web GUI 验收通过双窗口拒绝、所有者命令拒绝、刷新、SIGKILL 后同 ID/Inbox 恢复及私人主 Session 续聊，已检查实际渲染截图（`/tmp/mbot-gui-conversations.aUpXKJ`）。独立子进程测试同时核验持久 Inbox 字节和零模型调用；显式 Agent dispose 会由 DSH 取消队列，不作为崩溃替代。日志见 `/tmp/dsh-mbot-conversations-full.log`、`/tmp/dsh-mbot-conversations-test-final.log`、`/tmp/dsh-mbot-conversations-install-final.log`、`/tmp/dsh-mbot-conversations-gui.log`。

### 显式域资料视图

- 每域 `VIEW.json` 绑定 Bot/conversation/来源 key/角色，只选择人类已发布到共享或本域目录的 Markdown；按单一 Git commit 读取，核验常规 blob、UTF-8、文件数和字节限额，拒绝缺失/越界/符号链接，私人旧资料不自动公开。独立知识 v2 绑定权限、清单与文件 hash，不随其他域或普通 HEAD 变化而失效，详见 [域资料视图](docs/conversations.md#显式域资料视图)。
- 新增 Host `inspectConversationView` 与包内子进程 helper，返回文件身份/hash/大小，不返回正文、不创建会话或 lease。内部读取器冻结原始快照，并提供仅从清单取文档的函数。此阶段未接入模型提示、botctl、checkpoint、摘要或 Dreaming，域仍为 `reserved`，P1 保持未完成。
- Node 24.9.0 类型检查、全部 59 项 Host 插件测试通过，其中 4 项新测试覆盖资料隔离、权限/内容版本、固定历史快照、未提交草稿、越界与损坏输入。四类安装均通过实际 Host API 检查 helper（`/tmp/mbot-plugin-install.HCDYP8`）；日志 `/tmp/dsh-mbot-conversation-view-plugin.log`、`/tmp/dsh-mbot-conversation-view-install.log`。本阶段没有改动现行 Runtime/GUI/事务桥，未重复其完整回归或真实模型验收。
- 复核补充 Git replace、字面通配符路径和大 Unicode 许可列表测试，helper 输入上限调整为 2 MiB 以容纳登记格式的完整合法范围；4 项专项及类型复验通过（`/tmp/dsh-mbot-conversation-view-final.log`）。339 条文档链接、包资源及 `git diff --check` 通过。

### 内部域事务与 checkpoint

- 内部域桥新增 journal v4/runtimeOwnership v3：只从显式域清单捕获知识，boot/view 只读固定脱敏快照；检查合并记忆预算和 SOUL/参考预算，禁止私人任务/看板、候选及 Worker 调用，guard 回滚业务写入。公开 beginTurn 与 reserved Agent 继续拒绝域执行。
- context snapshot v2 绑定持久域身份、knowledge v2、原生来源和 Inbox；私有 context 字节 hash 先持久化再发布 journal，Git 审计封存同一证明。Host 恢复核对登记/原生/私有快照/Git，保留取消计数、PAUSED 与单次结算；拒绝降级、权限变化、快照篡改和已捕获证明丢失。纯 Node/Git helper 与 Host schema 分离，独立 Bash 入口保持可用。契约见 [域事务](docs/conversations.md#内部域事务与-checkpoint)。
- Node 24.9.0 完整回归通过（212 项 Host/Runtime、1 项真实 API 跳过、64 组 Bash，`/tmp/dsh-mbot-domain-turn-full.log`）。之后补充聚合预算/证明丢失校验，类型及 11 项域专项通过（`/tmp/dsh-mbot-domain-final-scope.log`）；新增原生 Agent 测试经公开 recoverTurn 验证 Runtime 重载、登记冲突拒绝、checkpoint 恢复及 Inbox 保留，零模型调用（`/tmp/dsh-mbot-domain-runtime-recovery.log`）。测试中的域回合从内部桥建立，尚不代表实际域模型流程交付。 公开 checkpoint/plugin-record 类型已区分私人 v1 与域 v2，新增分支收窄检查通过。
- source/tarball/Git/Web tarball 四类安装实际执行域 v4 helper、快照读取及 Git 封存，保留公开域拒绝与原有私人 Runtime 回归（`/tmp/mbot-plugin-install.a5VImi`、`/tmp/dsh-mbot-domain-turn-install.log`）。tarball Chromium 通过双窗口拒绝、刷新、SIGKILL 后同 ID/Inbox 恢复和私人主 Session 续聊，实际截图已检查（`/tmp/mbot-gui-conversations.5WhvAB`、`/tmp/dsh-mbot-domain-turn-gui.log`）。未调用真实 API或执行 R5；域消息、提示、候选/Dreaming、摘要/维护仍列 P1。

### 域收信与回复证明

- 新增可信 Host `conversationMailbox`，绑定已存在且已附着的域 Agent，每次操作重验持久来源、发送者许可和回复路线。域信封 v2 以 Bot/域/适配器/发送者/平台 requestId 区分请求，复用原生 Inbox、并发去重、flush 确认和查询；Runtime 重载、退出及注销撤销旧能力，原生队列篡改被拒绝。域仍为 reserved，不创建实体或调用模型。
- 内部 v4 事务封存原生域输入和回复目标，查询联合核验 context snapshot、原生结束、Git 审计、journal 结算与 flush；返回绑定域/发送者的回答 v2，所有者回答保持 v1。派生展示文本不能替换原 Inbox 证明，未执行的排队消息不会成为本轮回复目标。契约见 [域 mailbox](docs/conversations.md#域-mailbox-与回复证明)。
- 共用回复门面补充脱敏一致性检查：若查询时新增凭据规则改变已封存正文或路线/投递身份，返回 unverified，不在原 replyId 下发布被改写的信封。实际适配器、域模型提示/工具、候选/Dreaming、摘要/维护和外部投递仍列 P1。
- Node 24.9.0 完整回归通过：217 项 Host/Runtime、1 项真实 API 跳过、64 组 Bash（`/tmp/dsh-mbot-domain-messages-full-final.log`）；补充测试覆盖原生派生展示、未执行排队消息、未结算 journal、动态凭据规则及能力撤销。所有者路由错误提示保持兼容。
- 四类实际安装全部通过（`/tmp/mbot-plugin-install.rI4Fpd`、`/tmp/dsh-mbot-domain-messages-install-final.log`）；安装夹具现在分别用两个域验证内部事务和原生 mailbox，并同步修正登记数量断言。tarball Chromium 验收通过收信/去重、双窗口拒绝、刷新、SIGKILL 后同 ID/Inbox 恢复、原 MessageId 重试和私人主 Session 续聊；实际截图已检查（`/tmp/mbot-gui-conversations.CZ5FgN`、`/tmp/dsh-mbot-domain-messages-gui.log`）。346 条文档链接、包资源、Bash 语法及 `git diff --check` 通过。未运行 R5 或真实 API。

### 原生域上下文与只读工具接线

- 域提示仅使用显式发布的协议/SOUL/记忆和本轮域身份；通过官方 scoped context 空掩码覆盖 DSH required refresh，最终 LLM 边界验证原生消息、投影、历史与精确工具 schema。外来/迟到上下文、准备阶段改写、未审计历史和额外工具/PTC 拒绝，普通模型请求不在中间件中改写。详见 [域上下文](docs/conversations.md#原生提示读工具与历史隔离)。
- 原生 scoped botctl 只声明固定快照 boot/view，每次核对持久域权限、本轮 lease 与精确参数，并保留原生审批。域历史从 Git/context 验证的回合恢复；失败准入从原 Inbox cut 验证输入，提交中断使用公开恢复接口单次结算。修正同一私人 Agent 切换 Worker 开关时将 Cordis Fiber 误作函数释放的问题。
- 公开 registry/准入仍为 reserved，模型测试仅在内部夹具中接线，不代表域激活、候选/Dreaming、摘要/维护或真实适配器已经交付。18 项原生域边界与 Worker 开关专项通过（`/tmp/dsh-mbot-domain-context-boundaries2.log`）；包含迟到 required provider 零模型调用、原生审批拒绝、多轮知识更新、Runtime 重载和域提交失败恢复。
- Node 24.9.0 完整 Host/Runtime 回归 234 项通过、1 项真实 API 跳过、1 项精简 Host 冷启动失败：其没有全局 botctl，旧 restriction 却依赖该名称。修正为拒绝所有继承工具、保留 scoped 域工具后，22 项相关专项全部通过，随后 64 组 Bash 回归通过。日志 `/tmp/dsh-mbot-domain-context-full.log`、`/tmp/dsh-mbot-domain-context-final-scope.log`、`/tmp/dsh-mbot-domain-context-bash.log`；保留首轮失败证据，未重复不受影响的完整矩阵。
- 四类安装通过并核验实际域 schema 与私人工具不可见（`/tmp/mbot-plugin-install.8phoFy`、`/tmp/dsh-mbot-domain-context-install.log`）。tarball Chromium 的双窗口拒绝、收信重试、刷新、SIGKILL/同 ID 恢复及私人主 Session 续聊通过，实际截图已检查（`/tmp/mbot-gui-conversations.JZlx5s`、`/tmp/dsh-mbot-domain-context-gui-final.log`）。首轮 GUI 暴露 Controller 可在 agent/created 回调结束前返回 live Agent；夹具改为等待 Runtime 真实 attach，新增受控延迟测试证明未就绪 mailbox 拒绝、同一附着等待完成后收信（`/tmp/dsh-mbot-domain-attachment.log`）。348 条文档链接、包资源与 `git diff --check` 通过；未运行 R5 或真实 API。

### 域候选事务与私人 Dreaming 取材隔离

- 内部域桥新增 journal v5/runtimeOwnership v4，本域 remember 保存每回合 JSONL；原生请求/派发/成功回执、脱敏跨度、知识版本和 Git 文件 hash 联合核验。限定路径、字节/条数预算、callId 幂等、guard 回滚和失败/取消语义保留，候选不直接改长期记忆。契约见 [域候选事务](docs/conversations.md#域候选事务)。
- 原生 context 的 candidateVersion 绑定写者版本；checkpoint、reply 与恢复核验原提交的候选，专用恢复 proof 防止复用只读证明，保留旧 v4 历史/恢复。私人 Dreaming 按原始审计排除域 transcript（含旧 pending），防止通过工具日志重新摄入域候选。
- 公开域仍 reserved。独立域 Dreaming、摘要、sleep/wake、维护恢复及公开激活继续列入 P1，R5 暂缓；本次不变更包版本或既有标签。
- Node 24.9.0 完整回归通过：253 项 Host/Runtime、1 项真实 API 跳过、64 组 Bash（`/tmp/dsh-mbot-domain-candidates-full.log`）。之后补充成功回执与候选文件一致性，类型与 28 项专项全部通过（`/tmp/dsh-mbot-domain-candidates-final-scope2.log`），覆盖删除整文件/单行、旧证明拒绝、真实原生重载与提交中断恢复。首次专项因手工构造的 tool/result 缺少原生 surfaceOp 标记失败，修正夹具后复验，保留 `/tmp/dsh-mbot-domain-candidates-final-scope.log`。
- 四类实际安装全部通过，覆盖同一内部 Session 的 v4→v5 升级及候选 Git 证明（`/tmp/mbot-plugin-install.4zGtk1`、`/tmp/dsh-mbot-domain-candidates-install.log`）。tarball Chromium 通过预留拒绝、双窗口、收信重试、刷新、SIGKILL 后同 ID 恢复和私人主 Session 续聊，实际截图已检查（`/tmp/mbot-gui-conversations.1aVFqN`、`/tmp/dsh-mbot-domain-candidates-gui.log`）。351 条文档链接、包资源、Bash 语法及 `git diff --check` 通过；本阶段未运行真实 API 或 R5。

### 域 Dreaming 取材与计划校验

- 抽取共用的 `context-restore` 读取器，checkpoint 与域维护复用原生/Git/context/candidate 证明，Git history/batch 读取禁用 replace。域 Dreaming 仅接收已完成回合中有成功工具回执的候选，官方原生 fold 核验来源 cut/Inbox；未结算、缺日志、未审计回合及域身份冲突拒绝。固定 Git 视图、整条候选预算、增量 cursor、当前凭据脱敏均有验证。
- 新增独立辅助请求构造及结构化计划校验：只声明 system/user 两条消息和无工具的 `mbot-domain-dream` purpose；仅本域已发布且未脱敏的 memory/reference 可提出逐行编辑，共享/协议/SOUL 只读。每项取舍/删除保留来源与依据，检查链接、实际原文预算、Unicode 和凭据；输出冻结写集，不修改工作树或消费 checkpoint。域仍 reserved，模型执行、持久维护、回滚与恢复留在 TODO，详见 [独立域 Dreaming](docs/domain-dreaming.md)。
- Node 24.9.0 完整回归通过：263 项 Host/Runtime 通过、1 项真实 API 跳过、64 组 Bash（`/tmp/dsh-mbot-domain-dream-full.log`）。补充链接标签和脱敏原文预算检查后，类型与 8 项专项通过（`/tmp/dsh-mbot-domain-dream-final-scope.log`）。早期专项中将展示卡片缺失误判为必须拒绝，以及测试清单重复列入同一文档的问题均已修正；保留 `/tmp/dsh-mbot-domain-dream-scope.log` 和 `scope2.log`。
- 四类安装全部通过，实际包内执行取材/请求构造/计划校验，并确认没有写入工作树（`/tmp/mbot-plugin-install.LUBZve`、`/tmp/dsh-mbot-domain-dream-install2.log`）。首次 tarball 夹具因局部 `readFile` 遮蔽顶层导入失败，修正测试后重跑矩阵，保留 `/tmp/mbot-plugin-install.kgcsPh`。361 条本地文档链接、包资源、Node/Bash 语法及 `git diff --check` 通过。没有新增 GUI 流程，本阶段未运行 Chromium、真实 API 或 R5。

### 域 Dreaming 持久维护与恢复

- 新增可信 Host `runtime.dream(agent)`：原生维护生命周期与 BotCoordinator 屏障内执行隔离、无工具的辅助模型；输入/输出/用量在原生 Session 标记并 flush，模型正常结束后才接受逐行计划。域仍为 reserved，公开域命令、实体准入、摘要及 sleep/wake 联合流程保留在 TODO。
- 持锁 helper 保存工作树外维护 journal v2、完整阶段快照和明确 commit intent；工作树持久标记阻止 Host/CLI mutation/run/dream/resume 绕过。按原权限写入、fsync/rename，私有 Git index 同次提交本域记忆、报告和消费 checkpoint，记录知识版本前后值；Git 写子进程继承两把锁。
- 恢复重建原生/Git 来源、消费链、模型计划和完整派生写集；未持久计划只中止，已保存计划不重调模型，已提交只补原生回执/flush 与结算。支持真实部分写入、Runtime 卸载/模块交接、Git 引用更新前后 SIGKILL 和整个 Host 崩溃后同原生 Session 冷恢复。篡改、未知修改、未退出写者和缺失证明均拒绝并保留现场。契约见 [独立域 Dreaming](docs/domain-dreaming.md)。
- Node 24.9.0 完整 Host/Runtime 首轮为 279 项通过、1 项真实 API 跳过、1 项旧域恢复测试被短命 `/proc` 进程拒绝。确认 PID 已退出后专项复验通过，核对原失败现场 HEAD/工作树/journal 未变；64 组 Bash 另行全部通过。日志 `/tmp/dsh-mbot-domain-maintenance-full.log`、`/tmp/dsh-mbot-domain-maintenance-regression-retry.log`、`/tmp/dsh-mbot-domain-maintenance-bash.log`，现场摘要 `/tmp/dsh-mbot-domain-maintenance-refusal.json`。没有放宽生产写者核验。
- 实际安装暴露夹具原生消息缺 `stream`、独立 helper 无法按 Host loader 解析 DSH peer，以及探针缺 `sessionQuery` inject，均已修正。helper 通过既有固定版本 SDK 定位器加载官方 `foldSurface`，不执行用户 profile；四类安装已通过（`/tmp/mbot-plugin-install.IFg3pP`）。前三次失败产物 `/tmp/mbot-plugin-install.IqmaEs`、`/tmp/mbot-plugin-install.YDZAxd`、`/tmp/mbot-plugin-install.VJDDjd` 保留。
- 最后复核补齐基线 `write-tree/status` 子进程的双锁继承，恢复 helper 退出也纳入原生维护生命周期；类型与 22 项域专项通过（`/tmp/dsh-mbot-domain-maintenance-final-scope2.log`），覆盖孤立索引写入和引用更新期间恢复拒绝、退出后单次结算。最终源码/tarball/Git/Web tarball 四类安装复验通过（`/tmp/mbot-plugin-install.XGLNtM`、`/tmp/dsh-mbot-domain-maintenance-install-final.log`）。362 条文档链接、包资源、语法及 `git diff --check` 通过。本阶段没有新增命令/UI，未运行 Chromium、真实 API 或 R5。

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
