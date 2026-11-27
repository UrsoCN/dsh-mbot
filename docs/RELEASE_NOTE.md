# 发布说明

## dev：主 Session 的原生自动摘要与审计恢复（未发布）

- 接入 DSH 原生自动 compaction，保留压力/overflow、范围选择、工具配对、缩小检查与 history replacement。MBot 使用独立 `mbot-compaction` 辅助请求生成有来源引用和 owner-private 可见域的摘要，普通 Agent 模型请求保持原生日志重放。
- Web 主 Session 缺少继承后端时，在该 Agent 的 scope 隔离并补装官方 BasicCompaction 与原生 compact 命令，沿用原生 tokenMeter；已有后端与 Runtime 交接复用，不重复注册。
- 摘要不直接取材 SOUL/协议/MEMORY/runtime-context 或 `botctl boot` 输出；本轮许可脱敏并限制 UTF-8 输入预算。空摘要允许，格式/来源伪造、截断、超限与取消不产生有效 replacement。
- 策略/请求/响应 hash、知识版本、原始来源和原生 compaction ID/括号/替换位置封存到同一次 Git `runtime.compactions` 审计，摘要用量纳入顶层统计。相同知识版本复用已审计摘要；再次压缩遇到旧知识版本时展开原始来源重新取材。
- checkpoint 只在 Git/journal/Session flush 一致后发布摘要证明；恢复先核验来源，Git 提交失败或提交/结算中断、回执 flush 失败时不重复模型、replacement 或已完成提交。缺失输出/冲突证明继续拒绝业务。
- 已注销 Bot 的摘要索引从原生日志/可达 Git 证明重建，恢复重复摘要不依赖活动 Runtime 状态，旧 Session 保持退役。
- gate ABI 2 支持已关闭且带共享 registry 的 ABI 1 补装一次 LLM 闸门，保留原 Agent/Session。普通回合没有 compaction 事件时不增加 Session 全量读取，保持并发 checkpoint 观察/重试边界。

真实 DeepSeek 的结构化摘要验收通过，调用仅用于摘要，普通对话使用本地 adapter；使用已授权环境 key，证据 `/tmp/mbot-compaction-real.log`，数据 `/tmp/mbot-runtime-tests.VrlkMK`。API 用量 23376 tokens，验证来源、原生 replacement、Git checkpoint 与干净工作树。

最终类型、188 项本地 Host/Runtime 检查和 64 组 Bash 检查通过；另 1 项真实摘要在默认套件跳过，已单独验收。证据 `/tmp/mbot-compaction-suite-current.log`。Chromium 通过实际 `dsh plugin add` 安装 tarball，验证主 Session 原生摘要/Git checkpoint、刷新后相同证明及 standalone compact 拒绝且不调用模型；证据 `/tmp/mbot-compaction-gui-current.log`，产物 `/tmp/mbot-gui-compaction.qLosw2`。

源码链接、tarball、Git 和 Web 四类安装验证通过，含新后端 peers、包内摘要模块、原生工具/命令、checkpoint/恢复与卸载；证据 `/tmp/mbot-compaction-install-current.log`，产物 `/tmp/mbot-plugin-install.jgkJ1f`。早期一轮安装遇到瞬时不可读进程而拒绝恢复，确认该 PID 退出后用新隔离 profile 重跑；生产写者检查保持原规则。

手动 `/compact`/botctl 维护入口、普通 turn 边界的旧摘要退役、原生 replacement 中途冷恢复、Worker compaction 与 sleep/wake 仍在 TODO。当前受管理 Session 的 standalone compact 明确拒绝，不将本阶段写作完整 compact 生命周期。包仍为 0.1.1，不新增发布 tag；实现与约束见 [自动摘要](managed-compaction.md)。

## dev：主 Session 的 turn 上下文 checkpoint 基础（未发布）

- 在模型提示组装前固定人格/协议/共享与角色记忆的 Git blob、内容 hash 和知识版本，捕获有序原生 surface 来源及已接受的 Inbox 输入 hash；任务或审计 Git 提交不推进知识 epoch，嵌套知识身份不可改写。
- 原生 context-snapshot 由同一次 Git `runtime.context` 审计封存；原 journal 结算与 Session flush 后发布。新增可信 Host 查询 `ctx.mbotRuntime.checkpoint(agent)`，首轮之前返回 null，未知/缺失/冲突证据不合成 checkpoint。
- 原生 Session resume、Runtime 交接和 recover 校验知识对象、前序链、原生来源和 Worker 证明；Git 成功后的确认修复不重复模型/提交。取材失败也按真实原生结果关闭已取得 lease，保留未执行输入。
- 查询保持自己的观察快照，避免旧读取覆盖新回合；Native/Git 跨提交重新观察，连续变化返回可重试状态，Bot 不计故障。Runtime 关闭和 Bot 注销等待查询/原生 flush 静止。
- `npm test` 串行运行 Host/Runtime 测试文件；恢复测试仅在 PID 已退出且 Git/工作树/journal 未变化时通过公开接口重试，保留生产写者校验。类型、172 项 Host/Runtime 和 64 组 Bash 检查通过，证据 `/tmp/mbot-context-checkpoint-suite-serial.log`。

