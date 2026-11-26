# Bot 实例登记与选择（dev）

2026-11-27。本阶段建立 0.2 的实例基础，尚未发布新版本；v0.1.1 保留原行为。主 Session、DSH 工作区自动创建、Runtime 准入和管理面板仍待实现。

## 当前接口

```text
/mbot init /absolute/new/data-directory
/mbot import /absolute/existing/data-directory
/mbot list
/mbot select <botId 或完整名称>
/mbot status
```

init 保存数据目录、稳定 Bot 身份并选择新实例。import 支持绝对路径或 ~/，先通过原有 lint 与角色 boot 校验；canonicalize 后同一目录只登记一次，不覆盖 Git、角色、记忆、看板或用户未提交文件，也不切换当前默认 Bot。list 显示登记、默认选择和绑定情况；select 接受完整 botId 或名称。名称默认来自目录，不同目录同名时自动加序号；Host 显式指定的重名会拒绝。

Host API 为 ctx.mbot.registry()、importBot(directory, {name?, defaultRole?, revision?, signal?})、selectBot(identity, {revision?, signal?})、describeBots()。查询返回分离快照，外部修改不会改变有效状态。defaultRole 当前用于 /mbot run；原有 tick 仍使用事务核心的 Chief 调度。

## 持久化与选择

Config.registry 是 profile-owned 的单个 volatile 文档：

| 字段 | 内容 |
|---|---|
| schemaVersion / revision | 1 / 每次修改递增，用于迁移和并发保存检查 |
| selectedBotId | 此 profile 的默认实例，可为 null |
| bots[].schemaVersion / botId | 1 / 稳定 bot-UUID |
| name / workspacePath / defaultRole / createdAt | 名称、真实目录、角色及 ISO 时间 |
| workspaceId / mainSessionId | DSH 引用；本阶段创建/导入后为 null |

由官方 ConfigEditor 编辑对应插件行，不直接写 profile YAML；数据不放进共享的全局 storage domain，避免同一 DSH_HOME 下各 profile 的 Bot 列表串联。公开 schema 保持可导出，Host 首次加载及 internal/config 保存校验检查重复身份/名称/目录/引用、未知选中身份、版本、时间及不完整绑定。无效保存不改变有效配置。

创建/导入/选择在当前 Host 内串行；ConfigEditor 提供 profile 文件锁、最新值重读、验证、原子写入和 Loader reconciliation。传 revision 的管理调用拒绝旧页面保存；导入重试复用已有身份且不增加 revision。初始化成功后的目录与登记/默认选择在一次配置编辑中保存，期间的新选择不被覆盖。失败保留此前状态，已建仓库而保存失败明确报告部分成功。

业务操作选择顺序为显式 botId → 调用 Session 的已存 mainSessionId 绑定 → profile selectedBotId → 旧 workspace/Bash 来源。已绑定 A 的操作不会因另一窗口选择 B 而重定向；原生工具在权限等待前捕获目录。运行参数、选项与目录按调用固定，不写可变全局 process.env。Bash CLI 继续使用 -C/MBOT_WS/用户配置，不读取 DSH profile。

Session 绑定路由已用受控引用测试；实际工作区/主 Session 的创建、恢复、校验与每轮上下文/事务仍待下一阶段接入。不能把本阶段的 null 引用或普通 Session 当作已经交付的主 Session。

## 验收

- 类型、21 项 Cordis 与原有 64 组 Bash 检查通过。新增检查包括保留脏仓库、目录别名/重试去重、名称冲突、A/B 绑定路由、原生工具权限等待、revision 与无效持久引用。
- 真实 source/tarball/Git 安装通过，探针调用官方 ConfigEditor 完成导入/选择/去重，再验证 native tool、命令、schema、bin、元数据和卸载。证据：/tmp/mbot-plugin-install.OEevQI。
- 真实 Chromium/tarball 验证 init/list/import/select/status、多标签页、刷新/Host 重启、稳定身份和双实例恢复。同一 DSH_HOME 下另一个实际 profile 的登记起初为空，导入同一目录获得独立身份。没有模型调用；证据：/tmp/mbot-gui-test.mKidlm。

验收探针从 apply 返回后再运行，并为插入的插件指定稳定 id，避免 ConfigEditor 等待自身启动或重排 YAML 后重建无名探针。产物在 /tmp，不读取用户 profile 或工程 .env。运行方式沿用 npm test、npm run test:install 与 [浏览器说明](p0-feedback.md#复跑)。
