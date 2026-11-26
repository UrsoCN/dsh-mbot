# Managed turn 的停止与故障计数（dev）

2026-11-27。主 Session 的正常用户停止不再增加故障计数，也不清空已有故障；Git 审计、护栏、队列与恢复仍保留。包版本为 0.1.1，本阶段未发布新标签。

## 判定与结算

每次受控 turn 在写审计提交前产生并校验规范化 outcome：

| outcome | 条件 | 对本轮开始时故障计数的影响 |
|---|---|---|
| completed | 已完成且通过原有 guard/审计 | reset：归零 |
| cancelled | Native reason 明确为 aborted/user，无护栏违规、无已记录执行故障 | preserve：保留 |
| failed | 其他情况，包括超时、Host 中断、来源不明的取消、越权及已记录故障 | increment：加一 |

只有明确由 Host/原生控制链记录的 user cause 能进入 cancelled；不从错误文本或消息正文推断。模型流的 error/max-tokens、工具 isError 的非取消身份是已记录执行故障。原生 ABORTED、ABORTED_BEFORE_DISPATCH、APPROVAL_CANCELLED 属于取消身份，本身不使干净用户停止变成故障；原生原因是 timeout/hook 等时仍判 failed。

取消前若已有两次故障，连续三个干净停止后仍是两次；下一次真实故障仍达到三次熔断。停止时有违规则回滚违规内容、保留合法数据并增加故障计数。模型停止并不自动表示 Host 验收通过。

success 继续仅表示成功完成的回合；cancelled 的 success=false，不把未完成的运行伪装为成功。完成结算时，成功、取消和故障均生成审计提交，任务/候选合法写入沿用原 guard 规则。旧 headless run/tick/dream 的计数语义保留；本阶段针对 managed turn 与原生主 Session。

## 持久格式与旧版本

新 journal 使用 schemaVersion 2，旧开发版的 v1 恢复器会拒绝，防止误用 success 结算新版取消。新 reader/permit 同时支持 v1/v2，不将 v2 降级。Begin 协议和 Session 展示回执仍为 v1。

Git meta 新增 outcome、failure_count_effect，runtime 中新增 outcome_schema_version=1、execution_fault。Managed turn transcript 附带这组判定。Host TurnResult/恢复结果返回 outcome 与 failureCountEffect；Session 的展示回执以可选字段扩展 schemaVersion 1，仍可读取旧回执。

计数判定先验证版本、success、违规数组与 outcome/effect 的一致性，再更新 counter；当前 finalize 在提交前和结算时验证，恢复使用同一 helper。成功、取消、故障在 commit/回执边界崩溃后都从 journal 的 baseFailures 重算，因此重复恢复不增加同一轮计数。

旧 v1 journal/其 Git meta 按原 success 语义结算，不根据旧 aborted/user 文本重解释历史；尚未提交的 v1 turn 恢复也保留旧失败规则。v2 journal 必须有 outcome_schema_version=1 的完整结果，不能借删除字段回退到旧语义。部分新字段、未知版本或不一致的 effect 会拒绝恢复并保留 commit/journal，不能借此重置故障计数。恢复范围仍为 data-subprocesses，agent-runtime 恢复待后续写者协调与 checkpoint 接入。

聊天区依 outcome 区分正常“已停止”和“本轮未通过验收”。有已记录违规/故障的用户取消不会被正常停止标题覆盖。/mbot runtime 的最近审计、/mbot status 的最新记录也显示规范化 outcome。

## 验证

- 39 项 Cordis/Host、17 项真实 Agent Runtime、64 组 Bash 回归；公开类型覆盖 outcome/effect。
- 真实 Agent 验证三次干净停止保留两次旧故障、下一次错误熔断；取消不掩盖晚到 MEMORY 违规或此前工具错误；超时仍计故障。
- 数据恢复在 commit/回执两个崩溃边界覆盖 completed/cancelled/failed，验证计数仅结算一次；旧格式按原语义恢复；不一致新 effect 拒绝，修复后可继续。
- Chromium 使用已安装插件与本地 adapter，验证正常停止计数、待办、违规回滚与失败标题，随后提交失败及双窗口/刷新重放。未调用真实 DeepSeek API。

证据：全量 `/tmp/mbot-stop-v2-suite.log`，安装 `/tmp/mbot-plugin-install.6oJbk0`，Chromium `/tmp/mbot-gui-runtime.a757YE`。测试只使用隔离 profile 与 /tmp 数据。

统一消息入口、Worker、compact/sleep/wake、Runtime 恢复与管理面板继续在 TODO。