source/tarball/Git/Web 四类安装与 Chromium 实际 Worker 崩溃恢复通过：查询恢复后的 checkpoint，核对原主 Session、知识身份/epoch 和唯一 Git 审计；全程使用本地 adapter。证据 `/tmp/mbot-context-checkpoint-install-current.log`（安装产物 `/tmp/mbot-plugin-install.aFk114`）、`/tmp/mbot-context-checkpoint-gui-current.log`（浏览器产物 `/tmp/mbot-gui-runtime.cqP0sq`）。没有调用真实 DeepSeek API。

实际 compact 摘要、compaction 证明和 sleep/wake 仍在 TODO，本文不将 turn checkpoint 基础视为完整上下文生命周期；包仍为 0.1.1，不新增发布 tag。实现与迁移边界见 [上下文 checkpoint](context-checkpoints.md)。

## dev：主 Session 上下文与入口设计细化（设计更新）

- 明确默认私人主 Session、多窗口共用和按可见域隔离的 conversation；botctl 是 Runtime 门面，Web 原生提交、Cordis 适配器与 CLI IPC 归入同一管理协议。
- 区分 Git 人格/记忆、原生历史、Runtime 近期摘要策略与 checkpoint；checkpoint 绑定知识内容 hash、有序 surface 来源、原始日志 cut 和维护阶段，普通任务 Git 提交不等于记忆更新。
- 独立 Bot 默认异步 peer 对话域，不复用 ownerMailbox 身份或树内 send_message；compact/sleep/wake 明确来源约束、Writer 静止、Inbox 保留与分阶段恢复。
- TODO 合并重复生命周期事项，执行顺序调整为 checkpoint/compact → sleep/wake → 对话域/IM/peer/outbox → Worker 写工具；README 与维护约定同步。见 [Session Runtime](session-runtime.md)。

本阶段仅更新设计与规划，没有新增运行 API，也未发布新版本或标签。验证为文档链接、阶段一致性与 diff 检查；既有代码验收记录见下文。

## dev：Worker v3 恢复、交接与默认启用（未发布）

- `/mbot recover`/`botctl recover` 接入 scoped botctl Worker 的 v3 契约：父/子原生 writer、公开 native closers、固定 Actor/快照、子事件/输出/用量和全部派生 permit 进程一起核验；不启动子模型或恢复旧 assignment。
- 保留原 journal/子事件，私有恢复 ledger 派生已核验的 revoked Actor；原有 guard/Git/commit intent/计数/回执流程单次结算。恢复提交失败可重试，原生日志、快照或派生 ledger 冲突拒绝；Git 成功但回执失败只补确认。v3 receipt 按子原生证明验证整体失败与原路线回答。
- 真实 Runtime 模块替换等待旧 Worker 写入和父审计，保留原主 Session；provider 替换保留已接受的 activation，新任务使用新 provider。子 Agent 释放但 seal 尚未完成时拒绝 creator message，禁止 cold-resume 旧 Actor。
- 修复大段中文 JSON stdin 分块解码损坏事件 hash；支持原生 TOOL_NOT_STARTED 与 assistant 请求的闭合证明。修复开启 Worker 却未派活时，journal 序列化格式变化被 guard 错记为越权；保留已核验 ledger 的准确字节。
- 当前 scoped botctl Worker 已满足执行/停止/恢复/交接条件，默认开启；`workers=false` 保持前台 v2。Worker Bash/文件/PTC、未知写者/缺失日志、checkpoint/compact/sleep、IM/peer/outbox 与管理面板仍在 TODO，包仍为 0.1.1，未新增 tag。

类型、50 项 Host + 107 项 Runtime（157 项）、64 组 Bash 与 source/tarball/Git/Web 四类安装通过。Chromium 实际 Worker 执行中 SIGKILL Host，重启后保留结果/候选、主 Session、PAUSED、故障计数和固定失败回复，父回合只提交一次且子模型未重跑；见 [Worker 恢复](worker-recovery.md)。证据：`/tmp/mbot-worker-recovery-suite-final.log`、`/tmp/mbot-worker-recovery-install-final.log`、`/tmp/mbot-worker-recovery-gui-final.log`（浏览器产物 `/tmp/mbot-gui-runtime.WeVchI`）。没有调用真实 DeepSeek API。

