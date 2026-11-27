# Runtime 模块交接（dev）

主 Session 保持同一 Bot ID、Agent 对象和原生日志。代码重载不能让旧闸门继续拦住新 Runtime，也不能通过新 Session 或清除错误绕过未完成审计。主 Session 的上下文归属见 [Session Runtime](session-runtime.md)，恢复证明见 [Runtime 恢复](runtime-recovery.md)。

## Agent 持有闸门，Runtime 提供当前实现

`runtime-cells.js` 通过同一 JS realm 的 `Symbol.for('dsh-mbot.runtime.cells')` 保存版本化 WeakMap。键是 Agent 对象，注册表不保存全局的 profile 默认配置、当前 Bot 或凭据；临时事务许可仍限定于各 Agent 的内部 lease，不修改 `process.env`。Agent 的 prompt provider、消息监听和工具闸门只注册一次，回调通过 cell 的 driver 调用当前模块的实现；Agent scope 释放后注册失效，WeakMap 不延长 Agent 生命周期。

新模块检查 registry/gate ABI 和 prompt 段布局。更换布局或生命周期语义需要明确迁移及版本升级，不能复用不兼容 ABI。driver 先准备，状态从原生事件重建并完成 Bash 前台组合后才发布；所有既有主/预留 Agent 接入成功后 Runtime 才 ready。加载失败时尚未执行的消息放回原生 Inbox，旧错误和审计证明保留，兼容模块可重试。

首次注册使用官方 effect disposer 回滚自己的部分注册。已有第三方或旧版 provider 不被删除；没有共享 cell 的旧版 Agent 闸门无法凭名称自动接管，报错并保留旧闸门。这里是可信 Host 插件间的协调契约，不是对恶意同进程代码的隔离。

## 先静止，再交接

关闭同步禁止新的业务准入，并发布可重复等待的 quiescence Promise。等待进行中的恢复和 attachment，随后等待全部已捕获状态的 Agent、前台工具、事件审计、Git 结算、消息投递和回复查询的原生 flush。Agent 释放也必须保留尚未 drain 的状态；不能因状态从查询 Map 消失就遗忘旧写者。工具在开始时捕获本轮 lease，不能在 Runtime 被卸载后才向新服务索要旧许可。

写者未结束时拒绝交接。结算失败与工具未静止分别处理：已结束但审计失败的回合保留 error、failedAuditRunId 和 failedAuditRecord，以便恢复；活写者或不明静止状态不能通过失败回执放行。注销接管同样等待旧 quiescence，持久退役归属仍拒绝业务。

交接保留最后回执和失败证明，不复制旧 `current`。新状态的 current 来自当下原生 turn/start；复制已结束回合会覆盖初始化期间 claim 的消息。请求索引按原生事件重建，同 ID 重试返回原 MessageId/审计回复，不产生唤醒消息。需要继续执行保留的待办时，通过原生提交发送新的明确请求；重载本身不唤醒 Agent。

## DSH 的两种重载路径

本阶段以 DSH 0.2.2-rc.5 的公开 HMR 能力验收，配置重组和代码替换需要区分：

- 文件监听的 partial reload 先导入替换模块。导入失败时旧实例仍运行；激活失败则由 SDK 尝试回退旧模块。MBot 的兼容旧模块可以重新接管同一闸门及未完成证明。
- profile reconciliation 会先停掉需要替换的 Loader entries 再导入。替换失败后服务保持不可用，Agent 闸门保留，输入回到 Inbox；修正文件后再次通过官方重组重试。

无 HMR 的配置调整不保证替换缓存中的源码。不要把未改变模块的关开测试当成真实模块替换验收，也不要为重载一个 Bot 随意重启拥有其他 Session/后台写者的整个 Host。

作者旧 Host 的只读 journal 已通过 [正式迁移](legacy-migration.md) 恢复并保持 PAUSED，但该 Host 运行的是共享 registry 之前的模块，不能由此推断已实现原位接管。旧版无 cell 的迁移、其他插件写者的完整静止和该 Host 的实际续聊仍在 TODO；不编辑原生日志、删除锁或创建替代主 Session 来制造成功。

## 验证

单元验收使用真实 AgentLoop/工具执行器和不同文件中的 ESM 模块，检查替换 driver 生效、原 Agent/Session 不变、原生请求去重/已审计回答、失败审计与回执修复、初始化中的输入、部分 Agent 加载失败、退役、首次注册回滚，以及旧工具/消息 flush 的关闭边界。

`npm run test:gui-handoff` 使用实际 `dsh plugin add` 安装的隔离 Web profile，保留安装所得 SDK 身份，另取可修改的临时包树并启用官方 HMR。Chromium 经原生聊天及命令触发真实模块替换，验证晚到写者、保留待办、SOUL/MEMORY 刷新、失败后修正/重组和无关 Session 的继续使用；不会修改生产 profile 或调用外部模型。所有产物在 `/tmp/mbot-gui-handoff.*`。

[scoped botctl Worker 的实际模块交接与恢复](worker-recovery.md) 已验收；Worker 其他工具、PTC/后台写者、跨 Host 交接、compact/sleep/checkpoint、IM/peer/outbox 和管理面板仍需各自的生命周期证明。
