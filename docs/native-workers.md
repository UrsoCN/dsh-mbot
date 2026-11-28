# 原生 Worker 与主 Session 的上下文边界

当前基线 `0.2.0-rc.1`。在 [角色/任务许可](worker-leases.md) 上接入真实 DSH fresh 子 Agent，默认开启 scoped botctl 并支持 v3 恢复。Worker 不继承主 Session 历史；独立 Bot 通信仍按 [统一入口设计](session-runtime.md) 规划，Bash/文件/PTC 与 Worker compaction 尚未交付。

## 启用与使用

`dsh-mbot/runtime` 的 `workers` 默认 true，当前只开放 scoped botctl。可在对应 profile 中设置 false 保持前台模式：

```yaml
- id: mbot-runtime
  config:
    workers: false
```

需要原生 `subagents` 服务和 `spawn` provider。Host 不另起模型进程，不安装自己的 Agent 工厂；provider 必须声明不继承父上下文，创建结果还须通过 origin、parentSession、depth、cwd、seed 和实际继承事件数的验证。

开启后，主 Session 的原生 botctl 增加：

| action | 参数 | 行为 |
|---|---|---|
| worker_spawn | bot、task_id、可选 text | 预留 doing/owner 匹配的任务，再创建 fresh 子 Session，返回 worker_id |
| worker_wait | worker_id | 等该回合的指定 Worker 结束，返回输出、结束原因和审计摘要 |
| worker_message | worker_id、text | 原生树内向仍活跃的 Worker 纠偏，保留 creator 来源 |
| worker_stop | worker_id | 只停止并 join 该 activation，不取消 Chief |

这些操作仅属于当前活跃的 Chief turn。原生 `spawn_agent`、`send_message` 不绕过门面；关闭开关或缺少服务时不开放委派。结束的 Worker 可以查询本轮结果，但不能通过消息恢复其旧数据许可；需要补充工作时创建新的 fresh Session。每个任务同时只有一份活跃许可，深度 1、最多两个并行 Worker。

## 上下文与权限

Worker 使用父 turn 固定 Git HEAD 上的 SOUL、协议、共享 MEMORY 和自身角色 MEMORY，以及委派时的看板/任务快照。首条数据工具必须 boot 分配的角色和任务；父 Session 的历史和私有角色记忆不传入子模型。

Worker 当前只有 scoped botctl：读取分配任务/看板/lint、追加自身任务结果、投递候选。没有 Bash、文件编辑、其他 Agent 控制或 PTC 权限。已有独立 headless run/tick 的 Worker 能力保持原契约，不与这个原生阶段混为一谈。

委派前通过原生 sandboxPolicy/approval 授权任务数据操作。一次批准只派生该角色/任务的数据许可，不提升父/子 Session 的 sandbox mode；子工具复用派生许可，避免每次追加重复申请同一授权。数据 permit 再检查任务归属、状态与作者，不能把源于同 UID Host 的接口约束当成恶意插件沙箱。

## 收尾、取消与审计

Runtime 持有每次 `startActivation` 返回的确切 activation/result/dispose。普通父回合结束等待本轮全部 Worker；父取消、超时和 Runtime 关闭先停止原生 Agent/工具，再等数据调用和事件记录完成，seal 子执行证明，撤销 Actor，最后由父 turn 统一提交。

`worker_wait` 的取消仅退出等待；`worker_stop` 停止指定子执行。关闭浏览器或外部调用断连也不能取消共享业务。原生 Worker 创建阶段中断须完成 SDK rollback，并保存失败/取消的启动证明，不能遗失尚未发布的 Actor reservation。

启动取消根据原生 signal/cause 身份识别；并发取消不能掩盖真实创建或清理错误。停止回调不重写父回合结束原因，Git 审计以原生 turn/end 为准。正常用户停止保留原故障计数；已记录的 Worker 工具/模型错误、max-tokens/refusal 会使父回合 failed。

子事件保存在私有事务快照中，与主 Session 保持不同的 seq 域。证明核对连续事件、Session/assignment/快照身份、调用与结果闭合、原生输入消费/取消、最终输出、结束原因及用量。Git meta 仅保存无 token 的 Actor 信息和证明摘要；原始子事件不复制进主会话。`delivery: caller` 禁止原生自动完成通知注入主 Session，Chief 通过显式结果或任务文件验收。

父回合提交后 Actor 已关闭，活跃 Worker registry 已清理，旧工具和许可不得继续写入。原生未预留的子 Agent，包含已退役 Bot 的旧子会话，不能重新取得任务权限。

## 验证与后续

真实 DSH Agent + 本地 scripted adapter 覆盖固定记忆/任务、原生 botctl、两任务并行/重复拒绝、等待取消、creator 纠偏、父取消后的晚到写者、一次审批及拒绝、boot 闸门、跨任务失败传播、创建中取消、旧子身份拒绝、显式 stop/fresh 替换、token 耗尽的部分输出和无效工具 JSON。实际安装后的 Chromium 流程检查主 Session 派活、任务结果/候选、一次父审计、私有角色记忆隔离及多窗口重放。

Worker 契约使用 journal v3。[scoped botctl Worker 恢复与模块交接](worker-recovery.md) 已交付：原生 writer/closers、子事件/结果证明、派生恢复 ledger、单次 Git 结算及 v3 回复共同核验，当前能力已默认开启。即使本轮未实际派活，开启后的 Chief turn 也捕获 v3 契约；非 Chief 或关闭 workers 的主 Session 使用前台 v2。未知工具/旧契约、缺失或冲突的原生日志仍保留证据并拒绝。Worker Bash/文件/PTC 与 compaction、后台/跨系统写者、IM/peer/outbox 和完整配置编辑继续在 [TODO](../TODO.md)；主 Session 的 checkpoint/compact/sleep 已交付。