## dev：原生 Worker 的任务执行与父审计（未发布）

- 在已有 ActorLease 上接入 DSH fresh 子 Agent：固定角色/任务上下文，不继承主 Session 历史；通过原生 scoped botctl 写任务结果和记忆候选。Chief 的 botctl 增加 spawn/wait/message/stop，深度 1、最多两个并行 Worker；已结束任务需要新建 fresh 子 Session。
- 等待取消不取消业务；父停止、期限与关闭先 join 子执行/前台数据写者，再 seal 子事件/输出/用量，撤销许可并由父 turn 单次提交。原生完成通知不 inject 主会话，跨任务、旧子身份、缺少 boot 和未授权委派被拒绝。
- Worker 工具/模型失败及 token 耗尽传播到父审计；创建中取消根据原生 signal/cause 身份确认，回滚后保留正常用户停止计数。修复超时回调改写原生结束原因导致审计不一致；主 Session 的 coder 角色不误作 Worker。
- 独立审计辅助脚本不依赖 DSH Host 的 SDK loader，source/tarball/Git/Web 安装保持兼容。公开 Config/API/types、上下文协议与安装资源检查同步维护，见 [原生 Worker](native-workers.md)。

验收包括原生 Agent 的并发/纠偏/取消/晚到写者、一次批准与拒绝、失败/部分输出和 malformed JSON；完整类型、50 项 Host + 92 项 Runtime（142 项）及 64 组 Bash 检查。四类 DSH 安装与 Chromium 的实际主 Session 派活/结果/候选、一次父审计、角色记忆隔离、多窗口重放通过。证据：`/tmp/mbot-worker-suite-complete.log`、`/tmp/mbot-worker-install-final.log`、`/tmp/mbot-worker-gui.log`（浏览器产物 `/tmp/mbot-gui-runtime.qaHTYl`）。没有调用真实 DeepSeek API。

workers 默认关闭；开启后的 Chief turn 使用 v3 契约，其完整冷恢复尚待实现。Bash/文件/PTC、活跃重载/其他写者、checkpoint/compact/sleep、IM/peer/outbox 和管理面板仍在 TODO。包仍为 0.1.1，本阶段提交 dev，不新增发布 tag。

## dev：Worker 委派的数据许可（未发布）

- Chief 的 turn 可预留角色/任务/子 Session 并派生 ActorLease，固定 Git 上的人格/记忆和委派时的任务快照；支持本轮新建任务、同时最多两份许可、关闭释放容量，父回合统一提交。
- native/shell 数据调用绑定 Actor 的角色与任务；禁止改看板、跨任务或冒用署名，remember 自动关联任务，归属/状态改变后拒绝旧结果。close 等待数据调用并撤销，父完成等待全部 Actor 关闭；过期可收尾，断连/部分保存/降版本保留证据，许可在上下文与审计中脱敏。
- 委派契约使用 journal v3，普通前台继续 v2，旧 v1 保持兼容；Host 的许可登记须核验后才同步自身 guard 快照。原生 Runtime 尚未开放 Worker 模型执行，v3 的完整 Worker/原生 writer 恢复仍待接入；见 [数据许可与下一步](worker-leases.md)。

类型、50 项 Host + 78 项 Runtime（128 项）、64 组 Bash 和四种安装通过；安装夹具实际运行委派数据流程，既有 Chromium Runtime/恢复回归通过。证据：`/tmp/mbot-actor-suite-verified.log`、`/tmp/mbot-plugin-install.8LWStN`、`/tmp/mbot-gui-runtime.4tCDza`。没有调用真实 DeepSeek API。

本阶段按数据桥/CLI/Git 验收，不将数据许可当作原生 Worker 已交付。包仍为 0.1.1；Worker Agent/工具/事件、PTC、compact/sleep/checkpoint、IM/peer/outbox 与管理面板继续在 TODO。

## dev：真实 Runtime 模块交接（未发布）

- Agent-owned 闸门改为版本化共享 WeakMap/driver；真正替换 ESM 模块后接管原 Agent/主 Session，不叠加旧 provider。关闭等待旧工具、审计、消息与回复 flush；整组 attachment 成功后才开放业务，首次注册失败只回滚自己的 effects。
- 重载保留去重索引、已审计回复、失败证明与退役归属，current 由新原生事件建立；初始化/失败期间的输入留在 DSH Inbox。兼容模块可重试加载并修复原回执，不重复 Git 提交。
- 类型、43 项 Host + 78 项 Runtime（121 项）和 64 组 Bash 回归通过。新增 Chromium 真实 HMR 验证旧写者收尾、同一主 Session、SOUL/MEMORY 更新、profile 替换导入失败/修正重试，以及无关 Session 可用；四类安装及既有 Runtime/迁移浏览器回归也通过。证据：`/tmp/mbot-handoff-suite-serial.log`、`/tmp/mbot-plugin-install.Xqps39`、`/tmp/mbot-gui-handoff.8qhavO`、`/tmp/mbot-gui-runtime.QYJS76`、`/tmp/mbot-gui-migration.vke9Qu`。没有调用真实 DeepSeek API；详见 [模块交接](runtime-handoff.md)。

