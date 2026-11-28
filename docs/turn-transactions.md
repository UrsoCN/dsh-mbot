# 受管理的 turn 事务桥

当前基线 `0.2.0-rc.1`。本模块维护事务桥和 data-subprocesses 恢复契约；真实 Agent 通过 [原生 Runtime](native-runtime.md) 接入，Agent/Worker 与维护中断分别沿 [Runtime 恢复](runtime-recovery.md)、[Worker 恢复](worker-recovery.md) 和持久维护 journal 协调，独立数据恢复的范围不随之扩大。

## Host 接口与数据边界

ctx.mbot.beginTurn({botId, sessionId, turn, request, requestIds?, signal?, finalizationTimeoutMs?}) 返回 TurnLease。它持有固定身份与不可变 snapshot，包括 Git HEAD 上的 AGENTS、SOUL、共享/角色 MEMORY 和看板。snapshot 不包含许可 token；凭据文字在返回上下文之前脱敏。

- execute(program, args, {input?, signal?}) 在当前事务内调用数据工具，仅允许 botctl 和 mbot status；不重入外部 Session 队列，也不产生 human commit。
- record(event) 保存调用方提供的本轮 Session 事件；模型工具调用、结果和顶层 usage 转成原有审计格式，原始事件另存私有日志。
- finish({reason, text}) 等待已拥有的数据调用及事件写入，执行 guard/审计/一次提交，返回结果；重复 finish 复用同一 Promise，关闭后不能新增操作。
- cancel() 取消并等待拥有的数据进程，再完成失败审计。published turn 的 signal 仅负责准入取消，活动中的取消由调用方显式管理。

这条桥不管理 DSH Inbox，也不创建第二套模型队列。Runtime 接入时须先让 Agent、Worker、工具静止，再交给 finish/cancel；当前桥只跟踪经自身 execute 发起的进程，不能把这部分验收当作所有原生工具/Worker 已接齐。

原生 Runtime 使用 writerScope=agent-runtime，并提供 onExpiry/onCancel 的所有者收尾回调：先取消 Agent、等待本轮 end 与前台写者，再调用桥完成。默认 data-subprocesses 继续用于独立桥；两种 scope 的恢复能力不能混用。完成期限仍由 finalizationTimeoutMs 控制，管道读期限另留出对应收尾时间。

## 锁、许可与审计

随包 bin/mbot-turn 是 Host 专用 NDJSON 协议进程，持有数据仓库原有 flock 锁直至验收结束。它等待锁而不丢弃 DSH 可能已经 claim 的请求；取得锁后检查 PAUSED、干净工作树、角色/lint、Git 基准和控制路径，固定上下文快照。

运行内调用携带 runId/token，按子进程传递 MBOT_RUN_ID、MBOT_PERMIT_TOKEN 和目录，不修改 Host 的全局 process.env。botctl 在自己的事务锁内检查活动状态、身份、token 与期限；缺失、过期或另一代 permit 不能写入。旧 headless run 在没有活动 turn 时仍使用原接口。活动/遗留 journal 存在时，legacy 模型调用及人类写入也不能绕过；人类只读查询仍可检查现场。

完成后复用现有 guard：恢复非法记忆/协议/历史写入、HEAD 移动和控制路径异常，校验任务/看板，生成脱敏 transcript/meta，统一提交合法产出与审计。metadata 增加 Bot、Session、turn 和请求身份；失败沿用计数/暂停规则。提交前进入 committing 阶段并在私有快照中保存 commit-intent.json（准确 tree、父提交、ref、提交说明和审计路径），停止新的许可写入；成功后移除活动 journal。原始 Session 日志位于已有忽略目录 .mbot/runs，凭据和许可不入 Git。

默认完成阶段有 30 秒期限；完成等待失控会终止桥并保留恢复证据，不能假称提交成功。模型执行阶段的期限来自数据仓库 MBOT_TIMEOUT；真正接入 Runtime 时，还必须将期限与 Agent 取消/Worker 静止协调，而不是只停止数据调用。

## 断连与恢复边界

.mbot/runs/active-turn.json 记录阶段、身份、基准及私有 scratch 引用。普通前台使用 schemaVersion 2（reader 兼容完整 v1）；显式委派契约使用 schemaVersion 3，见 [Worker 数据许可](worker-leases.md)。旧 v1 reader 拒绝新版 journal，不能降级字段绕过。EOF、异常退出或完成失败保留 journal/snapshot 并 PAUSED，不在可能仍有写者时贸然回滚/提交。遗留 journal 使新 turn、run/dream/archive、human mutation 和普通 resume 拒绝；只读检查可用。

当前提供 ctx.mbot.recoverTurn({botId?, sessionId?, signal?})、/mbot recover 和 mbot -C <目录> recover。恢复不调用模型，不自动 resume：

