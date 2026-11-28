# 原生 Agent Runtime 接入

当前基线 `0.2.0-rc.1`。事务桥接入真实 DSH Agent，通过 [主会话绑定](main-session.md) 建立原生工作区/主 Session；已接通前台/Worker 恢复、所有者消息/CLI、checkpoint、自动/手动摘要及 sleep/wake。完整对话域和其他写者按 [TODO](../TODO.md) 推进，职责与目标契约见 [DESIGN](../DESIGN.md) 和 [Session Runtime](session-runtime.md)。

## Host 接口

bundle 现在加载 dsh-mbot/runtime，提供 ctx.mbotRuntime。可信 Host 可在 Agent 开始工作前调用 attach(agent, {botId})，常用位置是官方 agents.create 的 setup 或 agent/created。Session 的实际 cwd 必须匹配已登记数据目录；不能把同一个受管理 Session 重定向到另一个 Bot。并发重复 attachment 复用 Promise。

Runtime 会识别登记中的 mainSessionId，加载/重载时接入对应 Agent。创建阶段会先保存 pendingSessionId，Runtime 在 agent/created 中接管预留 Agent；绑定失败或尚在创建时拒绝业务执行并保留 Inbox。成功后 mainSessionId 接替预留引用。普通未绑定 Session 与独立 headless run 保持原行为。

managed(agent) 查询是否已接入；dataLease(agent) 只在本轮活动期间取得数据许可；settled(agent) 等待当前审计/提交完成，不能只把 agent.whenIdle 当作 Git 已提交。

## 上下文与准入

- DSH Inbox 是唯一消息队列。Runtime 记录已 claim 的消息以形成审计，不维护第二个消费者。system-prompt/assemble waterfall 在模型提示完成组装前取得 lease，再用不可变快照重建 MBot 段；诊断用的无 signal 组装不启动事务。
- SOUL、AGENTS 和共享/角色 MEMORY 放入 Agent-scoped 系统段，禁止变量插值。近期对话继续使用 DSH 当前 surface；动态必需上下文记录 Bot/Session/turn、memoryCommit 和 runId，许可不进入提示。
- 原生 providers 的求值先于 assembly waterfall，所以首次占位求值不等于准入。Runtime 在返回 presentation 时覆盖自己的段，再于 prepend 的 pre-step 闸门核实最终组装结果，防止 complete prompt 或其他提供者丢弃 MBot 段。
- 使用公开 sessionQuery 与 Session.append 的 surface replacement 更新系统头、清空旧系统尾部，退役旧 runtime-context 中的 MBot 段并保留其他运行信息；原始 log 保持 append-only。下一轮先等待上轮审计，不能拿未提交目录组装新快照。
- 准入失败时，未取消的已 claim 输入放回 DSH Inbox。Runtime 关闭时保留 Agent-owned 闸门，拒绝模型执行并暂存新输入；真正替换 ESM 模块时通过版本化共享 cell/driver 接管；先等待旧写者、审计与消息 flush，全部 attachment ready 后才开放业务，保留失败证明。Agent 释放时这些注册随 scope 清理；详见 [模块交接](runtime-handoff.md)。

这证明模型请求中的旧人格/记忆快照可以物理退役，不证明任意历史发言或模型摘要中的旧规则已经被语义清除。原生 compaction 的取材、知识版本与来源证明由 [摘要模块](managed-compaction.md) 管理，[checkpoint](context-checkpoints.md) 联合封存原生/Git 输入基准；来源 hash 仍不保证模型归纳在语义上完全正确。

## 工具与结束边界

原生 botctl 使用当前 lease，不重入主 Session FIFO、不生成 human commit。boot 的 SOUL/MEMORY 读取本轮 Git 基准，任务/看板继续读取允许的工作状态；候选/结果作者来自当前角色，不能用 --as 冒充另一个角色。

