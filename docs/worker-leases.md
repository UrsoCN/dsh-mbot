# Worker 委派的数据许可（dev）

本阶段交付共享事务下的角色/任务许可和固定上下文，是 [Worker 接入](../TODO.md) 的数据基础。原生 Runtime 默认仍使用 foreground-only 契约；[原生 Worker 阶段](native-workers.md) 可显式开启模型执行。本页的基础 Host API 不自行创建 Agent。完整上下文与通信设计见 [Session Runtime](session-runtime.md)。

## 一份事务，不同角色

Chief 的 TurnLease 持有 Bot 数据锁、Git 基准与最终结算权。受信任 Host 显式选择 `runtimeOwnership` v2（`foreground-workers`、深度 1、同时最多 2 个 Worker、固定父/子工具名单）时，桥使用 journal v3；普通前台契约继续写 v2，完整旧 v1 读法保留。

Host 在发布子 Agent 前调用：

```js
const actor = await turn.delegate({ sessionId: reservedChildId, role: 'coder', taskId: '001' })
// 子 Agent/工具全部结束后：
await actor.close()
// 最后由父回合执行 turn.finish(...)。
```

delegate 捕获调用时的参数，串行私有控制帧后确认 reservation。角色不得是 human/chief，任务必须处于 doing 且 owner 匹配；同一活跃任务不可重复委派，一个子 Session ID 在本轮内不可重新绑定，同时最多两份活跃许可。关闭一份可释放容量，已使用的身份仍保留在本轮记录中。

ActorLease 的身份包含 Bot、父回合、父/子 Session、角色和任务。它提供 snapshot、execute、shellEnvironment、redactResult 和幂等 close，不拥有 finish/commit 或再委派能力。主许可不交给 Actor；派生许可的身份从 journal 校验得出，不靠调用者传入 `MBOT_BOT`、`--as` 或可变 Host 环境选择。

## 固定上下文与任务范围

人格、协议和共享/角色 MEMORY 来自父 turn 的固定 Git HEAD；委派时在 botctl 锁内捕获当前看板与任务。因此 Chief 在本轮新建的任务也可交接，Worker 无须继承主 Session 的历史。

snapshot 与 actor 描述保存于私有目录，以 SHA-256 绑定；Actor 的 boot 返回这些固定内容。后续 task show 可读取当前任务，后续补充不会悄悄改写已经交接的 boot 快照。

原生和 shell 数据通道复用 permit 校验：Actor 可以读取看板/lint、boot 自己的角色及任务、读取/追加自己任务的结果、remember 候选；看板修改、其他任务、其他角色署名和其他任务的候选关联被拒绝。remember 自动补齐该任务和角色。每次调用在 botctl 锁下重新检查任务 owner/state，已结束或转交的任务不接收旧许可回写。

Actor 的 Host execute 只允许数据操作，不进入外部 botctl IPC。shellEnvironment 返回本 Actor 的许可；密钥/许可不进入 snapshot、Git 审计或脱敏回执。这是受信任 Host 与现有工具/沙箱之间的能力契约，不构成对同 UID 的恶意进程或 Host 插件的隔离。

## 关闭、护栏与持久版本

Actor.close 立即拒绝新调用，等待已经执行的数据子进程，再由父桥撤销许可。父 finish 在 reservation 尚未确认或存在未关闭 Actor 时拒绝，调用者可先完成关闭后重试。父 cancel/expiry 停止自身的数据调用，关闭 Actor 并仅结算一次；许可过期后仍允许撤销，避免把正常超时变成无法收尾的 journal。桥已断连时，Actor Host API 不再接受数据操作。

私有 ledger 和当前 journal 必须一致，Actor 的身份与快照须匹配原始描述。部分保存、降版本、改变身份或缺失文件均保留证据并拒绝继续。最终结算只在全部 Actor 已撤销且原始事务身份未变时，将 Host 自己的许可登记同步到 guard 的预期快照；其他 ignored 文件继续原有保护。最终 Git meta 保存不含 token 的 Actor 身份/任务/快照 hash，仍只由父回合生成一个提交。

v3 保留规范化 completed/cancelled/failed 与故障计数规则；旧 reader 不能将委派回合当成普通 v2 恢复。当前恢复只核实既有前台契约，v3 的完整 Worker/原生 Session/其他写者证明尚待实现，独立恢复继续拒绝并保持现场，不删除 journal 或修改 writerScope。

## 原生接入

以 DSH 0.2.2-rc.5 的公开 API 为依据：先预留 childId 和 Actor，再通过 `subagents.startActivation` 使用 fresh `spawn` provider。SDK 的 `prepareContinuable` 只返回创建数据，不提供自定义 child setup；MBot 应在 SDK 等待的 `agent/created` 阶段接管已预留 childId，在第一次模型请求前安装角色上下文、数据工具和来源闸门。

每个 turn 持有自己的 SubagentActivation/result/dispose，取消只处理该 turn 的子代理；`drainDescendants` 的 cutoff 持续到根 Agent 离开 registry，不能每轮都调用它来收尾持久主 Session。初次接入使用 caller delivery，并通过任务/显式结果交接；原生自动完成通知不直接注入主 Session。Chief 的树内纠偏只指向本轮仍活跃的 Worker，不能借 sendMessage 恢复旧 Actor 或跨 Bot 路由。

真实 Agent、首个 boot、scoped botctl/任务范围、深度/并发、前台清理、子事件/用量审计和失败传播已在 [原生 Worker](native-workers.md) 阶段接入并验证；其他写者、活跃重载/崩溃恢复仍需专项验收。Worker/PTC、compact/sleep/checkpoint、IM/peer/outbox 和管理面板仍在完整目标中。

## 验证范围

本阶段检查实际 turn 桥、CLI/Git、委派/撤销与数据快照，包含并发 reservation、父回合内新任务、角色/跨任务拒绝、固定 boot、转交后旧结果、晚到数据调用、过期收尾、许可脱敏、单提交和中断后的拒绝恢复。安装夹具同时检查源码、tarball、Git、Web 包中的 Actor 数据流程；这些数据层检查不代替原生 Worker 模型验收。没有调用外部模型。
