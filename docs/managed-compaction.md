# 主 Session 的受管理自动与手动摘要

当前基线 `0.2.0-rc.1`。本模块接管 DSH 原生自动/手动 compaction 的摘要策略，与 [turn checkpoint](context-checkpoints.md) 一起审计和恢复；普通 turn 旧摘要退役、手动维护与 [sleep/wake](sleep-wake.md) 已交付。目标契约见 [Session Runtime](session-runtime.md)。

## 接口与归属

DSH 0.2.2-rc.5 的普通 Agent 模型请求来自原生日志重放，不能在 `llm/stream` 中间件中改写消息。辅助请求允许生产方在 `@deepseek-ai/dsh-llm/types` 扩展用途；MBot 声明 `mbot-compaction`，通过 Agent 范围的闸门生成独立摘要请求。

DSH 继续决定压力、overflow、压缩范围、工具配对、缩小检查以及 start/summary/replacement/end。MBot 核实原生 `compaction` 请求与当前 surface 的对应范围，发起只带摘要协议和结构化来源的辅助请求，向原 compactor 返回摘要文本。其他 Session 的 compaction 不受此闸门影响；普通模型请求不改写。

Web profile 可能关闭根层 compaction 后端。受管理 Agent 没有继承后端、但具有原生 tokenMeter 时，Runtime 在它自己的 scope 显式 isolate compaction 并安装官方 BasicCompaction；既有后端复用，Agent scope 释放时清理。原生 `/compact` 命令也在该 Agent scope 注册，通过下文的统一维护屏障执行；裸 `compactNow` 仍受闸门限制。共享 cell 保存后端/命令 fiber，代码交接不重复注册；不同 Bot 的后端和命令各自绑定，根 scope 不获得这些实例。自定义精简 profile 缺少 tokenMeter 时保留原配置，不虚构自动压缩能力。

辅助请求不携带 SOUL、协议、MEMORY、runtime-context、工具定义或 toolHistory。`botctl boot` 的结果包含人格/记忆，因此不作为对话摘要材料；其他文本工具结果保留来源。非文本附件只保存类型/hash，模型 reasoning 与工具调用参数不当作事实正文。

每条摘要 item 都有 `sourceEventSeqs`。Runtime 依据原事件标注 user-input、external-data、model-report 或 tool-result，固定 owner-private 可见域。模型只允许生成有合法引用的有限文本 items，空数组是有效摘要；来源不存在、格式错误、工具输出、截断、超限与取消均不能落成有效 replacement。来源/用途证明提供追溯能力，不能保证模型归纳的每一句话都正确。

## 取材、复用和预算

每次辅助请求绑定本轮 run、Session、Git memoryCommit、知识内容版本、原生 compaction ID/startSeq 与输入日志 cut。按 surface 顺序取材，不能把 seq 排序后推断范围。

已核验、同知识版本的旧摘要可以复用其 items 和原始引用。未核验的旧摘要或知识版本变化后的旧摘要，沿原生 shadowedSeqs 展开到原始资料，再生成新摘要，不直接沿用旧摘要断言。递归深度、来源数量和模型输出项数有上限。

正文在传输前使用本轮数据许可脱敏，审计保存原事件引用/hash、脱敏位置及实际辅助请求 hash，不把全文历史再复制进 Git。Runtime 的 `compactMaxBytes` 默认 262144，允许 4096–4194304 UTF-8 字节；超限在调用摘要模型前拒绝，不静默截断来源。摘要 provider/model/maxTokens 继续服从原生 compactor 的已选值。

## 审计和恢复

原生追加 `plugin:mbot/compact-input` 与 `plugin:mbot/compact-output`。输入记录策略 hash、请求 hash、范围候选和原始来源；输出记录响应 blocks hash、已验证 items、带来源的渲染文本、用量及完成/失败状态。原生 summary 和 replacement 必须与该输出及 range 一致。

数据桥通过 `compactionPolicyVersion=1` 握手确认能力，header、journal、context-snapshot 与 Git 审计中的 `compaction_policy_version` 保持一致。每轮 `runtime.compactions` 封存唯一的原生括号、输入/输出与 replacement 位置；摘要用量纳入同一次顶层审计。已经捕获的新契约不能丢掉证明而降级为旧契约。

