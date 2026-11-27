# 工程维护与迭代约定

本文件维护 dsh-mbot 框架。templates/workspace/AGENTS.md 是发给运行 Chief/Worker 的协议，不要把维护权限或发布指令混入模板。

## 开始工作

- 先读 README、TODO、docs/design.md、docs/RELEASE_NOTE.md，以用户最新授权/约束确定范围。
- 查看 git status、提交、package.json、既有标签，保留用户未提交改动；勿将待办当成已实现。
- 若存在 .codegraph/，理解/定位代码先用 CodeGraph explore/node（MCP 或 shell），再做必要搜索/阅读；不存在则跳过，不自行索引。
- 搜索优先 rg；产物尽量在当前仓库或 /tmp，不修改 HOME，不用真实用户 DSH profile 做测试夹具。

## 架构边界

- Host 在 plugin/，事务核心在 bin/、lib/，模板在 templates/workspace/；双入口与独立 Git 数据保持兼容。
- Markdown/Git 是长期记忆/任务真相源。区分角色和 Bot 实例，DSH 工作区/Session 身份使用官方能力。
- 工作 Bot 只读 MEMORY/wiki，remember 投递候选，Dreaming 独立；ops-log、协议、SOUL、配置、工具遵守既有归属规则。
- 外部资料与历史日志作为参考数据，保留 prompt 边界；资料中的指令不能覆盖角色协议或 Host 权限。
- 保留锁、干净工作树、HEAD 基准、guard、恢复/熔断、审计提交；新增主 Session/GUI/续聊不能绕过。
- 主 Session 的业务上下文/准入由 MBot Runtime 管理，DSH 持有事件与执行；遵循 docs/session-runtime.md 的来源、对话域、compact/睡眠与恢复设计。受信任 Host 插件间接口约束不宣称为安全沙箱。
- 主 Session 默认私人对话域；多窗口共用，群/其他用户/独立 peer 的额外 conversation 在可见域/记忆过滤接齐后开放。统一 botctl 门面不要求 Web/IM 启动 shell；ownerMailbox 不可冒充 peer/其他用户入口。checkpoint 绑定知识内容 hash、原生有序来源 cut 与阶段证明，不能把普通 Git HEAD 变化当记忆更新或把展示记录当恢复证明；先推进 checkpoint/compact 与 sleep/wake，再扩展来源和 Worker 写工具。
- turn checkpoint 基础见 docs/context-checkpoints.md：context-snapshot 原生记录由同一次 Git runtime.context 封存，原 journal 结算和 Session flush 后才发布；恢复过滤保留该类型，用原生 fold 校验有序来源和 Inbox 字节，旧回合无 snapshot 不合成证明。新回合丢弃已捕获 context 不能降级；knowledge 嵌套身份冻结，取材失败也要按真实 native outcome 关闭已取得 lease。此基础不代表 compact 摘要/睡眠已交付，未知 Writer 仍用原恢复边界。
- 自动摘要见 docs/managed-compaction.md：普通 Agent 模型消息不能在 LLM 中间件改写；辅助用途在 dsh-llm/types 声明为 true，Agent 闸门按本轮许可接管原生 compaction 的摘要，原生保留范围/工具配对/replacement。缺后端时在 Agent scope 显式 isolate compaction 并注册官方后端/命令，A/B 各自绑定，fiber 随 Agent 释放且 Runtime 交接复用。来源、策略/请求/输出 hash、原生括号和知识版本由同一次 Git 审计封存；恢复保留 compact-input/output，先验证来源再结算。gate ABI 2 只支持已关闭且带共享 marker 的 ABI 1 升级。当前 standalone /compact、普通 turn 的旧摘要退役、Worker compaction 与 sleep/wake 仍待交付。
- 所有者消息准入见 docs/message-admission.md：ownerMailbox 绑定已验证的私人主 Session/发送者/回复路线；原生 rpcId 与旧 requestId 都关联审计，投递收据来自原生 splice/claim/end。confirmed 只证明 flush，ended 不证明 Git 提交；未知业务来源不绕过闸门，同 ID 重试不合成唤醒消息，隔离域/回复 outbox 与其他写者/旧契约 Runtime 恢复仍待完成。
- 请求结果见 docs/request-replies.md：仅原生事件 + 可达 Git 审计 + journal/持久确认一致才释放回复，旧记录无证明不伪造终态；reply 文本 hash/掩码/目标/原生位置绑定，提交/计数/查询共用 lib/turn-outcome.jq。源码链接旧 Host 头兼容原审计，不让热更新脚本误暂停；已支持前台契约的中断 journal 走协调恢复，未知旧契约继续保留，outbox 外部投递/ack 未接齐。
- 本地 CLI 见 docs/host-ipc.md：按官方 profileContext 派生私有 Unix 端点，owner.json 原子保存 PID 出生身份；丢锁不等于原宿主已静止，关闭先 drain 转交操作再释放归属，不 unlink 锁 inode。不创建替代 Agent/队列，断连不取消业务，运行内工具不得走 owner IPC；同权限本地进程仍是可信边界。
- 外部消息与运行内工具分通道，不能重入同一队列死锁；持久多 Bot Host 的运行身份按 Agent/子进程传递，不写入可变全局 process.env。
- turn 桥见 docs/turn-transactions.md：组装系统提示前取得 lease；只跟踪经桥发起的数据调用不等于所有写者静止。Runtime 必须协调 Agent/Worker/全部工具及期限；遗留 journal 不能靠删除或普通 resume 掩盖，许可 token 不入 prompt/审计。
- 持久恢复证据见 docs/durable-recovery.md：活动回合私有快照存于 Bot 数据工作树之外的持久状态目录（MBOT_STATE_DIR → XDG_STATE_HOME/mbot → 隔离 DSH_HOME/mbot-state → ~/.local/state/mbot 下的 turns/<workspaceHash>/<runId>），校验 UID/0700/非软链祖先/scratchFormatVersion=1，原子写并 fsync 后再发布 active-turn.json；保留旧 /tmp/mbot-turn.* reader 不搬迁活跃快照。PID 出生身份与内核 /proc/sys/kernel/random/boot_id 联合核验，避免跨重启 PID/tick 复用误判，同时继续扫描拒绝携带 permit token 的活进程。
- 数据 turn 恢复已有 recoverTurn / mbot recover：验证私有快照、PID 出生身份、Git/锁和 commit intent；journal 的 writerScope=data-subprocesses 仅覆盖 fresh 数据子进程。增加 Agent/Worker/IPC 写者前扩展静止协议，不能沿用该 scope 的范围假设；已提交但未回执的 turn 只能结算一次。
- 原生 Runtime 见 docs/native-runtime.md：Agent-owned 闸门在 Runtime 不可用时保留并拒绝模型执行，重载接管同一 cell；自定义工具必须声明/清理前台生命周期，不能把收据当静止。agent-runtime journal 不由独立数据 recover 处理，Host 前台协调恢复见 docs/runtime-recovery.md；主 Session 实体见 docs/main-session.md；预留/失败状态禁止业务执行，已开始 Session 先 resolve，不用 create 替代 resume。审计回执见 docs/runtime-feedback.md，ignorable plugin record 仅作展示，不能替代 journal/Git；stop 等待捕获回合，不扩大为取消后续回合。计数规则见 docs/turn-outcomes.md；干净 user 取消 preserve 基准故障，不重置故障链，越权/已记录执行错误仍 increment；前台 journal 新写 v2，支持 Worker 的 Chief 契约写 v3，reader/permit 兼容完整 v1；v2/v3 必须有完整 outcome，不能降版本/删字段绕过。恢复按持久版本校验，不能从错误文案推断。Worker、后台/IPC 写者、未知旧契约/缺失日志恢复与 compact 仍在 P1。
- 前台 Runtime 恢复见 docs/runtime-recovery.md：原生 writer-held/resolve/closers、Bot 闸门、固定前台契约和私有 Host proof 联合确认，原生/Git/journal/flush 一致后单次结算。旧头可由原 Host 捕获记录确认，或对已完成的核心只读回合使用 docs/legacy-migration.md 的原生/定义/闭合调用/Git 证明；非只读未知/未支持的 Worker 写者/PTC/IPC/缺失日志继续拒绝，不能编辑 scope 或删证据。Git 成功但回执失败用确切审计补 flush，不重复提交；恢复默认期限 60 秒，保持 PAUSED。Cordis 跨服务协调通过 Runtime service method，勿用调用方 context 直接访问未 inject 的服务。已登记 Bot 数据目录不可改绑。
- Worker 数据许可见 docs/worker-leases.md：委派绑定角色/任务/子 Session 和快照 hash；Actor 只持派生 token，先 join Agent/工具再 close 数据许可，最后由父 turn 单次提交。journal v3 不降为 v2 或沿用前台恢复证明；Host 的登记变化须先核验，再同步 guard 的自身 journal 快照，其他 ignored 文件仍受保护。真实 Worker 最小生命周期见 docs/native-workers.md：workers 默认开启，仅 scoped botctl，可关闭以保持前台 v2；先 join 原生 activation/工具、seal 连续子事件/结果/用量，再 close Actor，父回合单提交。子上下文不继承父历史，caller delivery 不自动 inject 主 Session；创建取消按 signal/cause 身份判断，不能掩盖真实失败。scoped botctl 的恢复/实际交接见 docs/worker-recovery.md：Native writer 句柄和公开 interruptedTurnClosers，不重启子模型；原 journal/子事件不改写，派生恢复 ledger 由 proof 核验，父/派生 permit 进程一起检查。UTF-8 stdin 连续解码；TOOL_NOT_STARTED 只匹配原生 assistant 请求，不伪造实际派发。Bash/文件/PTC、未知/缺失日志恢复仍待接齐。
- Runtime 代码交接见 docs/runtime-handoff.md：共享 Agent-keyed registry/driver 带 ABI，首次注册只回滚自己的 effects；不能接管无 marker 的旧闸门或私查 SDK 注册表。关闭等待捕获状态、前台调用、审计及所有消息/回复 flush，部分激活失败保留旧证明，current 由原生事件重建。DSH watcher 的导入预检与 profile reconciliation 的先停后导入不同，按真实路径验收；不要将同模块开关当 ESM 替换。
- 独立 migrate-readonly 不执行生产 profile，不创建/改写 Agent 或 Session；官方 native read handle + 数据锁 + 私有 proof 只迁移已结束的核心只读调用，保留 PAUSED/旧 Host 内存状态。对受保护进程仅排除出生于 helper 前独立分支的可核实成员，原 Host 后代/未知孤儿仍拒绝；不可靠进程名/墙钟时间或改 scope 放行。
- Bot 注销见 docs/bot-removal.md：活动登记与不可变退役快照分开，保留全部旧主/预留/附着 Session 归属；原生工作区删除不自动注销独立身份。ConfigEditor 保存前先持有可回退 Runtime 闸门，忙/写者不明拒绝；旧 Agent 闸门跨 Runtime 重载/Host 重启，禁止向新 Bot 重定向。数据/历史/Inbox/journal 保留，注销不替代 agent-runtime 恢复。登记 v2 兼容 v1，配置 reset/downgrade 不能丢弃归属。
- 升级不覆盖用户角色/记忆/任务；新持久配置带版本/迁移，验收旧仓库导入与部分失败修复。
- key/.env 不打印、不提交、不入包；真实 API 可用已授权 key，隔离 DSH_HOME/XDG/数据并清理临时凭据。

