# TODO：0.1 之后的迭代

0.1 是可运行的 Cordis Host 插件与 Bash 事务核心。已完成事项汇总在 [发布说明](docs/RELEASE_NOTE.md)，实现与后续边界见 [设计](docs/design.md)，维护约定见 [AGENTS](AGENTS.md)。本文件只保留未完成工作，按 P0 → P1 → P2 推进；每阶段独立验收、更新文档并提交。

## P0 · 0.1.1：命令反馈与目录选择

用户反馈：/mbot init /home/u/文档/mbot_demo 创建成功，却看不到结果；/mbot status 也没有提示。代码还存在一个独立问题：显式 init 路径只用于该次初始化，后续命令仍可能选择旧目录。

- [ ] 在实际 DSH 界面复现，记录版本、profile、入口及结果；沿 handler → commands.execute → command/run/done → 客户端 flow/renderer 排查，暂不假定 Bash 没有 stdout
- [ ] 聊天区显示运行中、成功、错误、跳过与取消；init 显示实际目录和下一步，status 显示当前 Bot/目录、看板、预算、PAUSED 与最近运行
- [ ] 优先复用 DSH 的命令事件和展示路径；默认不生成模型 role content、不触发模型；补充卡片/通知不能与已有 flow 重复
- [ ] init 成功后选中该目录，持久化通过 Host 配置入口；失败保留旧选择；明确环境/配置与未来 Bot 选择的优先级
- [ ] 补 commands.execute 与真实聊天区验收：中文/空格路径、目录已存在、工作区缺失、失败/取消、重启与重新打开 Session

**验收**：init → status → 重启 DSH → status，均看到正确目录与结果；错误和锁忙可见；控制命令不消耗模型调用、不重复消息；CLI 保持兼容。

## P1 · 0.2.0：Bot 实例、DSH 工作区与主 Session

Bot 实例是用户创建的一套独立数据及会话绑定；chief/coder 是实例内角色。0.1 的每次 run 都是新的 headless 会话，尚无持久主 Session。

- [ ] 定义实例登记数据：稳定 botId、名称、数据目录、DSH workspaceId、mainSessionId、默认角色、创建时间、schemaVersion；按 profile 隔离，引用 DSH 实体，不复制其完整状态
- [ ] 定义创建/列出/选择/导入/修复 Host API 与命令入口；新增语法在实现时定稿，不提前写成已可用
- [ ] 插件 /mbot init 自动完成数据仓库初始化、DSH 工作区登记、Chief 主 Session 创建和绑定；CLI mbot init 继续只初始化数据仓库
- [ ] 完成后显示结果与主 Session 链接，默认打开新 Bot 的主 Session；保留发起命令的旧会话；初始化本身不调用模型
- [ ] 使用官方 workspace/session/controller API；创建可重试、去重，部分失败可修复；只清理由本次创建且仍安全的资源，不删除用户已有目录或会话
- [ ] 导入已有 mbot_demo 等仓库：先 lint/识别版本，保留 Git、SOUL、MEMORY、看板和配置，再补建绑定
- [ ] 主 Session 加载 Chief 的角色/记忆/看板；初期是只读交互入口，业务变更委托现有受控 run，不直接替代有 guard 的执行链
- [ ] 按调用 Session 的绑定选 Bot，避免一个面板的全局选择重定向其他 Bot 会话；重启恢复绑定，缺失/归档 Session 显示修复入口
- [ ] Worker 保持 fresh、深度 1、任务文件交接；Dreaming 独立；恢复数据仓库不要求原 DSH Session 仍存在

**验收**：A/B 各有独立目录、DSH 工作区与主 Session；重复创建/重试不重复实体；切换及重启后绑定正确；旧仓库可无损导入；失败不留下不可识别的孤儿资源；现有权限、审计与 headless 检查通过。

## P2 · 0.2.0：MBot 设置与管理面板

0.1 只有 Host Config 与 volatile workspace schema，没有自有设置面板；此前把 schema 验收写成设置页交付，需要纠正。

- [ ] 增加 DSH client 浏览器入口、dsh.client 声明与 ./client export；附着 bare dsh-mbot 根行，Host/headless 独立使用
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
- [ ] 主 Session 受控业务执行：先设计每轮基准、锁、guard、回滚/提交，再考虑直接复用主 Session；接入前保留 headless run
- [ ] 升级/迁移：配置与登记 schemaVersion、模板兼容；不覆盖自定义协议/角色；验证旧 0.1 仓库及 profile
- [ ] Worker 结果文件隔离；transcripts 按月归档与 git gc
- [ ] 打包 mbot skill；复活“源”/“u”为真实 Bot；按需增加 dsh-im/tether 入口
- [ ] 建立 50–100 条私有评测，再决定全文索引/检索；不引入记忆数据库作为真相源

分支和标签按 Git refs 区分，不将某个 tag 的指向写死在规划中。新发布推荐完整版本标签，与 package.version 对应；具体状态及建议见 [发布检查](docs/plugin-standard-review.md)。修复与新功能使用相应提交/版本。
