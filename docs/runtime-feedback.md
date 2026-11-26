# Runtime 审计反馈与停止（dev）

2026-11-27。主 Session 的聊天区新增独立 MBot 状态卡片；原生停止按钮与人类停止命令已验收。包仍为 0.1.1，未发布新标签。

```text
/mbot runtime [Bot ID 或完整名称]
/mbot stop [Bot ID 或完整名称]
```

不指定 Bot 时，在受管理 Session 内控制该 Session；普通会话使用当前默认 Bot 的主 Session。指定名称/ID 则定位对应主 Session。命令不创建第二套模型队列、不调用模型，也不进入模型 role content。Runtime 不可用、未绑定、Controller 缺失或写者占用时明确报错。

runtime 显示当前执行/验收状态、待处理 next-turn/next-step 数量、最近回合与审计提交。Agent 空闲不等于 Host 已验收完成，等待工具、Git 或 Session 回执保存时仍显示 auditing。

stop 取消调用时捕获的回合，保留 DSH Inbox，等待其工具静止、数据验收/Git 提交和 Session 回执保存。Host 返回 RuntimeStopResult.targetTurn/receipt 指向捕获的回合，实时 state/队列可能已反映后来接收的新工作。其他窗口随后送入的新消息仍由 DSH 处理，停止等待不扩展为取消未来回合。只退出浏览器/断线不等同于停止共享执行；命令调用者的等待被取消后，已请求的 Host 收尾仍继续。

## 卡片与结果

| 回执阶段 | 用户看到的含义 |
|---|---|
| active | 正在处理，已取得本轮数据 lease |
| auditing | 模型/工具回合结束，Host 仍在验收 |
| committed | Git 审计已提交且本轮通过验收 |
| rejected | 已生成审计提交，但本轮未通过；用户停止时显示“已停止”及待办保留 |
| failed | 验收或回执保存失败；若 Git 已确认提交，卡片保留提交引用并明确区分 |
| cancelled | 在取得数据 lease 前停止，没有本轮 Git 审计提交 |

每回合只展示一张更新中的卡片，不跟随其他窗口的广播跳转。卡片放在聊天区独立位置，避免被原生工具/过程详情折叠；同时提供中文和英文。Runtime 的异常、回执及停止调用报错会脱敏凭据/本轮 permit 字面值，不向界面泄漏许可。

展示使用公开 appendPluginRecord 写入 `plugin:mbot/runtime-turn`，标记 ignorable，并通过公开 uiConversation/Chat slot 渲染。schemaVersion 1 保存 Bot/Session/turn、phase、可选 runId/memoryCommit/head/meta/success/reason/error；读取时校验版本及字段。它是可丢失的插件展示记录，不进入模型 surface，不成为准入/事务真相源，也不代替 Git 审计、active-turn journal 或未来 checkpoint。此 API 属于 DSH 的实验性插件记录扩展，迁移可能只尽力保留。

原生 run_code 支持后台执行，不再列入默认前台白名单；其名称属于原生 PTC 传输，不能注册/覆盖为普通工具；后续须接齐 PTC/后台执行的所有写者静止契约，不能因脚本返回 job 收据而结束审计。

下一轮必须等上轮审计及回执持久化。若 Git 已提交而 Session flush 失败，保留真实 commit，只补失败反馈并阻止继续运行，不重放已经提交的 turn。提交失败则保留 journal/snapshot 与原 HEAD，供后续 Runtime 恢复；当前数据 recover 仍明确拒绝 agent-runtime scope。

## 原生停止的依据与验证

本机 DSH 0.2.2-rc.5 的实际编译代码已是 conversation.cancel → session.cancel → Agent.cancel({kind:'user'}, {keepInbox:true})，因此不覆盖原生按钮，也不新增替代队列。新增 stop 命令提供等待 Host 收尾的结果；原生按钮的 accepted 仅表示取消已请求。

验证：33 项 Cordis、14 项真实 Agent Runtime、64 组 Bash 全量检查通过。Runtime 增加待审计状态/下一轮闸门、实际 Git commit 失败、Git 成功后回执保存失败/许可脱敏、停止等待晚到写者及队列保留、停止后另一个窗口接收新请求不扩大等待范围；重载查询从 Session log 读取旧回执。

source/tarball/Git 基础 profile 与 Web tarball 的真实安装均验证已提交回执。Chromium 新流程使用隔离 profile、公开适配器注册与模型目录、本地 scripted adapter；外部网络请求被测试夹具拒绝，不使用真实 API key。验证 UI 可见的待审计/成功/停止/失败卡片、原生按钮、真实工具清理、待办续聊、双窗口及刷新重放。

证据：全量 `/tmp/mbot-feedback-final-suite.log`，最终 Runtime `/tmp/mbot-feedback-final-runtime.log`，安装 `/tmp/mbot-plugin-install.Cum3yy`，原界面回归 `/tmp/mbot-gui-test.xtxxdX`，新浏览器流程 `/tmp/mbot-gui-runtime.azE33B`。

compact/sleep/wake、统一来源/收据/可见域、Worker 与 Runtime journal 恢复仍在 P1；用户停止目前沿用既有受控 turn 的失败计数，后续单独区分用户停止与故障。管理面板仍在 P2。