DSH 文件监听的导入预检与 profile reconciliation 的先停后导入分别保留旧版或保持不可用，按实际路径处理失败。无共享 cell 的旧版闸门仍需要支持迁移，作者真实旧 Host 的实际续聊尚未验收；Worker/PTC、compact/sleep/checkpoint、IM/peer/outbox 和管理面板继续在 TODO。包仍为 0.1.1，未打新 tag。

## dev：旧只读回合迁移与升级（未发布）

- 新增 botctl migrate-readonly/--check，通过官方 DSH 只读 handle 核对旧回合；不执行生产 profile、创建第二个 Agent 或改写原生日志。完整核心只读调用/结束事实、工具定义、Git 基准和两把数据锁支持原 Host 仍存活时恢复旧审计；写操作/Bash/未知工具继续拒绝，scope 不改变。
- cold Host recover 支持相同旧只读证明。迁移记录原生 cut/hash 和调用指纹，保持 PAUSED；独立迁移不修改旧 Runtime 的内存错误，加载新版本后使用同一 Session 继续对话，无 messages 的旧头不生成新回复证明。
- 43 项 Host、70 项 Runtime、类型、64 组 Bash、四类安装及两套 Chromium 验收通过；旧版实际包验证受保护独立进程排除、Host 后代拒绝、只提交一次、拒绝写者、升级及对话。没有调用真实 DeepSeek API。详见 [旧回合迁移](legacy-migration.md)。

作者本地原始旧 journal 已使用正式入口恢复：completed、无违规、故障计数 0，只新增两个审计文件，保留 PAUSED；证据在 `/tmp/mbot-original-migration-result.json`。原生会话和其他 Host 服务保留，旧 Runtime 的内存错误与实际续聊仍需安全加载/核验。

非只读旧契约、缺失日志/其他写者、Worker、compact/睡眠、IM/peer/outbox 和管理面板继续在 TODO；包仍为 0.1.1，未打新 tag。

## dev：前台 Runtime/Agent 中断恢复（未发布）

- /mbot recover 与 botctl recover 已协调原生 Session writer、Agent/前台工具和数据事务；保留 Bot ID、主 Session、Inbox、PAUSED 与单次 Git/故障计数结算。DSH 原生 resume 补齐崩溃回合，MBot 核对私有桥事件及真实结束事件，恢复不调用模型或自动 resume。
- 新 turn 保存固定 foreground-only v1 契约；私有 Host proof 绑定原生 cut、journal 和 PID 出生身份，存活 helper/许可进程、writer-held、未知/Worker/后台契约继续拒绝。已登记 Bot 的数据目录禁止配置改绑。旧头需原 Host 的捕获记录，无 messages 的旧头继续旧审计，不生成新回复证明。
- 提交失败后仅识别与 commit intent/私有副本一致的 Host 审计产物，正常 guard 继续检查修改过的副本。Git 已提交时只核验/结算；原生回执保存失败可独立补 flush，恢复自身在 Git 成功后的 flush 失败也能重试而不重复提交。
- 43 项 Host、69 项 Runtime（含 12 项恢复专项）、类型、64 组 Bash、四种安装及 Chromium 验收通过。真实浏览器验证提交失败恢复、模型运行中 SIGKILL Host、原生 closers、固定请求失败回复和显式 resume；没有调用 DeepSeek API。证据：`/tmp/mbot-recovery-suite-final.log`、`/tmp/mbot-plugin-install.ouOlB3`、`/tmp/mbot-gui-runtime.ICQgBw`，详见 [Runtime 恢复](runtime-recovery.md)。

当前恢复覆盖前台契约；Worker/PTC/IPC 写者、未知旧契约/原生日志丢失的迁移与恢复、compact/睡眠/checkpoint、IM/peer、outbox 和管理面板继续在 TODO。用户旧 Chief journal 的真实恢复不由隔离测试结果证明，原始反馈和证据保留。包仍为 0.1.1，未打新 tag。

## dev：Bot 注销与持久 Session 退役（未发布）