原生 Bash 使用官方 Agent-scoped 前台组合，关闭 run_in_background 与超时转后台，保留已有 shell/sandbox/approval 能力。每次执行通过 shellEnv 收集 DSH_MBOT_WS/RUN_ID/PERMIT_TOKEN/BOTCTL；独立脚本将其映射为受控 MBOT 身份，不写 Host 的全局 process.env。Bash 准入早于组合就绪时拒绝执行旧定义。

Runtime 在 tools/execute 记录前台调用，工具结果进入 Session 前脱敏凭据和许可的字面值。已知前台工具可执行；自定义工具需要可信 Host 的 foregroundTool(name) 声明，承诺返回前静止全部写者，调用方须将返回 disposer 绑定自己的 effect。声明引用计数避免一个插件撤销另一个插件仍持有的注册。这是协作契约，不是对恶意同进程插件的沙箱。

turn/end 后等待调用及事件写入，再 guard、审计并提交；结束消息本身是同步事件，后续 prompt 用 pending barrier 等待完成。期限及 lease.cancel 先取消真实 Agent（keepInbox=true），等待本轮 end 与写者，再结算。管道读期限留出完成阶段的时间，避免正常取消收尾被过早视为 Host 失联。干净的用户停止保留原故障计数，越权/已有执行故障仍递增，见 [turn outcome](turn-outcomes.md)。

[原生 Worker 最小执行](native-workers.md) 已接入固定角色快照、共享事务、scoped botctl 和结束审计，scoped botctl Worker 默认开启并支持 [v3 恢复](worker-recovery.md)；原生 spawn_agent/send_message 仍拒绝，通过 botctl worker_* 操作。后台能力的 run_code 不在默认前台白名单；其他未声明前台生命周期的工具也拒绝，不把一个 accepted/job 收据当作写者静止证明。Root 模型输出后，聊天区独立卡片展示 Host 验收/提交结果；runtime/stop 与原生停止的队列/收尾验收见 [Runtime 反馈](runtime-feedback.md)。

## 恢复与验证

此 Runtime 的 journal 标为 writerScope=agent-runtime，前台 turn 保存固定 foreground-only v1 契约；开启 Worker 的 Chief turn 使用 foreground-workers v2 和 journal v3，恢复见 [Worker 恢复](worker-recovery.md)。Host /mbot recover 与 botctl recover 已协调原生写者、Agent/工具、Git 和回执；独立 mbot recover 仍只处理 data-subprocesses。原生 resume 产生真实 closers，旧头须有原 Host 的捕获记录；不能改 scope、删 journal 或普通 resume 绕过。Worker 其他工具、后台/IPC 写者、缺失日志/未知旧契约迁移继续在 P1，见 [Runtime 恢复](runtime-recovery.md)。

验证使用真实 AgentLoop、LLM service/本地 scripted adapter、原生工具执行器、Bash/subprocess 和 Git，没有调用 DeepSeek API：

- 33 项既有 Cordis 与 9 项 Runtime 检查，另有 64 组 Bash 回归。Runtime 覆盖原生工具审计、FIFO 与下一轮提交可见性、SOUL/MEMORY 更新、Bash 许可/署名/脱敏、取消后晚到写者、关闭/重载与输入保留、旧段退役顺序、真实模型驱动期限、自定义写者拒绝。
- source/tarball/Git 三种真实 DSH 安装通过：实际创建 Agent、attach、经两次会话模型调用使用原生 remember 并审计；标题等辅助请求由本地 adapter 单独处理。产物 /tmp/mbot-plugin-install.oRj75f。
- Chromium 的原有 init/import/list/select/status、多标签页、profile 隔离及重启回归通过，产物 /tmp/mbot-gui-test.gb4U1U。这组早期回归不单独证明主 Session 导航/面板；后续交付见 [主会话](main-session.md) 与 [最小面板](sleep-wake.md)。

余下 Worker 写工具、额外消息域、未知写者与完整配置编辑按 [DESIGN](../DESIGN.md#后续路线) 推进。
