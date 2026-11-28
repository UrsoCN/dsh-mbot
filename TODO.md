# TODO

以 `0.2.0-rc.1` 为当前基线（2026-11-28）。本文件只保留未完成的执行事项；架构、路线依赖和远期大纲以 [DESIGN](DESIGN.md) 为准，已交付事项见 [RELEASE_NOTE](RELEASE_NOTE.md)。R1–R4 及 R5 首批热点优化已移出待办。

## R5：持续运行与性能

- [ ] 在真实隔离 Bot 连续观察至少 7 天，逐日人工核对预算、nightly 提交/报告、异常和恢复，并保存 `wiki/ops-log.md`；按 [运维验收](docs/operations.md#长期观察验收) 结算。
- [ ] 验证持续收信下维护准入的公平性，并设计/验收活动回合后的 sleep 调度；当前 sleep 遇活动回合返回 busy，先 stop/等待收尾。
- [ ] 用 `bench:runtime` 补数万轮历史、大 Worker 事件量、数百 MiB ignored 日志的数据与恢复耗时/峰值内存/子进程次数，按测量结果选择冷日志归档或受保护 checkpoint 锚点。
- [ ] 为常驻 Node 事务桥、Bot 锁粒度和纯对话审计分层形成独立设计与故障原型；先证明写集/回滚隔离、来源证明和单次结算等价，再决定是否实现，见 [性能规划](DESIGN.md#性能与事务演进)。
- [ ] 设计版本化 Markdown 结构标记与记忆/看板分级归档，验证旧模板导入、格式变化和预算临界值。

## P1：对话域、消息与写者扩展

- [ ] 实现持久 conversation 绑定、来源权限及记忆可见域过滤；覆盖多窗口、不同用户/群/线程，过滤接齐后才开放额外域。
- [ ] 接入真实 IM 适配器：所有者专用私聊可绑定主 Session，群/其他用户隔离；验证 QQ `@alias`、附件/路由恢复和回复不串域。
- [ ] 实现按已验证 replyRoute 的 outbox、ack 与投递不确定状态；覆盖 IM 重试、断连和提交前/后崩溃。
- [ ] 接入独立 Bot 的异步 peer 信封、目标权限、correlation/causation 与 hops/TTL；验证 A/B 互相请求不持锁等待。
- [ ] 扩展原生 Worker 的结构化目录 grants 与 Bash/文件/PTC 生命周期；覆盖并发写入、取消、晚到写者，并定义扩展版本恢复契约和 Worker compaction。
- [ ] 在对应写者契约接齐后扩展后台/IPC、非只读旧契约及日志/原所有者丢失的迁移与恢复；保留未知现场拒绝路径。
- [ ] 补共享 registry 之前旧闸门的支持迁移和其他插件写者的静止核验；在隔离旧 Host 验证原 Agent/主 Session 的实际续聊。
- [ ] 补两 Host writer-held/端点交接、过期 Worker 回写、配置与 Inbox 并发编辑、实体缺失/归档/意外返回与故障重启的联合验收。

## P2：完整管理与配置编辑

- [ ] 扩展现有 Plugins 最小面板，接通创建/导入/选择/修复/注销操作和缺失实体主动诊断；复用已有 overview/退役列表/打开主 Session 能力。
- [ ] 在 Host 统一插件 Config、Bot `.mbot/config` 和 DSH 实体的编辑入口，支持预算、超时、grants、备份及多模型凭据引用；数据配置保存形成 human commit。
- [ ] 用 ConfigEditor/form revision 验证原子保存、并发冲突、无效值和部分失败，确保有效配置不被失败操作改变。
- [ ] 实际安装后验收“创建 → 主 Session → 编辑 → 重启 → A/B 切换”，以及多标签页、重连、开关、卸载；保留 CLI/headless 独立入口。

## 发布与配套交付

- [ ] 启用 [CI 模板](ops/ci.yml.example) 并补安装矩阵；当前已有模板和快速基准，仓库尚未启用 workflow。按需增加 tag 产物/校验和的 Release Action。
- [ ] 对齐 `engines.dsh`、固定 peers 和实际测试矩阵；验证旧 `0.1` 数据/profile、登记及配置版本迁移，不覆盖自定义角色/协议。
- [ ] 完成上述正式版范围的联合回归和发布核对，再推进 `0.2.0`；版本/lock/tag 与验收证据一致，发布规则见 [发布检查](docs/plugin-standard-review.md)。
- [ ] 验证 Worker 结果文件隔离、数据仓库恢复与原生 Session 丢失的解耦，以及 transcript 月归档/`git gc` 流程。
- [ ] 打包 mbot skill；将“源”/“u”作为真实 Bot 恢复，tether 等入口复用同一消息门面。
- [ ] 建立 50–100 条私有记忆评测，再决定全文索引/检索方案。

P3 的身份、记忆治理、自演进、平台参与及多主体研究保留在 [DESIGN](DESIGN.md#远期研究p3)；选定具体实验后再拆出执行待办。
