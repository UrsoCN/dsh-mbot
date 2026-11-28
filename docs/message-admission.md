# 所有者消息准入与原生收据

当前基线 `0.2.0-rc.1`。可信 Host 的所有者私聊入口复用实际主 Session、DSH Inbox 与事件存储，已接入 [本地 CLI IPC](host-ipc.md) 和 [sleep/wake](sleep-wake.md)。真实 IM、独立 Bot 通信、隔离 conversation 与回复 outbox 尚未开放；入口设计见 [Session Runtime](session-runtime.md)。

## 宿主能力与身份边界

`ctx.mbotRuntime.ownerMailbox(agent, binding)` 返回可撤销的能力对象。Agent 必须已经 attach 完成，且属于绑定状态 ready 的 Bot 主 Session。适配器先核实平台发送者是当前 profile 的所有者，再建立绑定；这里没有提供平台认证服务。`visibility` 必须是 `owner-private`，绑定固定 `adapterId`、`ownerId`、`conversationKey`、`replyRoute`。用户请求不能选择 Bot/Session、来源、发送者或回复目的地。

```js
const bot = await ctx.mbot.resolveMainSession(botId)
const agent = ctx.agents.get(bot.mainSessionId)
const mailbox = ctx.mbotRuntime.ownerMailbox(agent, {
  visibility: 'owner-private', adapterId: 'telegram-adapter',
  ownerId: verifiedOwnerId, conversationKey: verifiedPrivateChat,
  replyRoute: verifiedPrivateChat,
})
ctx.effect(() => () => mailbox.dispose())
const receipt = await mailbox.send({
  requestId: platformEventId, text: '帮我整理今天的任务',
})
```

Runtime 重载/关闭、Agent 退出、主 Session 绑定改变或显式 dispose 后，旧能力拒绝新调用。适配器必须重新解析 Bot 绑定并取得新能力。关闭客户端等待不取消共享执行；能力对象不向 client 暴露原始 Host 服务。

这属于同进程可信插件协作契约。其他同权限 Cordis 代码能够伪造来源或直接操作 Session，不把本接口宣称为安全沙箱。群聊/其他用户尚无可见域隔离，不能借 `ownerId` 或 TG Bot 账号名把他们提升为所有者。

## 请求身份与唯一队列

当前支持 1–262144 字节的非空文本、非空单行 `requestId` 及可选 `correlationId`；附件留给后续适配器。原平台请求 ID 可以包含中文、冒号等，最多 1024 个字符。Host 在第一次 await 前捕获输入字节。

原生 `source.kind` 为 `user`，`source.rpcId` 是 `mbot:` 加命名空间 SHA-256，作用域包含 botId、adapterId、ownerId、conversationKey、平台 requestId。`source.mbot` 保存版本、上述绑定、原请求 ID、关联 ID 及不可变内容指纹。回复路线/正文/关联 ID 不参与请求身份；同 ID 改动这些值会报 conflict，不形成另一条请求。不同 Bot/适配器/所有者/对话键各有独立身份。

`send` 使用公开 `Agent.followup`。一次串行操作只负责校验、查原生日志投影、追加和 flush，不等待模型结果，不持有数据 lease。模型消费始终由 DSH 驱动；没有第二个消费者或额外持久队列。原生 Web prompt 继续使用官方协议；其 `source.rpcId` 和旧 `source.requestId` 都纳入审计关联。显式 steer 的请求 ID 从实际 `user/message` 事件补入同轮 Git meta，不能把尚在 Inbox 中的消息算作本轮已执行。

重复提交从原生 `agent/inbox/spliced` 与 `user/message` 重建的索引找到原 MessageId，不追加消息。索引增量处理原生事件，重载从 sessionQuery 验证后的完整日志重建，继承的 fork 输入不成为当前 Session 的新请求。未使用 ignorable 展示记录作为去重或完成依据。

原生 Web 对仍在 Inbox 中的消息保留 MessageId 的编辑继续有效；已 claim 的输入不能通过这个路径编辑。适配器信封保持不可变，不能在原生队列里改正文后保留旧指纹：需要取消原请求并发送新 ID。DSH session-reference 等受信任前置处理可能保留 ID/来源、转换模型可见文本；去重仍使用原 Inbox 字节，而不是转换后的模型展示内容。

## 执行前闸门

组装系统提示前，Runtime 验证所有本次 claim 的来源，await Session flush，再取得数据 lease。之后每个新 claim 的 steer/inject 也经过来源与持久化闸门，不能借已有 lease 绕过。最终 pre-step 结果允许原 claim 的消息和已核实的原生上下文来源，新增业务消息必须先进入准入路径。