- 新增 /mbot remove/removed 与 botctl remove/removed，解决创建后无法退出活动列表的反馈。原生工作区删除保留独立 Bot，显式注销保留 Git 数据、Session 历史、Inbox 和恢复证据；重新导入生成新的 Bot 身份与主 Session。
- 登记文档 v2 兼容 v1，持久保存不可变退役快照及全部旧主/预留 Session ID。注销核实原生写者与数据锁，执行/审计中拒绝且不取消当前模型；保存前临时闸门可回退，保存后旧 Agent 的被动闸门跨 Runtime 重载与 Host 重启。
- 43 项 Host、57 项 Runtime、类型、64 组 Bash、四类安装与实际 Chromium 验收通过，覆盖并发输入、失败保存、CLI 断连重试、工作区删除和 SIGKILL 重启；见 [Bot 注销](bot-removal.md)。未调用真实 DeepSeek API。

Chief 旧运行 Host 请求头的兼容修复已在前一阶段提交；其遗留 agent-runtime journal 仍需协调恢复。Worker、IM/peer、回复 outbox、compact/睡眠和管理面板继续推进。包仍为 0.1.1，未打新 tag。

## dev：按请求核验并查回回答（未发布）

- receipt 增加独立的 result/audit/reply，按原生请求/回合和可达 Git 审计查回实际回答，稳定 replyId/固定原路线；CLI receipt --wait 支持等待及截止。后续对话、重载、merge 或当前文件编辑不替换原回答，展示卡片不参与证明。
- 新审计保存原生结束位置、目标和回答指纹，并用可重建的脱敏掩码绑定最终文本；outcome 的 jq 校验由提交/计数/查询共享。Git 已提交但 journal 未结算时不释放回答；提交失败/原生持久确认失败可查明，不重复启动模型。
- 修复源码链接下旧运行中 Host 请求头遇到新脚本时的验收失败：无新增消息头字段继续原审计，旧记录不伪造新版证明。已中断 journal 仍保留，需后续 Runtime 协调恢复。
- 91 项 Host/Runtime、类型、64 组 Bash、四类安装及 Chromium 实际 CLI/重启回答验收通过，见 [请求回答](request-replies.md)。未调用真实 DeepSeek API。

本阶段完成查回与待投递回复信封；外部 outbox 投递/确认、Bot 删除/退休绑定、Runtime 恢复、Worker、IM/peer、compact/睡眠和管理面板继续推进。包仍为 0.1.1，未打新 tag。

## dev：botctl 本地宿主 IPC（未发布）

- 新增 talk/receipt/runtime/stop/bots 外部 CLI，按明确的 profile/Bot 身份连接实际主 Session；复用所有者信封、原生 Inbox 和审计，正文支持 UTF-8 stdin/字面 shell 字符。同 ID 重试复用消息，断连不取消共享执行，收据仍区分持久确认与模型/审计完成。
- Cordis bundle 增加 dsh-mbot/ipc，按官方 profileContext 在 /tmp 派生私有 Unix 端点；flock 与原子 PID 出生身份记录约束归属。关闭先 drain 转交操作，丢锁不允许活宿主被提前替代；不安全对象拒绝，崩溃后核实旧宿主并回收遗留 socket。基础 headless 明确拒绝未绑定会话业务，不创建替代 Agent。
- 79 项 Host/Runtime、类型、64 组 Bash 回归通过；source/tarball/Git 与 Web tarball 安装通过，Chromium 验证 CLI 入原生聊天、停止/队列保留，以及 SIGKILL 重启后的同 MessageId 去重。依据：`/tmp/mbot-ipc-suite-final.log`、`/tmp/mbot-plugin-install.iXPiZR`、`/tmp/mbot-gui-runtime.GFwT3v`；见 [使用与边界](host-ipc.md)。没有调用真实 DeepSeek API。

IM/peer、隔离域、审计终态/回复 outbox、Worker、compact/睡眠及 Runtime 恢复继续在 TODO；包仍为 0.1.1，未打新 tag。

## dev：所有者消息准入与原生投递收据（未发布）

- 新增可信 Host 的 ownerMailbox，固定已验证的所有者、主 Session、对话键和回复路线；文本信封使用命名空间请求 ID 与不可变指纹，并发/重载后的同 ID 重试复用原消息，改变正文/关联 ID/回复路线报冲突。
- 原生 Web/适配器/后续 steer 共用来源和执行前 flush 闸门；网页 rpcId、旧 requestId 及实际 steer 输入纳入 Git 审计。来源未准入时不调用模型，保留原生 Inbox；卸载保留未执行 claim，原生上下文/待办编辑与准备后的引用文本继续兼容。
- 投递收据区分 confirmed/unconfirmed 和 queued/claimed/ended/cancelled，从原生事件重建，不能当成 guard/Git 提交证明。39 项 Host 与 30 项 Runtime、类型、64 组 Bash、四类安装及 Chromium 主 Session 审计/原生停止回归通过，见 [消息准入](message-admission.md)。没有调用真实 DeepSeek API。

