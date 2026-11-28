# Conversation 身份与来源权限

本模块是 `0.2.0-rc.1` 之后开发分支的 P1 基础。registry v3 已支持持久预留和来源权限，以及显式域资料清单的 Git 快照读取/检查。额外对话域仍为 `reserved`：不创建原生实体，不运行模型、数据工具或摘要。内部事务桥已接入域快照、只读工具与 checkpoint 恢复，conversationMailbox 已支持可信来源收信、去重与域回复证明；原生提示/工具与历史隔离已接线并通过内部模型夹具验收。公开准入、域激活、适配器、摘要及 Dreaming 仍待完成，路线以 [DESIGN](../DESIGN.md#对话域与外部消息) 为准。

## 身份与权限

默认所有者私人主 Session 保持既有绑定；新域只允许 `user-private`、`group`、`peer`。可信适配器先认证平台来源，再由 Host 接口登记。消息正文不能提供要使用的 Session ID，也不能把平台账号相同当作所有者认证。

| 字段 | 含义 |
|---|---|
| source.adapterId / platform / accountId | 适配器、平台与接收账号，均纳入域身份 |
| source.spaceId / threadId | 私聊/群/空间与可选线程；无线程显式写 null |
| source.visibility / principalId | 私聊和 peer 必须绑定单一主体；group 的 principalId 必须为 null |
| allowedSenders | 1–256 个不重复的发送者 ID；group 使用显式许可列表，private/peer 只能包含对应 principalId |
| replyRoute | 可信适配器提供的固定回复路线，本阶段只校验与保留，不投递回复 |
| conversationKey | 按固定字段顺序序列化 source 后的 SHA-256；不同 Bot 可用相同 key，但各自生成独立身份 |
| conversationId / sessionId | Host 分配的 UUID；调用者不能指定或改绑私人主 Session |

所有身份字符串须非空、首尾无空白、无控制字符，最长 1024 字符。未知字段、缺失的 threadId/principalId、重复发送者、错误 key/时间、重复 Session 与未知 Bot 均拒绝。群成员变化或回复路线变化不能覆盖已有许可；后续撤权/迁移需显式版本化契约。

## Host API

```js
const access = {
  source: {
    adapterId: 'verified-adapter', platform: 'qq', accountId: 'account-a',
    spaceId: 'group-a', threadId: null, visibility: 'group', principalId: null,
  },
  allowedSenders: ['alice', 'bob'],
  replyRoute: 'group-a-route',
}
const record = await ctx.mbot.reserveConversation(botId, access, { revision, signal })
const saved = ctx.mbot.conversation(botId, access.source)
const permitted = ctx.mbot.authorizeConversation(botId, {
  ...access.source, senderId: 'alice', replyRoute: 'group-a-route',
})
```

`reserveConversation` 使用官方 ConfigEditor 的最新配置和可选 revision 校验，串行保存同 profile 的预留。相同 Bot/source/许可的重复请求返回原记录，不增加 revision；ACL 或 replyRoute 冲突拒绝。调用时捕获输入，返回分离快照，调用者后续修改对象不会改变待保存或已保存权限。失败保存保留旧有效配置。

`authorizeConversation` 只验证可信适配器提供的身份与现有许可一致；它不是平台认证或模型执行许可。域 mailbox 还要求相同 Session 已存在且被当前 Runtime 附着；不能改用 ownerMailbox。主 Session 的所有者入口见 [消息准入](message-admission.md)。

官方 Controller 的 live Agent 查询可能早于 `agent/created` 的异步附着完成；可信 Host 调用者须等待当前 Runtime 的 `attach(agent, { botId })` 完成后取得 mailbox。该调用复用同一在途附着，不创建替代 Agent；未就绪时 mailbox 保持拒绝。

## 域 mailbox 与回复证明

可信适配器核实平台来源和发送者后，可向**已存在且已附着**的域 Agent 取得能力；接口本身不创建实体或升级 reserved 状态：

```js
const mailbox = ctx.mbotRuntime.conversationMailbox(agent, {
  ...record.source, senderId: verifiedSenderId, replyRoute: record.replyRoute,
})
ctx.effect(() => () => mailbox.dispose())
const delivery = await mailbox.send({ requestId: platformEventId, text: '域消息' })
const receipt = await mailbox.receipt(platformEventId)
```

创建和每次操作都核对持久 Bot/conversation/Session、完整来源、发送者许可与回复路线。调用者不能通过正文、requestId 或 send 参数改选域/发送者/路线。不同发送者各持自己的能力；Runtime 重载、注销、Agent 退出或 dispose 后，旧能力拒绝操作。捕获输入后再 await，调用者后续修改对象不影响已经投递的字节。

`source.mbot.schemaVersion=2` 包含域 scope、adapterId、senderId、replyRoute、requestId、可选 correlationId 和内容指纹。原生 rpcId 使用 `mbot-domain:` 前缀，命名空间为 Bot/域/适配器/发送者/平台 requestId。正文、路线和关联 ID 变化是同 ID 冲突；不同 Bot/域/发送者即使平台 ID 相同也不合并。只支持非空文本（1–262144 字节），附件尚待适配器契约。

mailbox 复用 DSH followup/Inbox、原生日志投影和 flush，不增加消费者或持久队列。`confirmed` 只证明 flush；失败返回 `unconfirmed`，重试原 ID 复用原 MessageId，不追加唤醒消息。reserved 域暂不处理这些输入；查询返回 queued。原生队列编辑不能保留旧信封指纹篡改正文，冲突后拒绝重试/查询；Bot 退役保留原生数据但撤销能力。

内部 v4 域事务已可封存域回复目标，查询返回 schemaVersion 2 的回答信封，包含 conversationId、可见性、权限 hash 和 senderId。只有原生结束事件、精确目标、可达 Git 审计、context snapshot v2 与 journal 已结算且 flush 确认一致时才返回 final。缺失域身份、跨域/跨路线、未确认落盘及篡改证据均不释放回答；这一步由内部桥夹具验收，尚无公开域模型执行入口。它不向 IM/peer 投递，也未实现外部 ack/outbox。

## 显式域资料视图

旧 `AGENTS.md`、SOUL、MEMORY、wiki、BOARD、任务和历史默认属于所有者私人域，不因预留新 conversation 自动公开。人类先将允许分享的资料单独写入 `memory/shared/` 或 `memory/conversations/<conversationId>/`，再在该域的 `VIEW.json` 列明读取范围并提交 Git。`shared` 表示可以被域清单选择，不代表其中所有文件都会被自动加载；Markdown 中的链接也不增加权限。

以下示例中的三个身份值必须取自 `reserveConversation` 的真实返回结果，不使用名称或平台消息中的 ID 替代：

```js
const policy = {
  schemaVersion: 1,
  botId: record.botId,
  conversationId: record.conversationId,
  conversationKey: record.conversationKey,
  role: 'chief', // 必须匹配 Bot 默认角色
  protocol: 'memory/shared/AGENTS.md',
  soul: 'memory/shared/chief.md',
  memory: [
    'memory/shared/MEMORY.md',
    `memory/conversations/${record.conversationId}/MEMORY.md`,
  ],
  references: [`memory/conversations/${record.conversationId}/wiki/topic.md`],
}
// 人类将 policy 保存到 memory/conversations/<conversationId>/VIEW.json，
// 编写所列文件并提交后，从受信任 Host 代码检查：
const inspection = await ctx.mbot.inspectConversationView(botId, record.source)
// 也可检查指定的完整 Git commit SHA：
const historical = await ctx.mbot.inspectConversationView(botId, record.source, { commit })
```

所有字段显式提供，`memory`/`references` 可为空；协议与角色资料必须分别提供，不能回退到根目录的私人文件。只允许共享目录或本域目录内的明确 `.md` 路径，拒绝其他域、路径穿越、隐藏组件、反斜线、控制字符、重复文件与未知字段。读取以同一个固定 commit 为准，要求全部资料已提交为常规 Git blob；不跟随符号链接、子模块、Git replace 对象或 Markdown 链接，不读取工作树草稿。Bot 重新导入后身份不同，需要人类重新发布对应清单。

清单最多 32 KiB；至多 64 个文件，每个最多 64 KiB，总计最多 256 KiB；内容要求有效 UTF-8 且无 NUL。这些是读取器硬上限；内部域事务另外按配置检查合并记忆的行/字符总预算、SOUL 字符数及逐份参考文档行数。超限或缺文件整次拒绝，不静默截断或补读私人资料。

视图的 `knowledge.schemaVersion=2` 绑定 Bot/conversation/Session、来源 key、可见性与许可 hash、角色、清单 blob/hash，以及按用途和顺序排列的资料 blob/hash。普通 Git HEAD、私人文件或其他域变化不会自行推进本域知识版本；本域正文、清单或许可变化会更新版本。内部域事务通过下述 context snapshot v2 将知识版本封存到原生/Git 证明；单独的视图检查仍不构成事务证明。既有私人主 Session 的知识与快照保留 v1。

`inspectConversationView` 只返回 commit、文件身份、hash 和字节数，不返回正文，不创建 Agent、lease 或数据提交，也不改变 `reserved`。内部 `readConversationView` 返回冻结的原始资料；读工具通过 `conversationViewDocument` 仅从已捕获的清单取正文，不能自由读取工作树。内部数据桥已提供脱敏/预算检查后的固定快照读取，下述原生工具复用同一快照；公开准入、域候选、Dreaming 与摘要/维护接齐之前，公开域闸门继续拒绝执行。

## 内部域事务与 checkpoint

内部 `openTurn` 使用独立 `journal.schemaVersion=4` 与 `runtimeOwnership={schemaVersion:3, mode:'domain-foreground', workerDepth:0, tools:['botctl']}`。这一步为后续激活建立数据契约；公开 `ctx.mbot.beginTurn` 拒绝 conversation 参数和 reserved Session，模型闸门也未开放。不得将内部 helper 当作新消息入口。

- 取得 Bot 锁并固定 HEAD 后，从域清单读取资料。上下文只含已发布协议/SOUL/记忆/参考，私人 BOARD、角色记忆等不自动取入；候选写入和 Worker 委派均拒绝。
- 合并后的全部 memory 受 `MBOT_MEMORY_MAX_LINES`/`MBOT_MEMORY_MAX_CHARS` 限制（含拼接换行），SOUL 受字符预算限制，每份参考受 wiki 行预算限制。超限在发布 active journal 前拒绝；正文使用现行凭据脱敏，知识/域身份 hash 保留原始精确值。
- 私有 `context.json` 先持久化，其 SHA-256 与 Bot/conversation/Session、来源 key、可见性及权限 hash 一起写入 v4 journal。`boot <本轮角色>` 仅返回固定协议/人格/记忆和参考路径；`view <清单路径>` 只读捕获的脱敏正文。直接持 permit 调用 CLI 也不能读私人任务/看板或执行旧 remember。
- 初始域契约禁止全部业务工作树写入；guard 恢复越权数据，Host 最后封存审计。成功、失败、干净用户取消沿用统一 outcome 与故障计数规则。
- 原生 `plugin:mbot/context-snapshot` 的 schemaVersion 2 绑定持久 conversationId、knowledge v2、原生有序来源 cut/Inbox 输入和前序 checkpoint。同一次 Git 审计封存域身份与 context；成功域回合不得没有 snapshot，已捕获的失败/取消回合也不能删掉证明或降为私人 v1。
- 恢复要求 Host 原生所有权核验及 `recorded-domain-v1` proof，检查 registry 域归属、原 journal/私有 ledger/context hash、原生事件和 Git 审计；使用原始受限 guard，保持单次提交/结算与 PAUSED，不运行模型。Runtime 重载后可恢复 checkpoint，输入继续留在同一 reserved Session 的 Inbox。

域回复使用独立 conversationMailbox，不能改用 ownerMailbox。当前不支持实际 IM/peer/outbox、候选/Dreaming、Worker、自动/手动摘要或 sleep/wake。实际域激活必须在这些所需契约及来源准入接齐后验收，不能用旧私人接口代替。

## 原生提示、读工具与历史隔离

`domain-context.js` 从已捕获域快照生成协议、SOUL 与记忆段，参考文档只列发布路径；记忆按引用数据包装，不合并私人模板、任务或 Worker 规则。原生 `mbot:turn` 绑定本域身份、知识版本与已准入发送者。组装结果清除外来段与变量，并核对最终完整结果；无法覆盖的 complete/scope-local 冲突明确拒绝。

DSH `0.2.2-rc.5` 在原生 step 内再次执行 `refreshContext`，仅过滤 assemble 返回值不足以隔离 required provider。Runtime 用官方 Agent-scoped 空 context 覆盖已观察到的外来 provider；掩码随 Agent 保留，Runtime 重载可继续使用。最终 `llm/stream` 验证原生请求标记、Session/surface、原始事件投影、消息与工具历史；迟到 required context、输入改写、外来工具/PTC 或额外消息拒绝，普通模型请求不在中间件中改写。

`domain-tools.js` 安装只含 `boot`/`view` 的独立 botctl schema，同时限制继承的工具。每次执行核对持久域归属、本轮 lease 和精确参数，再走原生 sandboxPolicy/approval。`boot` 只能选当前角色；`view` 只能读快照清单内的路径，不能传宿主目录、私人路径或写操作。scope-local 工具不受 DSH inherited restriction 约束，因此最终 schema 仍须精确核验。

历史 user/assistant/tool 事件须来自本轮原生记录或已经 Git/context 联合验证的回合；不收养预先写入的私人历史，也不继承父 Session。旧派生系统/运行上下文通过原生 surface replacement 退役，原始日志保留。恢复时从 snapshot 捕获的 Inbox cut 取原消息并验 hash；准入失败而尚无 user/message 的回合也能验证，展示消息不能替代原输入字节。准备阶段失败保留未派发输入；最终模型检查发生在原生派发后时，保留真实失败终态，不伪造 queued 状态。

当前测试夹具只在测试内接入内部 `openTurn` 并放行内存测试状态，使用真实原生 Agent、工具、审计、持久化与公开恢复接口验证链路；持久 registry 始终为 reserved。该夹具不构成公开激活接口。域 compaction 明确拒绝，域维护仍待独立契约。

## 持久化、执行与退役

registry v3 增加顶层 `conversations`，记录 schemaVersion 1。读取 v1/v2 时保留 Bot/退役信息并迁移为空域列表；新保存使用 v3。原 conversation 的来源、许可、Session 和创建时间不可被配置重置、降级或编辑覆盖。

预留不创建 DSH 工作区或 Session，也不取得数据 lease。如果原生层物化该 Session，Runtime 按持久身份自动安装 Agent-owned 闸门，状态查询显示 `reserved`；Runtime 重载复用闸门，原生 resume 重新验证持久归属。模型提示组装、受管理工具、手动/自动 compact、数据桥和 `/mbot` 所有者命令在执行前拒绝。受信任 Host 内部接口不是恶意同进程插件的安全沙箱。

拒绝执行的输入保留在原生 Inbox；已 flush 的记录在 Host 崩溃后可以同 ID 恢复。**显式 `AgentHandle.dispose()` 是另一种行为**：DSH 会以原生 cancellation 清空待处理输入，不能用它模拟崩溃，也不应在后续激活流程中将其作为休眠释放方式。

默认选择切换不改变域的 Bot 归属。Bot 注销时一起验证活跃和冷 Session、保留全部预留 ID 与不可变记录；旧 ID 不可指向重新导入的新 Bot。只预留但尚未物化的 Session 也保留退役归属。见 [Bot 退役](bot-removal.md)。

## 验收

- Host 测试覆盖规范 key、不同来源域、并发幂等、输入/返回对象隔离、发送者/路线拒绝、v1/v2 迁移、配置 reset/downgrade、保存失败，以及无 Runtime 时的命令/工具拒绝。
- 原生 Agent 测试覆盖 Runtime 重载、显式销毁后的 resume、预留域无模型/lease/知识快照、私人主 Session 继续工作，以及活跃/冷域随 Bot 退役。
- 独立 Host 子进程在 Session flush 后被 SIGKILL，再从实际持久存储恢复同一 ID，核对 Inbox 字节、域记录和零模型调用。
- `npm run test:gui-conversations` 使用 tarball 安装后的 Web profile，覆盖双窗口、拒绝反馈、刷新、Host 重启和私人主 Session 续聊。GUI 与恢复全进程检查分开执行。
- 资料视图测试覆盖私人 canary 不泄露、群/其他用户/peer 隔离、固定 commit 与未提交草稿、权限/正文版本变化、清单越界、符号链接、缺文件、非法 UTF-8/NUL 和字节限额；安装矩阵通过真实 Host API 检查包内 helper，确认只返回元数据且不激活域。
- 域 mailbox 测试覆盖并发重试、输入捕获、不同发送者/群的同 ID 隔离、来源/路线拒绝、flush 不确定、原生队列篡改、Runtime 重载和注销；GUI 使用实际安装后的能力收信，并在 SIGKILL 重启后以原 ID 查回同一 MessageId。
- 域桥测试覆盖固定快照/只读命令、私人路径拒绝、越权写入回滚、取消计数、正文脱敏、合并记忆预算、原生/Git checkpoint 及中断单次结算；原生 Agent 测试通过公开恢复接口核验重载后的持久域身份、checkpoint 和 Inbox。安装矩阵实际执行包内 v4 桥，公开域执行仍拒绝。
- 内部原生域模型夹具覆盖 boot/view、多轮知识更新、重载、提交失败后的单次恢复与续聊；私人 canary、迟到 required context、scope-local 冲突、输入改写、额外工具、未审计历史与审批拒绝均有反向验收。安装矩阵核对实际域 schema 和私人 Bash/文件/派活工具不可见；同一私人 Agent 的 Worker 开关往返切换继续通过。

上述验收证明预留拒绝边界与内部域事务，不代表已完成实际域模型对话、候选治理、IM、peer 或 outbox。具体运行结果记入 [RELEASE_NOTE](../RELEASE_NOTE.md)，剩余执行事项见 [TODO](../TODO.md)。
