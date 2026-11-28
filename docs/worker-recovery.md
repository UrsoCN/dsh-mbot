# Worker 回合恢复与运行时交接

当前基线 `0.2.0-rc.1`。本阶段扩展 [前台恢复](runtime-recovery.md)，支持 [原生 Worker](native-workers.md) 当前的 scoped botctl 契约：父 journal v3、runtimeOwnership v2、深度 1、最多两个并行 Worker。Bash/文件/PTC、跨系统写者、未知旧契约以及丢失原生日志的恢复仍须各自证明，不能套用本契约。

## 使用与原生写者

继续使用 `/mbot recover [Bot]` 或 `botctl recover --profile web --bot <ID>`。执行/写入尚未静止时先 stop；恢复保留主 Session、Bot 身份、待办与 PAUSED，完成后由用户检查审计并显式 resume。独立数据 CLI 不能自行恢复 agent-runtime。

Runtime 先建立 Bot 级恢复闸门并取得父 Session 的原生 writer。每个 Actor 的原生子 Session 也要取得独占写句柄；存活 Agent 或 writer-held 拒绝。子会话不经过模型或子代理重新激活：直接使用 DSH 公开的 `interruptedTurnClosers`，与 Agent.resume 使用同一算法，持有句柄直到 Git 和回执结算完成。未处理的子输入保留在旧日志中，不消费为已完成工作，也不重新获得旧任务许可。

先校验原始 Actor 身份、固定快照 hash、子 Session lineage/cwd/继承边界，以及私有事件在原生日志中的准确前缀，再补 native closers。连续事件、成对工具调用/结果、原生输入、最终输出、结束原因与用量共用原生 Worker 的证明逻辑。已 sealed 的执行不能变成不同结果；恢复生成的空 seed marker/空取消不算新的业务执行。

进程检查同时核实父 permit 和所有派生 Actor permit，不能只检查父 token。旧 Host/helper 的 PID 出生身份、两把数据锁、Git 基准、快照与 journal 仍按既有规则确认。无法读取的可能写者、未知工具名单、非原生 Actor、缺失/冲突的子日志保留证据并拒绝。

## 原始证据与恢复输入

原始 `ledger.json`、Actor 快照、子事件和 sealed 结果保持不变。恢复在私有 scratch 中派生 `runtime-recovery.ledger.json`，含已核验的 revoked Actor/原生证明，供统一审计使用；原 journal 不降版本，也不靠删除 active Actor 字段通过验收。

两把数据锁取得后，原许可先由 abandoned phase 失效。恢复 ledger 必须与 Host proof、原始 journal 和原生子日志逐项一致，提交与计数前重复核对。恢复成功后由父回合单次结算并清除原 journal；恢复提交失败或再次中断可以重查原证据，派生文件存在时必须内容一致，编辑或伪造恢复 ledger 会被拒绝。

Git 已成功时，核对原始 commit intent、父/native 结束事实和每个子证明，只结算原提交。Git 成功但回执 flush 失败时，下一次查询原生子日志与 Git Actor 审计，再补回执，不重复提交。v3 的 request receipt 同时验证子证明与父输出，Worker 故障计入整体 outcome；回答仍只交回原请求路线。

辅助 Node 脚本使用连续 UTF-8 解码读取 stdin。大段中文上下文可能跨 buffer 边界，逐块 Buffer.toString 会损坏事件内容和 hash；不能把这种传输损坏当成新上下文，也不能通过放宽 hash 检查修复。

## Provider 与 Runtime 替换

原生 provider 卸载仅撤销新准入，已接受的 activation 仍由 SDK/当前 turn 持有，必须 join 后才能撤销 Actor；重新登记的 fresh provider 用于新任务。Runtime 真正替换模块时，先等待旧 Worker 的 Agent、数据写入、事件/结果证明和父审计，再接管同一主 Session；失败审计及请求身份保留。

子 Agent 已释放但 Actor 尚在 seal 阶段，也不再接受 creator message。Runtime 检查确切 live Agent 并拒绝同一 reservation 再发布 Agent，防止底层 sendMessage 的 cold-resume 能力恢复旧任务上下文。

## 验收

真实 AgentLoop、原生 JSONL persistence、SDK write handles 和实际 Git 验证：提交失败恢复、原提交的两个 SIGKILL 边界、子 writer 占用、派生许可进程残留、私有子事件/恢复 ledger 篡改、恢复提交失败后的重试、v3 故障回执、真实模块交接、provider 替换及 release/seal 竞态。stdin 测试强制从中文字符中间分块。

Chromium 在实际 tarball 的主 Session 派活，Worker 写入结果/候选并等待时 SIGKILL Host；重启后保留原主 Session，核验 native closers、一次父审计、故障计数、PAUSED 与失败回复，确认没有再次调用子模型。具体日志/产物见 [发布说明](../RELEASE_NOTE.md)。