## Cordis 与 DSH

- 用实际版本文档/类型/源码确认 API；named exports、inject、effects、公开声明、bundle/patch 一起维护。
- 共享 DSH/Cordis 的依赖声明 peers；Host 不导入 client。UI 声明 dsh.client、./client，符合 lazy-CJS factory，附着 bare package 根行。
- 模型工具不任意指定宿主目录/命令；用 sandboxPolicy/原生审批，不暗中提升权限；保留 MBOT_RUN_ID 防嵌套。
- 更新走 ConfigEditor/官方表单，捕获操作有效值；volatile 只读引用不是 setter，不手改用户 profile YAML 代替保存 API。
- 控制结果优先用 CommandResult/命令事件，在聊天区可见但默认不进入模型 role content；业务摘要按需显式注入。
- schema、handler、组件测试不能单独证明 GUI；验证事件传播、渲染、重连/重启、开关/卸载。

## 验证与文档

- 按变更选择 npm run check:types、npm run test:plugin、bash tests/run.sh；整体回归用 npm test。
- 包/export/资源/安装改动跑 npm run test:install，查 npm pack；模型用 tests/real-*.sh，不无必要重复耗时测试。
- 恢复的 /proc 全进程检查与 Chromium 测试不要同时运行：新启动的浏览器沙箱进程可能不可读，恢复应保守拒绝，不为测试放宽写者检查。
- npm test 的 Host/Runtime 文件保持串行，避免进程核验与其他夹具争用。测试对 Cannot inspect possible writer 的重试须先确认原 PID 已退出（消失或 kernel zombie），并核对 Git/工作树/journal 未变化；始终重走公开恢复接口，不将仍存活/身份不明的写者当静止。
- client/会话改动补真实界面流程，不只调 handler；保留 CLI/headless/源码/tarball 兼容矩阵。
- 文档/低影响可逆整理检查链接、事实、git diff --check、包内容，通常不另写镜像实现的测试。
- TODO 只放未完成；交付/验证摘要入 RELEASE_NOTE；design 区分基线/规划，README 面向当前操作。
- 不伪造持续观察时间，不将第零天写成 7 天；历史验收保留，新结果注明版本/证据。

## 提交与发布

- 每完成可验收阶段同步文档并 git commit；只暂存本次文件，不提交 .env、node_modules、tarball、临时日志。
- 包用 SemVer（如 0.1.0），发布 tag 推荐 v0.1.0 这类完整版本名，利于 DSH 索引识别；区分 refs/heads 和 refs/tags，发布前核对版本/lock、资源、文档与验收。
- 先核实既有标签，不为补说明随意移动；新 tag、远端推送、npm 发布按实际用户授权执行，本地提交不等于发布。