1. 非阻塞取得 Bot 锁，核实 journal 与私有 ledger/header/token 一致、scratch 所有者/700 权限、必需文件及所有祖先路径。合法忽略文件的叶子软链可原样保留，不能通过祖先软链读写快照外的文件；缺失或不完整的快照留待人工核查。
2. 结合 PID 和 /proc 出生身份检查 helper/Host 与许可子进程，避免把 PID 复用或僵尸当存活写者。Host API 先取消并等待本服务的已断连 lease，再确认同进程所有者；普通 CLI 不替一个仍活着的 Host 作此确认，应从该 Host 执行 /mbot recover 或先停止它。
3. 核实 Git 绑定/目录 inode、两把锁 inode，取得 botctl 锁。SIGKILL 遗留的 active permit 先变为 abandoned，即使恢复随后失败，旧许可也不能继续写。使用保存的六项预算/期限，不先加载可能已被非法改坏的配置。
4. 若 HEAD 与保存的 commit intent 的 tree、唯一父提交、ref、完整提交说明及 Bot/Session 审计匹配，说明提交已完成，仅结算计数和移除 journal；不重做提交。HEAD 不匹配时保留现场并拒绝，不能删除人类后来的提交。
5. 尚无完成提交时，使用已保存的 finish，或生成 aborted outcome；复用 guard、脱敏审计与提交，合法任务保留，非法 MEMORY/协议/配置恢复。新审计带 runtime.recovered。恢复再次中断仍保留证据；失败计数根据本轮基准结算，重试不累加同一轮。

恢复结果的 kind=recovered，needed=false 表示已无活动 journal；needed=true 时返回 runId/head/meta/success 和 alreadyCommitted。恢复成功仍保持 PAUSED，检查 status/审计后显式 resume。不要手动删除 journal 代替恢复。

**范围**：journal 的 writerScope=data-subprocesses 明确限定为本桥启动的 fresh 数据子进程及其 botctl 写锁。进程检查对读取不到环境的新进程保守拒绝；出生早于 helper 的受保护守护进程不属于本桥的新数据写者，旧 Host 则单独检查。既有进程经 IPC 获得权限、真实 Agent/Worker、通用 shell/FS 或后台任务尚不受这套范围假设覆盖，必须扩展所有权和静止协议。旧 dev journal 缺少新恢复字段时明确拒绝自动恢复；0.1 发布版本没有此类 journal。已支持 Agent/Worker 与维护的恢复由 Host 的各自契约协调，见 [Runtime 恢复](runtime-recovery.md)；跨系统写者和投递仍待扩展。

## 验收

以下数量与临时路径保留首次专项验收时的历史记录；当前复跑入口见根 [PLUGIN](../PLUGIN.md)。

- 类型检查与 33 项 Cordis 检查通过；真实 Bash/Node IPC 覆盖固定上下文、运行内工具不死锁、单次审计提交、非法 MEMORY/HEAD 回滚、过期 permit、两 Host 锁争用及等待取消、Session 工具/usage 事件、凭据脱敏、活动调用取消、脏目录/断连证据与完成超时。恢复新增存活许可进程、SIGKILL 后旧许可失效、损坏 completion 的重试、坏配置恢复、快照/软链/锁拒绝，以及 Git 提交后和 committed 回执后的两处真实强制退出；核对只产生一次提交及计数。
- 原有 64 组 Bash 检查通过，覆盖 legacy run/tick/Dreaming/运维与恢复行为；没有读取真实 profile 或调用模型。
- source/tarball/Git 安装探针实际调用 beginTurn → remember → finish，以及中断 → recover → 重试 no-op → resume，再验证原有工具/命令/schema/bin/卸载。证据：/tmp/mbot-plugin-install.0oZimU。
- 实际 Chromium/tarball 的 init/import/list/select/status、多窗口、profile 隔离和重启回归通过。证据：/tmp/mbot-gui-test.D2fWYP。这证明原界面回归通过，不是主 Session 上下文的验收。

真实 Agent 的组装前 lease、Agent-scoped SOUL/记忆、受管理消息和原生实体绑定已经接入 [Runtime](native-runtime.md)；近期摘要与来源证明见 [摘要](managed-compaction.md) 和 [checkpoint](context-checkpoints.md)。上述数据桥测试只证明桥自身范围。

Managed turn 的结果现返回 outcome/failureCountEffect，审计 meta 保存版本化取消/故障判定。干净的原生用户停止保留 baseFailures，completed 归零、failed 递增；恢复使用相同校验与结算，旧 meta 按原 success 布尔值处理。规则与新增故障验收见 [turn outcome](turn-outcomes.md)。

Host 前台 agent-runtime 恢复已单独交付：原生独占写者/closers、固定 foreground-only 契约、Bot 准入闸门、私有 proof、原生/Git 回执验证与单次结算见 [Runtime 恢复](runtime-recovery.md)。本文的数据子进程边界继续用于独立 CLI；它不会自动扩展到 Worker、后台/IPC 写者或 checkpoint。