本阶段只完成 Host 私聊准入基础。CLI IPC、真实 IM/peer、隔离 conversation、审计终态/回复 outbox、wake、Worker、compact/睡眠及 Runtime 恢复继续在 TODO；包仍为 0.1.1，未打新 tag。

## dev：正常停止与故障计数（未发布）

- 规范化 managed turn outcome：成功 completed 归零，干净的原生 user 停止 cancelled 保留原计数，其他失败 failed 递增；三次正常停止不会增加故障，之前的故障也不会被取消清零。
- 停止中的越权和已记录执行错误仍失败；聊天区、runtime/status 显示规范化结果，cancelled 仍为 success=false。审计 meta/Host 返回版本化 outcome/effect，journal 升至 v2 阻止旧 reader 误结算，Git 结算与恢复共用校验；旧 meta 继续原 success 语义，不一致的新格式保留现场。
- 39 项 Cordis/Host、17 项 Runtime、64 组 Bash、四类安装与 Chromium 验收通过，覆盖 completed/cancelled/failed 的两个崩溃边界、旧格式及无重复结算；见 [停止语义](turn-outcomes.md)。没有调用真实 DeepSeek API。

统一消息、Worker、睡眠/恢复和管理面板仍在 TODO；包仍为 0.1.1，未打新 tag。

## dev：主 Session 审计反馈与停止（未发布）

- 聊天区独立 MBot 卡片区分处理、验收、已提交、本轮未通过和验收未完成；显示真实审计提交与脱敏错误，支持双窗口和刷新重放。展示记录不进入模型 surface，Git/journal 继续持有事务真相。
- 新增 /mbot runtime 与 /mbot stop：查询执行/验收/队列，取消捕获的回合并等待写者、Git 和 Session 回执，返回该回合收据，随后接收的新工作不扩大等待范围；原生停止已使用 keepInbox=true，真实按钮验收确认待办保留。
- 已提交但回执保存失败保留 commit、阻止继续执行，失败提交保留原 HEAD/journal；后台能力的 run_code 需接齐写者生命周期才开放。33 项 Cordis、14 项 Runtime、64 组 Bash、四类安装、既有 Chromium 与新的本地 adapter 浏览器流程通过，见 [Runtime 反馈](runtime-feedback.md)。没有调用真实 DeepSeek API。

睡眠/唤醒、统一消息、Worker、Runtime 恢复与面板仍在 TODO；用户停止计数仍沿用原语义，待区分。包仍为 0.1.1，未打新 tag。

## dev：原生工作区与主 Session（未发布）

- Web 的 /mbot init 自动登记官方工作区、创建受管理主 Session 并在发起窗口打开；import 补建旧仓库的绑定，open/repair 支持导航和重试，原会话保留，创建不调用模型。
- 持久预留 Session ID 与 provisioning/ready/failed 状态；发布 Agent 前接入 Runtime，失败准入保留 Inbox。Bot 数据锁覆盖跨进程实体操作，ConfigEditor 更新保留独立的新选择，已开始会话先 resolve，用户标题与部分资源保留。
- 33 项 Cordis、9 项 Runtime、64 组 Bash 回归，基础 headless 三种安装与 Web tarball 真实主 Session/工具审计、故障探针及 Chromium 双实例/多窗口/重启/链接验证。详见 [主会话](main-session.md)。真实模型使用本地 scripted adapter，没有调用 DeepSeek API。

基础 headless profile 缺少 Controller 时保留只登记能力并提示；CLI init 仍只初始化数据。Worker、统一消息、取消/审计反馈、compact/sleep/checkpoint、Runtime 恢复与管理面板继续在 TODO，包仍为 0.1.1，未打新 tag。

## dev：原生 Agent Runtime（未发布）

- 将事务桥接入真实 DSH Agent：组装时取得 lease，Agent-scoped SOUL/协议/MEMORY 与原生近期历史组合；通过公开 surface replacement 更新旧系统段和记忆快照，保留原始 log 及 DSH 必需上下文。
- 原生 botctl 与官方前台 Bash 共用本轮身份/审计；boot 固定人格/记忆基准，候选/结果署名绑定角色，工具结果进入 Session 前脱敏。取消/期限先停止 Agent 和前台写者，下一轮等待提交；Runtime 关闭保留闸门和待办，重载复用同一 Session。
- 33 项既有 Cordis、9 项 Runtime、64 组 Bash 检查通过；三种安装实际创建 Agent 并通过本地 adapter 调用原生工具/提交，Chromium 回归通过，详见 [原生 Runtime](native-runtime.md)。没有调用真实 DeepSeek API。

