# TODO：0.1 之后的迭代

0.1 是可运行的 Cordis Host 插件与 Bash 事务核心。已完成事项汇总在 [发布说明](docs/RELEASE_NOTE.md)，实现与后续边界见 [设计](docs/design.md)，维护约定见 [AGENTS](AGENTS.md)。本文件只保留未完成工作，按 P1 → P2 推进；每阶段独立验收、更新文档并提交。

P0 命令反馈与目录选择已完成，归入 [0.1.1 发布说明](docs/RELEASE_NOTE.md)。当前从 P1 推进主 Session；P2 的最小浏览器入口已随修复落地，管理面板尚未实现。

## P1 · 0.2.0：Bot 实例、DSH 工作区与主 Session

Bot 实例是用户创建的一套独立数据及会话绑定；chief/coder 是实例内角色。0.1 的每次 run 都是新的 headless 会话，尚无持久主 Session。

实例登记、init 身份保存、list/import/select、版本/revision 校验及路由基础已在 dev 实现，见 [实例登记](docs/bot-instances.md)。下面只列未完成部分。

Host 的 turn 事务桥及数据工具 permit 已实现并验收，见 [事务基础](docs/turn-transactions.md)；尚未接入 Agent/Worker，也未完成恢复，不能视为主 Session 已交付。

- [ ] 在已有实例 API 上补齐 DSH 实体创建/修复与相应命令，完成部分失败的状态记录和重试
- [ ] 插件 /mbot init 自动完成数据仓库初始化、DSH 工作区登记、Chief 主 Session 创建和绑定；CLI mbot init 继续只初始化数据仓库
- [ ] 完成后显示结果与主 Session 链接，默认打开新 Bot 的主 Session；保留发起命令的旧会话；初始化本身不调用模型
- [ ] 使用官方 workspace/session/controller API；创建可重试、去重，部分失败可修复；只清理由本次创建且仍安全的资源，不删除用户已有目录或会话
- [ ] 为已校验导入的旧仓库补建 DSH 工作区/Session 绑定；迁移识别数据版本并保留原 Git、角色、记忆和看板
- [ ] 实现受管理的真实主 Session：版本化 SOUL/MEMORY、近期摘要/尾部、本次请求与 DSH 必需上下文；按 Agent scope 注册并验证旧快照的 shadow/projection，详见 [Session Runtime](docs/session-runtime.md)
- [ ] 统一 botctl 门面与 Runtime 准入：带来源/身份/requestId/对话域/回复路由，复用 DSH Inbox/FIFO，校验去重、收据、取消及崩溃转交，不另造独立消费状态
- [ ] 在真实 Agent/Worker 与全部工具路径接入已验证的 turn 事务桥；组装上下文前取得租约，结束后静止所有写者并验收/提交；按 Agent/子进程传权限，不用全局 process.env 保存多 Bot 身份
- [ ] 完成遗留 turn journal 的恢复/补偿：核实存活写者、私有快照和 Git/commit 阶段，不以删除 journal 或普通 resume 掩盖未确定现场
- [ ] 实现 compact/sleep/wake 闸门与 memoryCommit/contextEpoch/sourceCut checkpoint；睡眠继续接收消息，失败可恢复，主 Session ID 稳定；未接齐上下文/准入/护栏前不开放不受控主会话业务执行
- [ ] 按调用 Session 的绑定选 Bot，避免一个面板的全局选择重定向其他 Bot 会话；重启恢复绑定，缺失/归档 Session 显示修复入口
- [ ] Worker 保持 fresh、深度 1、任务文件交接；Dreaming 独立；恢复数据仓库不要求原 DSH Session 仍存在

**验收**：A/B 各有独立目录、DSH 工作区与主 Session，直接对话使用受管理上下文；多窗口并发、重复提交、睡眠中消息、cancel、checkpoint 崩溃恢复与旧规则不复活通过；wake 不重复实体，内部工具不死锁；导入/切换/重启正确；权限、审计与 headless 兼容。

## P2 · 0.2.0：MBot 设置与管理面板

0.1 只有 Host Config 与 volatile workspace schema，没有自有设置面板；此前把 schema 验收写成设置页交付，需要纠正。

- [ ] 扩展已有最小 client 为管理面板；保留 dsh.client、./client、bare dsh-mbot 根行及 Host/headless 独立使用约定
- [ ] 用受支持的 Plugins/Settings 扩展注册 MBot 面板，不修改 DSH 核心；明确页面路径以及关闭/卸载清理
- [ ] 显示实例列表、当前选择、目录、主 Session、角色与运行状态；提供创建、导入、选择、打开和修复
- [ ] 管理插件默认项和各 Bot 已支持的预算、超时、grants、备份等配置；SOUL/MEMORY 先展示，长期记忆仍遵守既有写者规则
- [ ] 区分插件 Config、Bot 的 .mbot/config 与 DSH 实体；Host 校验后原子保存，数据配置形成 human commit，不重复维护同一值
- [ ] 使用 ConfigEditor/form revision 和 volatile 更新；无效值、并发或保存失败不改变有效配置；凭据只使用引用
- [ ] 显示缺失实体、PAUSED、预算超限、错误与最近报告；面板/日志不展示明文 key
- [ ] 构建、打包可加载 client bundle；真实界面验收创建、编辑、重启、切换、开关和卸载，不能只查 schema 或调用 handler

**验收**：安装后面板可见，创建 Bot → 主 Session → 配置保存 → 重启恢复可走通；A/B 不串；刷新/多标签页不重复注册；CLI/headless 不依赖浏览器。

## 持续验收与后续增强

- [ ] 发布工程：使用与包版本对应的完整 tag（推荐 v0.1.0）；增加 CI；按需增加上传 tgz/校验和的 Release Action，发布不是安装必需项
- [ ] 将 engines.dsh、DSH peers 和实际兼容测试矩阵对齐，避免把宽范围声明视为已验证；规范检查见 [发布检查](docs/plugin-standard-review.md)
- [ ] 至少 7 天真实调度观察：每日检查记忆预算、nightly 提交/报告、违规处理，在 wiki/ops-log.md 记录；第零天不等于完成
- [ ] IM 接入：适配器通过统一门面路由，专用所有者私聊可连主 Session，群/不同用户按可见域隔离；QQ 单账号支持 @alias，传话 Session 只做路由/展示，验证回复不会广播串会话
- [ ] 独立 Bot 间异步信封、reply/correlation、目标权限与 hops/TTL；send_message 仅保留 Worker 树内通信；验证 A/B 相互请求不阻塞彼此 actor
- [ ] 两 Host 写者争用、过期 Worker 回写、配置/队列并发编辑、IM 重试与投递不确定状态的故障验收；不把 FIFO 或 accepted 收据视为跨系统 exactly-once
- [ ] 升级/迁移：配置与登记 schemaVersion、模板兼容；不覆盖自定义协议/角色；验证旧 0.1 仓库及 profile
- [ ] Worker 结果文件隔离；transcripts 按月归档与 git gc
- [ ] 打包 mbot skill；复活“源”/“u”为真实 Bot；tether 等入口复用同一消息门面
- [ ] 建立 50–100 条私有评测，再决定全文索引/检索；不引入记忆数据库作为真相源

分支和标签按 Git refs 区分，不将某个 tag 的指向写死在规划中。新发布推荐完整版本标签，与 package.version 对应；具体状态及建议见 [发布检查](docs/plugin-standard-review.md)。修复与新功能使用相应提交/版本。