直接 `user/retry` 消息沿用 DSH 的所有者语义；带 `principal` 的非所有者消息被拒绝。MBot 信封核对 Bot、身份、格式及内容指纹。原生 runtime/time/tmux context、agent-instructions、user-question-reply、plan-mode、skill-catalog/invocation、session-reference、repeat-tool-reminder 保留；未接生命周期的 goal、jobs、peer 等来源暂停准入。新增来源需核实实际生产者，再补策略和验收，不能接受任意 kind。

flush/来源/租约准入失败且未执行的输入返回唯一原生 Inbox，等待检查/后续唤醒。Runtime 卸载会保留尚未模型可见的 claim；用户 stop 取消捕获的活动输入，保留其他待办。已模型可见的输入不会重新投递，工具/审计仍按原事务收尾。

## 收据语义与故障

`send` 和 `receipt(requestId)` 返回以下两个相互独立的维度：

| 字段 | 含义 |
|---|---|
| confirmation=confirmed | 本次 Session flush 成功，原生请求已持久化；执行可能仍未开始 |
| confirmation=unconfirmed | append 后无法确认存储或 Runtime 已关闭；可能已持久化或执行，必须用相同 ID 查回/重试 |
| delivery=queued | 原生 Inbox 中待处理，包括准入失败后归还的输入 |
| delivery=claimed | 原生 turn 已取走输入，尚未关闭 |
| delivery=ended + turn/reason | 原生 turn 结束；可能是错误/停止，甚至没有模型 step |
| delivery=cancelled | 原生 canceled splice 移除了待处理输入 |

缺失 requestId 查询返回 undefined；跨回复路线查询和已检测的请求冲突拒绝。返回原 requestId、rpcId、MessageId、botId、对话键和已绑定回复路线，调用方可精确关联；当前没有向 IM 发送回复或广播的实现。

`ended` 不证明 guard/Git 审计成功：Agent 可能已经空闲，Host 仍在验收/提交。用 [Runtime 审计状态](runtime-feedback.md) 查看事务结果；[请求结果](request-replies.md) 已交叉核验原生事件/journal/Git 并提供稳定回答信封，不能把展示事件当提交证明。外部平台副作用/回复 exactly-once 不在这里承诺。

DSH 0.2.2-rc.5 没有公开的仅唤醒接口。对于持久化失败后停在 Inbox 的输入，同 ID 重试只确认并复用原消息；下一条新 followup 会恢复 FIFO 消费。不会通过创建第二个 Agent、访问私有 wakeDriver 或合成空业务消息来唤醒。Bot 的 sleep/wake 与维护恢复已由 [持久阶段 journal](sleep-wake.md) 接入；它与这里的同 ID 消息重试有不同语义。agent-runtime 中断沿 [Host 协调恢复](runtime-recovery.md) 核验，不能用数据 recover 或删除 journal 绕过。

开发分支额外提供 [conversationMailbox](conversations.md#域-mailbox-与回复证明)，以持久来源/发送者许可向已附着的域 Inbox 收信，使用独立 v2 信封及域回复证明。它不改变上述 ownerMailbox 的所有者语义；额外域模型执行继续 reserved，真实适配器和 outbox 仍待交付。

## 验证

以下数量与临时路径保留首次专项验收时的历史记录；当前复跑入口见根 [PLUGIN](../PLUGIN.md)。

- 39 项 Host/Cordis、30 项真实 Agent Runtime、类型及 64 组 Bash 回归通过。新增覆盖并发同 ID、调用后字节变更、回复路线/来源篡改、Web/owner FIFO、steer 审计关联、flush 前不调用模型、投递不确定、信封版本/指纹篡改、停止/队列取消、重载/卸载、未知 inject、前置上下文/业务绕过及原生待办编辑。
- source/tarball/Git 基础安装与 Web tarball 安装通过；Web 安装夹具在真实主 Session 使用 ownerMailbox 并查回同 MessageId，没有重复调用模型。证据 `/tmp/mbot-plugin-install.jVFJWo`。
- Chromium 的真实安装/主 Session 回归通过，覆盖原生停止、排队、晚到写者、审计失败与多窗口重放；证据 `/tmp/mbot-gui-runtime.7tWH5e`。
- 完整回归日志 `/tmp/mbot-message-suite.log`；最后补充版本/指纹校验的 Runtime 日志 `/tmp/mbot-message-runtime-final.log`。复跑 `npm test`、`npm run test:install`；真实浏览器回归命令为 `npm run test:gui-runtime`，需指定临时 Playwright/Chromium 路径。本阶段使用本地 scripted adapter，不调用真实 DeepSeek API。