实际主 Session 创建/导航、Worker、完整消息门面、compact/sleep/checkpoint、Runtime journal 恢复及管理面板仍在 TODO；未打新 tag。

## dev：数据 turn 中断恢复（未发布）

- 新增 Host recoverTurn、/mbot recover 与 CLI mbot recover；校验活写者、私有快照、PID 出生身份、Git/锁和保存的运行预算，恢复合法任务并回滚非法配置/记忆，保留 PAUSED 供明确复核。
- 提交前记录准确 commit intent，能识别 Git 已完成但未回执的 turn，仅结算一次；重复恢复为 no-op。SIGKILL 遗留许可在恢复写入前失效，恢复失败仍保留证据；无法确认的现场拒绝继续。
- 类型、33 项 Cordis、64 组 Bash 检查通过；source/tarball/Git 安装实测中断与恢复，真实 Chromium 回归通过。强制退出验收包括提交后和 committed 回执后两个位置；详见 [turn 事务与恢复](turn-transactions.md)。

恢复明确限定为 data-subprocesses，不覆盖真实 Agent/Worker、通用工具或睡眠 checkpoint。主 Session/Runtime/管理面板仍未交付，本阶段不打新发布 tag。

## dev：主 Session 事务基础（未发布）

- 新增 Host turn 事务桥：固定 Git/上下文快照、Bot flock、运行内 permit 数据调用、事件记录、guard/脱敏审计与单次提交；旧 CLI/headless 行为保留。
- 过期 permit 拒绝写入；取消等待拥有的数据进程，异常断连或完成超时保留 journal/snapshot 并暂停，避免未知现场继续执行。
- 类型、28 项 Cordis、64 组 Bash、三种真实安装及 Chromium 回归通过，详见 [turn 事务](turn-transactions.md)。

尚未将桥接入真实 Agent/Worker、主 Session、上下文投影、统一消息与睡眠/恢复；本阶段仍不打发布 tag。

## dev：0.2 实例登记阶段（未发布）

- 新增 profile 内稳定 Bot 登记、schemaVersion/revision、init 身份保存，以及 /mbot list/import/select 和对应 Host API。已有目录导入保留数据及历史，路径别名/重试复用身份；重名默认名称自动区分。
- 业务操作优先使用调用 Session 的已存绑定，再使用 profile 默认；原生工具在权限等待前固定目录，避免跨窗口切换后写到另一 Bot。
- 公开 schema 可导出，Host 初次加载/配置保存校验唯一性及引用；21 项 Cordis、64 组 Bash、真实三种安装与 Chromium 双实例/profile 隔离/重启验收通过。详见 [实例登记](bot-instances.md)。

DSH 工作区、受管理主 Session、Runtime 消息/上下文/睡眠与管理面板仍在 TODO；本阶段不打新的发布 tag。

## 0.1.1（2026-11-27）

- 修复只执行过 /mbot 命令的新会话没有结果：最小浏览器入口激活聊天视图，复用 DSH 原生命令卡片，支持状态、展开、重放与多窗口同步，不写入模型上下文。
- 插件 init 成功后通过 ConfigEditor 保存实际目录，后续命令/原生工具与重启使用同一选择；串行初始化，保留并发的新配置。失败保留旧选择，创建后保存失败明确报告部分成功。
- 类型、16 项 Cordis、64 组 Bash 检查通过；source/tarball/Git 安装通过；真实 Chromium 验证中文/空格目录、错误、锁忙/PAUSED/空闲、展开、多标签页、刷新/重启及无模型调用。依据与复跑见 [P0 验收](p0-feedback.md)。

CLI init 行为兼容；Bot 实例、DSH 工作区自动登记、受管理主 Session 和自有设置面板仍待 0.2.0。client factory 随包分发，无安装时构建。原有 v0.1.0 标签保留。下文的限制按对应历史版本理解。

## 0.1（npm 包版本 0.1.0）

2026-11-26，首个可运行的 DeepSeek Harness/Cordis Host 插件版本，主要功能实现于 d1bd4e6。本文件将原 TODO 已完成项目收拢为能力与验收摘要；后续见 [TODO](../TODO.md)。发布标签以作者选定提交及 Git refs 为准，不强制固定到该实现提交。

文档整理日期：2026-11-27。以下功能以现有 0.1 代码为基线；新反馈与后续规划尚未作为功能实现发布。

### 已交付

