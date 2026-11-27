# 主 Session 上下文 checkpoint 基础（dev）

本阶段持久化并核验每轮的上下文取材基准。后续 dev 已接入 [受管理自动摘要](managed-compaction.md)，手动 compact 与 sleep/wake 仍待完成。包仍为 0.1.1；完整目标见 [Session Runtime](session-runtime.md)，剩余阶段见 [TODO](../TODO.md)。

## 知识版本与每轮快照

数据桥持有 Bot 锁并捕获 Git HEAD 后，读取 AGENTS、当前角色 SOUL、共享 MEMORY 与角色 MEMORY 的 Git blob 和内容 hash。它们组成 `knowledge.version`；任务、看板、候选或审计提交不会改变该版本。嵌套的知识身份和快照均冻结，调用方不能通过数组成员改写本轮基准。

Runtime 在模型提示组装前发布 `plugin:mbot/context-snapshot` 原生记录，内容为：

- schemaVersion=1、kind=turn-input、owner-private 可见域，以及 Bot/角色/Session/turn/run 身份；conversationId 暂用实际 Session ID。
- memoryCommit、知识文档 blob/hash 与知识版本；contextEpoch 从上次已核验 checkpoint 继承，仅知识内容变化时增加。
- sourceCut 的原始日志边界，以及按原生 surface 顺序排列的近期对话事件引用/hash。人格系统段、developer 信息与 runtime-context 由原生/Runtime 重新组装，不混作近期对话。
- 已 claim 输入的 MessageId/hash，与原生日志中接受的 Inbox 字节核对；输入正文仍只在原生事件中保存。
- 上次已核验 checkpoint 的 commit、snapshotHash、知识版本与 epoch。

捕获后重新核实原生日志边界，避免在异步读取期间漏掉新事件。sourceCut 的可见 seq 可以不单调：原生 replacement 会把较新的事件放在历史位置，读取/恢复不能排序这些引用。

`mbot:turn` 模型上下文显示 epoch、知识版本、snapshotSeq 和原始 cut；本轮人格/记忆仍取固定 Git 快照。近期实际消息继续由 DSH surface/Inbox 组装。checkpoint 不创建另一套历史或消息消费者，也不重复投递已 claim 输入。

## 发布与恢复证明

原生 snapshot 是取材记录，本身不证明回合已提交。父 turn 等工具/Worker 静止、完成原生回合后，数据桥核对 snapshot 身份及 Git 知识对象，把 snapshot 和 hash 封存到同一次审计提交的 `runtime.context` 中。只有数据结算完成且 Session flush 成功，Runtime 才发布有效 checkpoint。

`ctx.mbotRuntime.checkpoint(agent)` 返回已核验 checkpoint，首个已审计 snapshot 之前返回 null；正在执行的新回合不会提前替代上次有效值。返回值是独立副本，包含 snapshot、snapshotSeq/hash、commit、meta 和 turn。未确认的审计/持久化错误继续拒绝该查询与后续业务准入。

查询返回该次原生/Git 观察中的 checkpoint；期间完成的新回合不会被旧查询覆盖。查询/恢复读操作串行登记，Bot 注销或 Runtime 关闭先等这些 helper 和原生 flush 静止再释放归属。原生捕获与 Git 读取跨过新提交时重新观察，不把正常并发误作缺失证据。

连续新提交使三次观察仍无法对齐时，查询返回 `MBOT_CONTEXT_OBSERVATION_CHANGED` 供调用方重试，Bot 不计故障或暂停。真正缺失/冲突的 snapshot、Git 或来源证据继续拒绝业务准入。

重启、原生 Session resume、Runtime 模块交接和 `/mbot recover` 共用以下证明：

1. 原生 Session 身份及 snapshot 与可达 Git 审计一致，原生结束、回复/结果、故障计数语义保持原有校验。
2. Git 知识对象、snapshot hash、前序 checkpoint 链一致；有多份审计认领同一 turn 或证据缺失时拒绝。
3. 用原生 SDK 的 surface fold 重建各捕获前缀，核对全部有序来源及已接受的 Inbox 输入字节。
4. 最近含 Worker 的回合继续核验子日志/Actor 原生证明，不把父 snapshot 当作 Worker 静止证明。
5. 原 active-turn journal 尚未结算时，已写入 Git 的该回合 checkpoint 仍不发布。Git 成功但原生 flush 失败时只修复确认，不重复模型、提交或增加 epoch。

独立 helper 只依赖 Node、Git 与仓库代码，不使用 Host 的 SDK loader，不创建 Agent/Session。Host 负责原生 surface fold 和 Worker 日志读取。恢复事件过滤保留 context-snapshot；其他 ignorable 展示记录仍不能代替事务证明。

旧回合没有 snapshot 时保留原审计格式，不合成历史 checkpoint 或回复证明。已经捕获 snapshot 的回合若审计丢掉 context 证明，则拒绝降级。取材失败若发生在取得数据 lease 后，使用真实原生 blocked/cancelled 结果完成审计、释放许可，未执行输入留在原生 Inbox。

## 后续边界

这里保存的是 turn 输入基准；它不等于已经生成摘要。[自动摘要](managed-compaction.md) 已补充原生 compaction ID、摘要输出/hash、摘要范围及来源/可见域证明。没有 MBot 证明的旧原生 replacement 可以被引用为 surface，但不因此成为遵守 MBot 摘要规则的证明；睡眠仍须自己的阶段 journal。

后续继续接手动 compact、普通 turn 的旧摘要退役、替换过程中的冷恢复与维护屏障；然后实现 Dreaming → compact/checkpoint → wake。主 Session ID 和原生日志保持稳定。

## 验证

类型、172 项 Host/Runtime 和 64 组 Bash 检查通过，含知识版本/epoch、原生持久 resume、来源顺序及字节冲突、缺失全部 snapshot、提交/flush 中断、旧头兼容、查询/提交并发与重试、Runtime 交接/注销读操作静止。source/tarball/Git/Web 四类安装验证实际 checkpoint API；Chromium 验证安装包的 Worker 崩溃恢复、原主 Session 和单次 Git 审计对应的 checkpoint。使用本地模型 adapter，未调用真实 API；证据见 [发布说明](RELEASE_NOTE.md)。
