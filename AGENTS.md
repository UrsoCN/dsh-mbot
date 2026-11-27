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
- 所有者消息准入见 docs/message-admission.md：ownerMailbox 绑定已验证的私人主 Session/发送者/回复路线；原生 rpcId 与旧 requestId 都关联审计，投递收据来自原生 splice/claim/end。confirmed 只证明 flush，ended 不证明 Git 提交；未知业务来源不绕过闸门，同 ID 重试不合成唤醒消息，隔离域/回复 outbox 与 Runtime 恢复仍待完成。
- 请求结果见 docs/request-replies.md：仅原生事件 + 可达 Git 审计 + journal/持久确认一致才释放回复，旧记录无证明不伪造终态；reply 文本 hash/掩码/目标/原生位置绑定，提交/计数/查询共用 lib/turn-outcome.jq。源码链接旧 Host 头兼容原审计，不让热更新脚本误暂停；中断 journal 继续保留待 Runtime 恢复，outbox 外部投递/ack 未接齐。
- 本地 CLI 见 docs/host-ipc.md：按官方 profileContext 派生私有 Unix 端点，owner.json 原子保存 PID 出生身份；丢锁不等于原宿主已静止，关闭先 drain 转交操作再释放归属，不 unlink 锁 inode。不创建替代 Agent/队列，断连不取消业务，运行内工具不得走 owner IPC；同权限本地进程仍是可信边界。
- 外部消息与运行内工具分通道，不能重入同一队列死锁；持久多 Bot Host 的运行身份按 Agent/子进程传递，不写入可变全局 process.env。
- turn 桥见 docs/turn-transactions.md：组装系统提示前取得 lease；只跟踪经桥发起的数据调用不等于所有写者静止。Runtime 必须协调 Agent/Worker/全部工具及期限；遗留 journal 不能靠删除或普通 resume 掩盖，许可 token 不入 prompt/审计。
- 数据 turn 恢复已有 recoverTurn / mbot recover：验证私有快照、PID 出生身份、Git/锁和 commit intent；journal 的 writerScope=data-subprocesses 仅覆盖 fresh 数据子进程。增加 Agent/Worker/IPC 写者前扩展静止协议，不能沿用该 scope 的范围假设；已提交但未回执的 turn 只能结算一次。
- 原生 Runtime 见 docs/native-runtime.md：Agent-owned 闸门在 Runtime 不可用时保留并拒绝模型执行，重载接管同一 cell；自定义工具必须声明/清理前台生命周期，不能把收据当静止。agent-runtime journal 当前不由数据 recover 处理；主 Session 实体见 docs/main-session.md；预留/失败状态禁止业务执行，已开始 Session 先 resolve，不用 create 替代 resume。审计回执见 docs/runtime-feedback.md，ignorable plugin record 仅作展示，不能替代 journal/Git；stop 等待捕获回合，不扩大为取消后续回合。计数规则见 docs/turn-outcomes.md；干净 user 取消 preserve 基准故障，不重置故障链，越权/已记录执行错误仍 increment；journal 新写 v2，reader/permit 兼容完整 v1；v2 必须有完整 outcome，不能降版本/删字段绕过。恢复按持久版本校验，不能从错误文案推断。完整 Worker/恢复/compact 仍在 P1。
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
- client/会话改动补真实界面流程，不只调 handler；保留 CLI/headless/源码/tarball 兼容矩阵。
- 文档/低影响可逆整理检查链接、事实、git diff --check、包内容，通常不另写镜像实现的测试。
- TODO 只放未完成；交付/验证摘要入 RELEASE_NOTE；design 区分基线/规划，README 面向当前操作。
- 不伪造持续观察时间，不将第零天写成 7 天；历史验收保留，新结果注明版本/证据。

## 提交与发布

- 每完成可验收阶段同步文档并 git commit；只暂存本次文件，不提交 .env、node_modules、tarball、临时日志。
- 包用 SemVer（如 0.1.0），发布 tag 推荐 v0.1.0 这类完整版本名，利于 DSH 索引识别；区分 refs/heads 和 refs/tags，发布前核对版本/lock、资源、文档与验收。
- 先核实既有标签，不为补说明随意移动；新 tag、远端推送、npm 发布按实际用户授权执行，本地提交不等于发布。
