# 前台 Runtime 中断恢复（dev）

本阶段为未发布的 dev，包仍为 0.1.1。恢复当前受管理的主 Session 与前台工具回合；Worker、PTC/后台或经 IPC 交接的写者、睡眠 checkpoint，以及原生日志缺失的恢复仍在 TODO。

## 使用

```text
/mbot recover [Bot ID 或名称]
/mbot runtime
/mbot status
/mbot resume
```

```bash
botctl recover --profile web --bot <稳定 bot-UUID>
botctl runtime --profile web --bot <稳定 bot-UUID>
```

从旧主 Session 发起时按其绑定选择 Bot；也可用稳定 ID 恢复退役 Bot 的遗留事务，旧 Session 仍保持退役。终端 recover 要求完整稳定 ID。执行/审计仍活动时拒绝且不取消模型，先 stop 并等待收尾。断连不撤销已转交的恢复，查询状态并用原 ID 重试。

`mbot -C <数据目录> recover` 保留数据子进程恢复能力；agent-runtime 必须由具有原生 Session Controller 的 Host 协调，不用普通 CLI 自报“所有写者已静止”。恢复不调用模型、不自动 resume；有 journal 的恢复结算后保持 PAUSED，检查审计后再明确恢复业务。

## 写者与原生事件证明

Runtime 的新 turn 保存 runtimeOwnership v1：foreground-only、workerDepth=0 和本轮固定工具名单。未声明前台生命周期、后加入本轮名单之外的工具，以及 run_code/spawn_agent/send_message 均不能作为该契约的写者。自定义前台工具仍是受信任 Host 的声明，必须实际等待所有写者，不把跨系统回执当作结束。现有同权限插件约束不是安全沙箱。

恢复流程：

1. Host 管理操作串行，Runtime 同步发布 Bot 级 recovering 闸门。网页/ownerMailbox 仍可接收输入；已 claim 的未执行消息返回原生 Inbox，不启动第二个队列。
2. Agent 必须空闲，业务 lease/审计和附着操作须已结束；等待捕获的消息操作与前台调用，拒绝存活的数据 helper。只结束了 Agent 不等于审计完成。
3. 使用官方 resolveAgent 取得同一 Session 的独占写者；writer-held、身份/目录冲突或实体缺失拒绝，不 create 替代会话。DSH 的原生 resume 会为崩溃末回合补齐缺失 tool/result、step/end、turn/end；MBot 不伪造这些事件。
4. flush 原生日志，核对 journal/private ledger/header、Bot/Session/turn、原始事件序列与保存的 finish。私有桥事件必须与原生同 seq 事件逐项一致；完整原生结束事件和模型文本决定恢复输入。已有 finish 冲突拒绝，原始文件保留。
5. 在 /tmp 的 700 目录生成 600 的 Host proof，绑定协调者 PID 出生身份、journal 指纹、原生 cut 和输入。桥持有两把数据锁，核实 proof、旧 Host/helper 与许可子进程；丢锁不等于旧写者已退出。当前契约不向已存在的 daemon/IPC 写者授予权限，读不到环境的新进程保守拒绝；退出中的短暂 /proc 读取失败会重新核实同一 PID 出生身份。
6. 使用原预算、Git/锁 inode、guard、commit intent 与统一 outcome 结算。SIGKILL 留下的 active permit 先失效。已提交时核对原生回答、Git tree/父提交/ref/提交说明/审计，只结算一次；未提交时恢复合法数据并补审计。
7. 保存原生审计回执后解除恢复闸门。Git 成功、回执 flush 失败时保留内存中的确切审计，下一次只核验 Git/原生事实并补回执，不重复提交。恢复期间的取消/期限或第二次崩溃保留现场；协调者的 proof 在提交/结算前再次验证。Host 等待阶段有 60 秒期限。

已有 Host 审计文件在提交失败后可能仍位于数据工作树。重试仅清理与准确 commit intent 和私有副本匹配、且基准 HEAD 中不存在的 Host 产物，再运行 guard；修改过的副本按正常越权规则处理，不把恢复新增审计误记成模型越权。

旧的无 runtimeOwnership 请求头，只能由仍持有该回合 lease/失败审计记录的原 Host 作静止确认。缺少新 messages 的旧头可继续旧格式审计，不能生成 sealed reply 或虚构已核验回答。没有原 Host 的捕获记录时，已结束且全为核心只读调用的旧回合可用 [只读迁移证明](legacy-migration.md) 恢复；其他旧契约保留 journal，继续走后续迁移/人工核实设计，不通过修改 writerScope 或删除证据放行。

## 结果与边界

恢复返回 kind=recovered；needed=true 包含 runId/head/meta/success/outcome/failureCountEffect 和 alreadyCommitted。completed 归零，干净 user 取消保留原故障链，原生 interrupted 或其他故障递增。原生/Git/journal/flush 一致后 receipt 才释放固定路线的回答；中断且没有完整回答时文本为空，不补造模型回答。

无 journal 时通常返回 needed=false；若修复已提交回合的原生回执，另有 receiptRepaired=true。展示卡片只表达结果，不参与静止或事务证明。旧记录、缺失原生日志、未知契约、无法核实的写者、HEAD 移动、快照/锁损坏仍拒绝自动恢复。

## 验收

使用真实 AgentLoop、前台工具、原生 Session/Workspace Controller、实际 Git 和本地 scripted adapter；没有调用 DeepSeek API。专项覆盖提交失败、两处提交崩溃边界、Runtime 重载、并发原生输入、存活许可进程/执行中 Agent/writer-held 拒绝、旧头兼容、退役身份及回执失败的两次重试。

浏览器使用实际 tarball：主 Session 提交失败后 /mbot recover；模型正在运行时 SIGKILL Host，重启后 DSH 原生 closers 与 botctl recover 结算，receipt 查回同一请求的失败结果，PAUSED 保留，显式 resume 后新对话成功。完整回归与安装证据见 RELEASE_NOTE。

只读旧契约的 cold Host recover 与独立 migrate-readonly 共用原生/核心工具/Git 证明；独立工具只读原生日志，保留运行中旧 Host 的内存状态，需加载新 Runtime 后继续业务。