`ctx.mbotRuntime.checkpoint(agent)` 的 `compactions` 返回该 checkpoint 回合的摘要证明，不表示该回合又生成了一份摘要；所有历史已审计摘要另由 Runtime 校验后建立复用索引。有效值仍只在数据结算与 Session flush 后发布。

恢复先核对原生日志、来源与此前已审计摘要，随后用现有前台 Runtime 协调恢复完成 Git/journal/flush。Git 成功但结算或回执中断时，只补缺失阶段，不重复模型、原生 replacement 或 Git 提交。缺失输入/输出、摘要与 native replacement 不一致或来源冲突时保留证据并拒绝继续业务。

已注销 Bot 没有活动 Runtime 状态；其恢复从原生日志和可达 Git 审计重建摘要索引，仍核对原生 surface fold 与知识/Worker 证明，不把它重新加入业务路由。重复摘要的来源不会因注销丢失，也不借恢复重开旧 Session。

Agent 的共享 gate ABI 升为 2。已关闭且带共享 registry 的 ABI 1 Runtime 可以在原 Agent 上安装一次新的 LLM 闸门；首次/升级注册失败只回滚自己的 effects。没有共享 marker 的旧闸门仍不在支持范围内。

## 手动维护闭环与旧摘要退役

- **普通 turn 边界旧摘要退役**：在 `reconcileContext` 中比对当前 surface 上已存在的 `compact-checkpoint` 摘要与本轮 Git `knowledgeVersion`；一旦人格/记忆更新，即使未达到压力阈值也会在普通 turn 边界通过日志记录的 `surfaceOp: replace` 退役旧摘要并声明以当前 SOUL/MEMORY 为准。后续 compaction 遇到已退役摘要时按 `shadowedSeqs` 展开原始来源重派生，不会复用过期结论。
- **手动 `/compact`、`/mbot compact` 与 `botctl compact`**：均收口至 `ctx.mbotRuntime.compact(agent)`，串行经过 `BotCoordinator.acquireBarrier(botId, 'compact')`、Bot 数据锁（`.mbot/lock`）与持久维护 journal（`<stateRoot>/maintenance/<workspaceHash>/current.json`，原子写+`fsync`+`bootId`）。未走维护屏障的裸 `compactNow` 仍被闸门拒绝。
- **部分替换/中断冷恢复**：`recoverMaintenanceCompaction` 在 `/mbot recover` 路径上检查未结算的 `compact` 维护 journal；若发现未闭合的 `compaction/start` 且无 `summary` 残缺，自动补齐错误 `compaction/end`、重新核验来源并清理 journal；若发现有 `summary` 却缺失原生 replacement，保守拒绝并保留现场供人工复核。

## 尚未完成

- Worker 自动摘要、原生日志丢失及其他 Writer 契约未接齐；不能凭展示记录推定它们已静止或已完成。
- 单私人主 Session 的 sleep/wake 已交付，见 [睡眠维护](sleep-wake.md)；额外 conversation 的可见域与逐域维护仍按 [DESIGN](../DESIGN.md#后续路线) 扩展。

## 验证

以下数量与临时路径保留首次专项验收时的历史记录；当前复跑入口见根 [PLUGIN](../PLUGIN.md)。

真实 Agent/Session、本地 adapter 验证原生压力触发、工具配对、来源/可见域、重复摘要、知识变化时展开、空摘要、非法引用、预算、取消/多窗口待办、持久 resume、SIGKILL 后单次恢复、提交后 flush 失败及缺失输出拒绝。`npm run test:real-compaction` 单独调用真实 DeepSeek 生成摘要，普通对话使用本地 adapter；凭据只由环境提供，数据与日志在 /tmp，默认测试不调用 API。

类型、188 项本地 Host/Runtime 和 64 组 Bash 检查通过；真实摘要单独验收通过。`npm run test:gui-compaction` 以实际安装包和 Chromium 验证主 Session 的原生摘要、Git checkpoint、刷新与原生 standalone 命令拒绝，暴露并验收 Web scope 缺后端的补装路径。证据与安装记录见 [发布说明](../RELEASE_NOTE.md)。
