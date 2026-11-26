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
- 外部消息与运行内工具分通道，不能重入同一队列死锁；持久多 Bot Host 的运行身份按 Agent/子进程传递，不写入可变全局 process.env。
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
