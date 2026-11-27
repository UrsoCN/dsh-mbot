# dev：按请求查回已审计回答

2026-11-27。所有者 `ownerMailbox.receipt(requestId)` 和 [本地 CLI](host-ipc.md) 已从投递收据扩展为按请求核验的结果查询。复用原生 Session 与 Git，不增加模型消费者；IM 回复投递/确认、完整 Runtime 恢复仍在 [TODO](../TODO.md)。包仍为 0.1.1，属于未发布 dev。

## 使用与结果

```bash
botctl talk --profile web --bot 'bot-实际ID' --request-id 'task-001' --text '整理今天的任务'
botctl receipt --profile web --bot 'bot-实际ID' --request-id 'task-001' --wait --timeout-ms 60000
```

talk 仍快速返回准入，不等待模型。receipt 保留 confirmation/delivery/MessageId 等已有字段，并增加 result：

| result.status | final | 含义 |
|---|---|---|
| queued / running | false | 原生 Inbox 待办或活动 claim |
| auditing | false | 原生回合已结束，匹配的 turn 写者仍在完成审计/结算 |
| recovering | false | 匹配的中断 journal 尚未结算；可能已有 Git commit |
| unverified | false | 缺失、冲突、不一致或未持久确认的证明，不能假称完成 |
| completed / failed / cancelled | true | 审计及原生结束已核实，或原生待办明确被取消 |

result.audit 带实际 commit、查询时 observedHead、meta 路径、runId、memoryCommit、outcome/effect。final=true 的审计结果可带 result.reply：稳定 replyId、原 requestId/rpcId/MessageId、Bot/Session、固定对话键/回复路线、关联 ID、原生事件位置、outcome 和脱敏 text。

failed/cancelled 仍是已核实终态，不代表成功；即使模型文字声称成功，调用方也应使用 result.status/outcome。待办被移除而从未执行时可 final=cancelled，且没有审计回答。查询缺失请求返回 undefined，CLI 为 null。

--wait 只轮询 receipt，不重发 talk、不取消共享执行。默认等 60 秒，可指定 1–3600000 毫秒；截止时退出码 4，并给出 wait.status=timed-out。普通 receipt 的退出码 0 仅表示查询成功，需读 result.final/status。原有退出码 3 继续表示投递/确认不确定。

查询属于观察通道，不持有 Bot 数据写租约，也不阻塞同一会话的消息追加。后来的请求、Runtime 重载或另一次失败不会把原请求的回答替换为“最近回答”。不同所有者/适配器/路线仍受原能力绑定约束。

## 原生事件与 Git 证明

新 Native turn 的 begin 头捕获 claimed messages；提交前由 Host 从记录的原生 turn/end 与最后 assistant/message 建立 reply。它保存结束/回答 seq、原生文本 SHA-256、目标身份和固定回复路线。秘密脱敏后补最终文本 hash 与只允许插入 `[REDACTED]` 的掩码位置；读取时能从原生文本重建脱敏回答，不能用另一段文字冒充原回答。

Git meta 的 runtime.reply 为 schemaVersion 1，带 writer_scope=agent-runtime、journal_schema_version=2。outcome 的规则抽到 lib/turn-outcome.jq，提交、计数恢复和只读收据共用；不能由客户端重新猜测取消/错误语义。

查询使用 sessionQuery 的已验证完整原生日志，重建请求、claim、cancel 和 turn 位置。随后从查询时 HEAD 可达的审计提交寻找原始 meta，只读不可变 Git 对象。验证 Bot/Session/turn/request、路径/runId、单父提交与 base_head、Host 提交格式、原生结束原因、回答位置/指纹/掩码、目标及 outcome/执行故障。多个匹配或任何矛盾均不发布回复。

原生多请求/显式 steer 可在同一回合得到共同的最终回答，但每个回复信封绑定自己的原请求和路线。这里只有所有者私人主会话；不同主体/群线程不能借此共享私人上下文。

工作树文件编辑、后续提交、merge 或删除当前 transcript 副本不改写历史回答。若原审计提交已不在 HEAD 的可达历史中，不能用旧聊天卡片的 head 强行证明当前仓库已确认它。ignorable plugin record 完全不参与证明，既不是提交证据，也不是消费/完成权威。

Git commit 出现也不等于全部结算完成。匹配的 journal 未退出时，只报告已核实 commit 和 auditing/recovering，不交付 reply；原生 request/end 的 flush 失败也阻止 final。后续成功 flush 可以查回已提交结果，无需重复运行模型。查询只读，不能替代恢复或删除 journal。

Git 与本地同权限 Host/人类仍是可信维护边界。这些一致性检查防止误关联、损坏、陈旧状态和未完成交接，不宣称是恶意同权限代码的安全沙箱。

## 兼容与限制

源码链接可能出现“运行中旧 Host + 磁盘新脚本”。旧 begin 头没有 messages 时继续原审计，避免新校验误暂停正常回合；它不会伪造新版 reply。早期审计缺少完整原生证明时，结果为 unverified，原始 Session/transcript 仍保留。新宿主应重启/重载后取得完整能力。

已经中断的 agent-runtime journal 仍需协调恢复，不能由数据 recover、删 journal 或改 scope 掩盖。用户新反馈中的旧头验收故障已避免继续发生，已留下的 journal、删除 Bot/退休绑定等工作继续单独处理。

回复信封是可交接的不可变结果，当前只有查回/等待能力，尚未向 IM 投递，也没有外部投递 ack/outbox 消费者。后续 outbox 应复用 replyId 和原路线，不复制原生消息消费队列；外部副作用/不确定投递不能承诺 exactly-once。

## 验证

91 项 Host/Runtime、类型、64 组 Bash 回归；新增覆盖原回答查回、重载、待审计/伪造卡片、取消/违规、文本/路线/事件/结果篡改、不可达审计、merge/归档副本、提交失败与 SIGKILL 后未结算、秘密掩码、旧 Host 头及 CLI wait 截止。

四类安装检查新资源与实际已审计回答；Chromium 在安装后 Web profile 通过 CLI 查回和 SIGKILL 重启后的稳定 replyId/回答，未重复调用模型。使用本地 scripted adapter，未调用真实 DeepSeek API。

证据：`/tmp/mbot-replies-suite.log`、`/tmp/mbot-plugin-install.7vdgNJ`、`/tmp/mbot-gui-runtime.XBPJZy`。复跑 npm test、npm run test:install、npm run test:gui-runtime；浏览器仍需指定临时 Playwright/Chromium。
