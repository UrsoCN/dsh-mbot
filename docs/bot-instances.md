# Bot 实例登记与选择（dev）

2026-11-27。本阶段建立 0.2 的实例基础，尚未发布新版本；v0.1.1 保留原行为。dev 已接入原生 Runtime 与 [主会话创建/修复](main-session.md)，完整消息/睡眠生命周期和管理面板仍待实现。

## 当前接口

```text
/mbot init /absolute/new/data-directory
/mbot import /absolute/existing/data-directory
/mbot list
/mbot select <botId 或完整名称>
/mbot open [Bot ID 或名称]
/mbot repair [Bot ID 或名称]
/mbot remove <Bot ID 或完整名称>
/mbot removed
/mbot status
```

Web profile 的 init 保存数据目录、稳定身份和默认选择，然后自动创建工作区与受管理主 Session。import 支持绝对路径或 ~/，先通过原有 lint 与角色 boot 校验；canonicalize 后同一目录只登记一次，不覆盖 Git、角色、记忆、看板或用户未提交文件，也不切换当前默认 Bot；Web 命令还调用 ensureBinding 补建原生实体，可信 Host 的 importBot 单独调用仍只登记身份。list 显示登记、默认选择和绑定情况；select 接受完整 botId 或名称。名称默认来自目录，不同目录同名时自动加序号；Host 显式指定的重名会拒绝。

Host API 为 ctx.mbot.registry()、importBot(directory, {name?, defaultRole?, revision?, signal?})、selectBot(identity, {revision?, signal?})、describeBots()、ensureBinding(identity, {revision?, signal?})、resolveMainSession(identity, {revision?, signal?})、removeBot(identity, {revision?, signal?})、describeRemovedBots()。查询返回分离快照，外部修改不会改变有效状态。defaultRole 用于主 Session 的 Runtime 和 /mbot run；原有 tick 仍使用事务核心的 Chief 调度。

## 持久化与选择

Config.registry 是 profile-owned 的单个 volatile 文档：

| 字段 | 内容 |
|---|---|
| schemaVersion / revision | 2（兼容读取 v1） / 每次修改递增，用于迁移和并发保存检查 |
| retiredBots | 不可变的 Bot 登记快照、全部旧 Session ID 及退役时间 |
| selectedBotId | 此 profile 的默认实例，可为 null |
| bots[].schemaVersion / botId | 1 / 稳定 bot-UUID |
| name / workspacePath / defaultRole / createdAt | 名称、真实目录、角色及 ISO 时间 |
| workspaceId / mainSessionId | DSH 引用；正式主 Session 仅在实体/Runtime/持久化验证成功后保存 |
| binding | 旧记录默认 null；provisioning/ready/failed，预留 Session ID 与脱敏错误 |

由官方 ConfigEditor 编辑对应插件行，不直接写 profile YAML；数据不放进共享的全局 storage domain，避免同一 DSH_HOME 下各 profile 的 Bot 列表串联。公开 schema 保持可导出，Host 首次加载及 internal/config 保存校验检查重复身份/名称/目录/引用、未知选中身份、版本、时间及不完整绑定。无效保存不改变有效配置。

创建/导入/选择/注销在当前 Host 内串行；ConfigEditor 提供 profile 文件锁、最新值重读、验证、原子写入和 Loader reconciliation。传 revision 的管理调用拒绝旧页面保存；只登记的导入重试复用已有身份且不增加 revision；原生绑定各阶段按实际状态更新 revision。初始化成功后的目录与登记/默认选择在一次配置编辑中保存，期间的新选择不被覆盖。失败保留此前状态，已建仓库而保存失败明确报告部分成功。

业务操作选择顺序为显式 botId → 调用 Session 的已存 mainSessionId 绑定 → profile selectedBotId → 旧 workspace/Bash 来源。已绑定 A 的操作不会因另一窗口选择 B 而重定向；原生工具在权限等待前捕获目录。运行参数、选项与目录按调用固定，不写可变全局 process.env。Bash CLI 继续使用 -C/MBOT_WS/用户配置，不读取 DSH profile。

Session 绑定路由已接入实际工作区/主 Session，跨进程数据锁、预留 Agent 接管、部分失败修复和实体校验见 [主会话](main-session.md)。注销与持久旧 Session 闸门见 [Bot 退役](bot-removal.md)；原生工作区删除不会自动注销身份。近期 checkpoint、睡眠与 Runtime journal 恢复仍待实现。

## 实例登记阶段的历史验收

- 类型、21 项 Cordis 与原有 64 组 Bash 检查通过。新增检查包括保留脏仓库、目录别名/重试去重、名称冲突、A/B 绑定路由、原生工具权限等待、revision 与无效持久引用。
- 真实 source/tarball/Git 安装通过，探针调用官方 ConfigEditor 完成导入/选择/去重，再验证 native tool、命令、schema、bin、元数据和卸载。证据：/tmp/mbot-plugin-install.OEevQI。
- 真实 Chromium/tarball 验证 init/list/import/select/status、多标签页、刷新/Host 重启、稳定身份和双实例恢复。同一 DSH_HOME 下另一个实际 profile 的登记起初为空，导入同一目录获得独立身份。没有模型调用；证据：/tmp/mbot-gui-test.mKidlm。

验收探针从 apply 返回后再运行，并为插入的插件指定稳定 id，避免 ConfigEditor 等待自身启动或重排 YAML 后重建无名探针。产物在 /tmp，不读取用户 profile 或工程 .env。运行方式沿用 npm test、npm run test:install 与 [浏览器说明](p0-feedback.md#复跑)。
