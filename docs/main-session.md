# 原生工作区与主 Session（dev）

2026-11-27。Web profile 已接入自动创建和修复；包版本仍为 0.1.1，本阶段未打发布标签。主 Session 使用已验收的 [Runtime](native-runtime.md)，后续已接入 scoped botctl Worker/恢复、所有者来源信封及 CLI IPC；compact/sleep/checkpoint、额外对话域与 Worker 写工具仍在 [P1](../TODO.md)。完整上下文和入口决策见 [Session Runtime](session-runtime.md)。

```text
/mbot init /absolute/new/data-directory
/mbot import /absolute/existing/data-directory
/mbot list
/mbot open [Bot ID 或完整名称]
/mbot repair [Bot ID 或完整名称]
```

init 创建 Git 数据与身份、选择新 Bot，然后登记官方 DSH 工作区、创建 Chief 主 Session、接入 Runtime 并默认打开。原命令及结果留在发起会话，初始化不调用模型。import 校验并登记已有数据，再补建原生绑定；保留 Git/记忆/看板/用户文件，不改变默认选择或当前窗口。open 验证并打开已有主 Session，健康绑定不取数据写锁，允许观察正在执行的回合；repair 验证或继续部分失败，不跳转。无参数时优先使用调用 Session 的 Bot，其次默认选择。

结果卡片给出工作区、Session ID 和 `#mbot-session=<Session ID>` 链接片段；在 DSH Web 地址后添加该片段可打开同一会话。插件消费片段后清除它，后续导航和选择由原生 UI 持有。控制结果仍使用原生命令卡片，默认不进入模型 role content。

Host 的 `importBot` 继续作为只登记身份的 API；`ensureBinding(identity, {revision?, signal?})` 才创建/验证实体，返回登记快照；`resolveMainSession` 验证健康主会话，不因其持有数据锁而阻止打开。安装在只有 dsh-base 的 headless profile 时，Controller 不存在，init/import 只保存数据身份并提示；open/repair 明确要求完整原生服务，不创建另一套会话。独立 Bash CLI init 始终只初始化 Git 数据。

## 持久状态与失败恢复

Bot 登记条目仍为 schemaVersion 1，新增可为空的 binding，旧记录默认补 null，原数据不迁移/覆盖：

| 状态 | 持久信息 |
|---|---|
| null | 旧记录或尚未绑定的身份 |
| provisioning | 预留 pendingSessionId；已验证的 workspaceId 可提前保存 |
| ready | 已验证 workspaceId/mainSessionId；预留和错误清空 |
| failed | 保留实际引用、预留和脱敏原因，提示 repair |

先通过 ConfigEditor 保存预留，再调用 Controller。Runtime 同时识别预留和正式 ID，在 Agent 发布前接管；provisioning/failed 的业务 turn 拒绝并将未取消的输入放回 DSH Inbox。只有真实 cwd、普通 Session ownership、工作区 membership、Runtime 和 Session flush 全部验证后，才发布 ready。

每次先 resolveAgent；只有明确 session/not-found 才用预留/原 ID create。DSH create 对已开始的 Session 可能生成新 ID，不能作为 resume。返回不同 ID、writer-held、目录冲突、归档或保存错误时拒绝，不静默替换身份，不删除部分资源。缺失 Session 的显式 repair 可重建同一 ID，已有历史仍由 DSH 持有；归档先在原生 UI 恢复。

创建失败后已有数据用 import 或已登记身份的 repair，不反复 init 非空目录。新建及预留中的 Session 设置 Bot/角色标题；已正式绑定的用户标题保持原值。

Runtime 附件初始化失败时，只清理尚未开放业务的附件并等待它拥有的查询、flush 和子进程；原生工厂负责 Agent 创建/恢复的取消与回滚。不能在 setup 或 `agent/created` 回调内调用 `agent.whenIdle()`：原生 publication maintenance 正在等待该回调，会形成循环等待。也不能先以 hook cause 取消它，否则会覆盖原生 disposed cause 并释放待办唤醒。已经完成初始化的 Runtime 关闭仍须等待 Agent、工具、审计及全部 flush 静止。

失效的旧 Bot 数据或 checkpoint 继续拒绝恢复，保留登记、预留 Session 和原生输入；错误应结束命令并释放输入框，后续新 Bot 创建仍可继续。已进入旧版循环等待的 Host 需要重启加载修复，热更新不能解除原来的等待；不要删除旧原生日志或伪造 `command/done` 来清除历史中的运行卡片。

## 并发与边界

Host 的管理调用串行；跨进程使用现有 Bot `.mbot/lock`，与数据 turn/headless 写者互斥。拿不到锁报告 busy，不修改登记或创建实体；取消/关闭不会在原生 API 尚未结束时提前放锁。ConfigEditor 重读最新 profile，按具体 Bot 快照核实每次更新，独立的选择/设置编辑保留。

成功打开只监听当前浏览器的 `command/executed` 回执，并在 composer 提交结束后交给 uiWorkspace。Session 广播、重放和其他标签页不会自动导航。A 的主 Session 始终路由到 A，默认选择 B 不会将它改成 B。新消息仍由 DSH Inbox 串行，Bot 数据由 Runtime lease 保护。

主会话目前支持原生直接对话、受管理上下文和前台工具。[原生取消与审计反馈](runtime-feedback.md) 已验收；[原生 Worker 最小执行](native-workers.md)、[scoped botctl Worker 恢复](worker-recovery.md) 与 [所有者来源/收据](message-admission.md) 已接入；Worker 其他工具/未知写者恢复、可见域、自动/手动 compact 与睡眠恢复仍待实现；不宣称该阶段完成了整个 0.2 生命周期。

## 验证

`npm test` 保留类型、33 项 Cordis、9 项真实 Agent Runtime、64 组 Bash 回归。`npm run test:install` 覆盖 source/tarball/Git 的基础 headless profile，以及 Web tarball 的真实主 Session → 本地 scripted adapter → 原生 remember → 审计提交；开始对话后 repair 仍复用原 ID。

Web 故障探针验证创建后重命名失败、受管理预留 Agent、失败准入/待办保留、多行错误保存、并发修复、用户标题、外部进程持锁与只读打开、归档/恢复、注入 writer-held 回应不触发 create、新选择 CAS 和 Git 数据不变。Chromium 验证 init 自动打开、旧会话/其他窗口保留、import/open/repair、双实例路由、刷新/重启及链接导航，全程创建/控制不调用模型。测试仅使用隔离 profile 与 /tmp 数据，未调用真实 DeepSeek API。

本阶段证据：全量回归 `/tmp/mbot-binding-full-tests.log`，最终类型/插件回归 `/tmp/mbot-binding-final-plugin.log`，安装与故障探针 `/tmp/mbot-plugin-install.5z5o3N`，Chromium `/tmp/mbot-gui-test.TZhrxF`。Web profile 的上游全树 schema 导出对内置非标准 group carrier 报错，因此本阶段在三种基础 profile 导出 schema，Web 的工作区/会话由真实运行与浏览器验收覆盖。

注销由 `/mbot remove` 显式执行，保留全部主/预留 Session ID 的持久退役记录；原生工作区删除或归档不直接删除独立 Bot。重新导入创建新身份及新主 Session，旧会话保持阻止业务执行，见 [Bot 注销](bot-removal.md)。