| 阶段 | 完成内容 | 验收依据 |
|---|---|---|
| M0：行为核实 | headless 凭据、NDJSON、权限、AGENTS、环境继承、Worker 并发/深度、中断、模型覆盖 | [M0](m0-spike.md) |
| M1：数据与工具 | 独立 Git 模板、配置解析、安装入口、botctl 看板/任务/候选、预算/链接 lint、锁与回滚 | README、离线集成检查 |
| M2：运行闭环 | run、脱敏 transcript/meta、归属护栏、inbox 前缀保护、暂停/熔断、统一 Git 审计 | [M2](m2-run.md) |
| M3：记忆闭环 | 独立 Dreaming、逐文件删除依据、失败恢复、完整行预算、checkpoint/pending 续读、revert | [M3](m3-dream.md) |
| M4：星型调度 | Chief 持久派活、两 fresh Worker 并发、中断/blocked、tick、原样归档、物理 grants | [M4](m4-schedule.md) |
| M5：运维工具 | cron 示例、私有日志、可选备份、clone 冷启动、PAUSED/resume/revert 演练、人工快照 | [第零天](m5-ops.md)，7 天未完成 |
| Cordis 插件化 | bundle、ESM 服务/公开类型、原生 botctl、/mbot handler、volatile schema、进程清理、完整资源与双 bin | [插件验收](plugin.md) |

Markdown/Git 保存任务与长期记忆；工作 Bot 只读记忆，remember 投递候选，Dreaming 独立整理。源码和 tarball 可用 dsh plugin add 安装；卸载保留数据仓库。不依赖安装时编译，不自动部署生产 cron。

### 兼容与验证

- 实测 Linux、Node 22.23.2、DSH 0.2.2-rc.5；支持 Linux/WSL 的本地环境，需要 Bash、Git、jq、flock、awk、GNU coreutils、C.UTF-8。
- 公开类型、11 项 Cordis、64 组 Bash 检查通过；两种真实安装覆盖激活、工具/命令 handler、schema、bin、卸载。
- 真实模型验证任务/候选 → Dreaming → 后续冷启动 → revert，Worker 并发/中断，以及从另一项目调用包内原生工具和 Dreaming。
- 凭据、node_modules、运行产物不入包；原始日志忽略且私有，入库审计与返回结果脱敏。

这些证据覆盖 Host、事务、安装和模型行为，不等价于完整 Web/本地聊天界面验收。

### 已知限制与安装后反馈

1. 用户报告 /mbot init <path> 创建成功，但聊天区看不到结果，status 也没有提示。Host 返回文本，UI 链待定位修复。
2. 显式 init 路径不自动成为后续选择；当前只建 Git 数据仓库，不登记 DSH 工作区或持久主 Session。run/tick/dream 每次新建 headless 会话。
3. 有 volatile workspace Config schema，尚无自有设置/管理面板、实例列表或浏览器入口。旧文档对“设置页已实现”的描述过宽，现已纠正。
4. chief/coder 是仓库内角色，多 Bot 实例登记/会话绑定/迁移未实现；7 天连续调度观察待完成。

当前可靠入口是 CLI、原生工具与手工 profile patch；界面缺陷优先修于 0.1.1。实例、主 Session、管理面板规划为 0.2.0；主 Session 业务执行必须接入等价审计护栏。

### 发布与后续维护

0.1 是首版名称，0.1.0 是 package.json 版本；Git 分支与发布 tag 必须区分，新 tag 推荐 v0.1.0。Git 安装以远端可见 tag/commit 为准，GitHub Release/Actions 不是安装必需，本说明不宣称已完成 npm 发布。

后续在这里记录变更、迁移、验收、限制；已完成工作从 TODO 移入相应版本。维护者遵循根 [AGENTS](../AGENTS.md)，运行 Chief/Worker 遵循数据仓库协议。

## 0.1.1 附带：规范优化（2026-11-27）

- 修复中英文 locale 为 DSH 使用的 meta.title/meta.description，实际插件管理器读取通过。
- 安装验收增加无开发依赖的 Git fixture；源码链接、Git、tarball 三种方式均验证元数据、激活、工具/命令、schema、bin 与卸载。
- 纠正把 0.1 分支当 tag、把发布标签永久锁定到实现提交的说明；最新复查已有作者推送的 v0.1.0 → 27cb31c。使用完整版本 tag 的建议见 [发布检查](plugin-standard-review.md)；本轮优化未自动并入已有标签或另作发布。

## 设计更新：受管理的主 Session（未实现）

将“只读入口”的过渡方案明确为插件管理上下文的真实交互 Session；规定统一 botctl 门面、DSH Inbox/执行边界、对话域隔离、运行内工具通道、多窗口并发、跨 Bot 异步消息与 compact/睡眠 checkpoint。见 [Session Runtime](session-runtime.md)；本轮只更新设计与 TODO，不宣称新增运行能力。
