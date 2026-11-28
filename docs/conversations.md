# Conversation 身份与来源权限

本模块是 `0.2.0-rc.1` 之后开发分支的 P1 基础。registry v3 已支持持久预留和来源权限，额外对话域仍为 `reserved`：不创建原生实体，不运行模型、数据工具或摘要。记忆/工具可见域与实际激活属于下一步，路线以 [DESIGN](../DESIGN.md#对话域与外部消息) 为准。

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

`authorizeConversation` 只验证可信适配器提供的身份与现有许可一致；它不是平台认证，也不是执行许可。不能凭它创建 mailbox、启动模型或直接调用 ownerMailbox。主 Session 的所有者入口见 [消息准入](message-admission.md)。

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

上述验收只证明预留及拒绝边界，不代表已完成群聊、跨域记忆、IM、peer 或 outbox。具体运行结果记入 [RELEASE_NOTE](../RELEASE_NOTE.md)，剩余执行事项见 [TODO](../TODO.md)。
