# 受管理的 turn 事务桥（dev）

2026-11-27。本阶段实现主 Session 所需的事务基础，尚未接入 Agent 循环或创建实际主 Session，不代表 0.2 已交付。会话上下文投影、消息准入、Worker 权限、睡眠/checkpoint 和恢复仍按 [TODO](../TODO.md) 推进。

## Host 接口与数据边界

ctx.mbot.beginTurn({botId, sessionId, turn, request, requestIds?, signal?, finalizationTimeoutMs?}) 返回 TurnLease。它持有固定身份与不可变 snapshot，包括 Git HEAD 上的 AGENTS、SOUL、共享/角色 MEMORY 和看板。snapshot 不包含许可 token；凭据文字在返回上下文之前脱敏。

- execute(program, args, {input?, signal?}) 在当前事务内调用数据工具，仅允许 botctl 和 mbot status；不重入外部 Session 队列，也不产生 human commit。
- record(event) 保存调用方提供的本轮 Session 事件；模型工具调用、结果和顶层 usage 转成原有审计格式，原始事件另存私有日志。
- finish({reason, text}) 等待已拥有的数据调用及事件写入，执行 guard/审计/一次提交，返回结果；重复 finish 复用同一 Promise，关闭后不能新增操作。
- cancel() 取消并等待拥有的数据进程，再完成失败审计。published turn 的 signal 仅负责准入取消，活动中的取消由调用方显式管理。

这条桥不管理 DSH Inbox，也不创建第二套模型队列。Runtime 接入时须先让 Agent、Worker、工具静止，再交给 finish/cancel；当前桥只跟踪经自身 execute 发起的进程，不能把这部分验收当作所有原生工具/Worker 已接齐。

## 锁、许可与审计

随包 bin/mbot-turn 是 Host 专用 NDJSON 协议进程，持有数据仓库原有 flock 锁直至验收结束。它等待锁而不丢弃 DSH 可能已经 claim 的请求；取得锁后检查 PAUSED、干净工作树、角色/lint、Git 基准和控制路径，固定上下文快照。

运行内调用携带 runId/token，按子进程传递 MBOT_RUN_ID、MBOT_PERMIT_TOKEN 和目录，不修改 Host 的全局 process.env。botctl 在自己的事务锁内检查活动状态、身份、token 与期限；缺失、过期或另一代 permit 不能写入。旧 headless run 在没有活动 turn 时仍使用原接口。活动/遗留 journal 存在时，legacy 模型调用及人类写入也不能绕过；人类只读查询仍可检查现场。

完成后复用现有 guard：恢复非法记忆/协议/历史写入、HEAD 移动和控制路径异常，校验任务/看板，生成脱敏 transcript/meta，统一提交合法产出与审计。metadata 增加 Bot、Session、turn 和请求身份；失败沿用计数/暂停规则。提交前进入 committing 阶段，停止新的许可写入，成功后移除活动 journal。原始 Session 日志位于已有忽略目录 .mbot/runs，凭据和许可不入 Git。

默认完成阶段有 30 秒期限；完成等待失控会终止桥并保留恢复证据，不能假称提交成功。模型执行阶段的期限来自数据仓库 MBOT_TIMEOUT；真正接入 Runtime 时，还必须将期限与 Agent 取消/Worker 静止协调，而不是只停止数据调用。

## 断连与恢复边界

.mbot/runs/active-turn.json 记录 schemaVersion、阶段、身份、基准及私有 scratch 引用。EOF、异常退出或完成失败保留 journal/snapshot 并 PAUSED，不在可能仍有写者时贸然回滚/提交。遗留 journal 使新 turn、run/dream/archive、human mutation 和普通 resume 拒绝；只读检查可用。

本阶段证明“保留证据并拒绝危险续跑”，**自动/人工辅助的完整恢复命令尚未实现**，仍须补齐活写者核实、阶段/commit 识别、恢复/补偿以及 checkpoint 协调后再开放主 Session。恢复不能只删除 journal 或把一次未知投递当作 exactly-once 完成。

## 验收

- 类型检查与 28 项 Cordis 检查通过；新增真实 Bash/Node IPC 覆盖固定上下文、运行内工具不死锁、单次审计提交、非法 MEMORY/HEAD 回滚、过期 permit、两 Host 锁争用及等待取消、Session 工具/usage 事件、凭据脱敏、活动调用取消、脏目录/断连证据与完成超时。
- 原有 64 组 Bash 检查通过，覆盖 legacy run/tick/Dreaming/运维与恢复行为；没有读取真实 profile 或调用模型。
- source/tarball/Git 安装探针实际调用 beginTurn → remember → finish，再验证原有工具/命令/schema/bin/卸载。证据：/tmp/mbot-plugin-install.VgJQD5。
- 实际 Chromium/tarball 的 init/import/list/select/status、多窗口、profile 隔离和重启回归通过。证据：/tmp/mbot-gui-test.nCjUvz。这证明原界面回归通过，不是主 Session 上下文的验收。

下一步在组装系统提示之前接入 Runtime 的 lease 闸门、Agent-scoped SOUL/记忆提供者和受管理消息通道；验证真实模型视图中的旧快照 shadow、近期摘要与 compact，再完成实际工作区/主 Session 绑定。
