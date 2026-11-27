# Bot 注销与旧 Session 退役（dev）

本阶段属于未发布的 dev，包仍为 0.1.1。Bot 身份、Git 数据目录和 DSH 工作区是独立对象；删除原生工作区不自动删除 Bot，仍可显式修复或注销。注销不删除用户文件、Session 历史、Inbox、审计提交或恢复 journal。

## 使用

```text
/mbot list
/mbot remove <Bot ID 或完整名称>
/mbot removed
```

```bash
botctl bots --profile web
botctl remove --profile web --bot <完整 bot-UUID> [--revision <当前登记版本>]
botctl removed --profile web
```

必须显式选择注销对象；终端 remove 只接受稳定 ID，避免断连重试误注销同名的新实例。结果卡片显示已退出活动列表、数据保留位置及旧 Session ID。已注销 ID 重试为 no-op，包括原 revision 已过期的情况；尚未注销时拒绝过期 revision、不同的新绑定或忙写者。传输断连只停止等待，先查 removed 或重试同一稳定 ID。

执行/审计中的 Bot 先 `/mbot stop <Bot>` 并等待收尾；注销不取消当前模型或绕过尚未静止的工具。旧主 Session 的 `/mbot runtime` 可显示 retired，新的业务输入留在原生 Inbox，不调用模型。旧 mailbox 撤销，talk/receipt 拒绝退役身份；历史仍从原生日志和 Git 查阅。

重新 `/mbot import <原目录>` 会创建新的 Bot ID 和新的主 Session，复用已有数据。旧 Session 始终保持退役，不因 profile 切换默认 Bot 或重新导入而改绑。也可从旧会话显式 init 新目录。

## 持久化与事务边界

Config.registry 文档升级为 v2：活动 bots 与 retiredBots 分开，后者保存完整登记快照、全部 main/pending/Runtime 附着 Session ID 和 ISO 退役时间。v1 在读取时规范化，下次管理保存写 v2；Bot 登记条目仍为 v1。首次加载校验唯一身份、全局 Session 引用和完整退役快照。配置更新不得删除/更改已有退役记录，也不得丢弃既有主/预留 Session 归属；不能 reset/downgrade 绕过。

注销顺序为：

1. ConfigEditor 读最新登记并核对可选 revision。
2. 数据锁存在时取得同一 flock；目录缺失或损坏也可注销，不运行会要求完整数据的 lint，不重建目录。
3. 对每个主/预留 Session 调用官方 resolveAgent，核对 ID、目录和 Runtime 归属。只有 session/not-found 可按实体已缺失处理；writer-held 或无法确认时拒绝，不 create 替代 Agent。
4. Runtime 持有可回退准入闸门；活动 turn、未结算审计、附着操作或数据 lease 拒绝注销。
5. ConfigEditor 原子移入退役快照，并只清理该 Bot 的默认目录/选择，保留其他 Bot 的选择。
6. 持久保存成功后移除业务 Runtime 状态，保留 Agent-owned 被动闸门。保存失败释放临时闸门；保存成功后调用者断连不撤销退役。

临时闸门持有期间的新原生输入不会开启数据事务。即使输入已 claim，也返回唯一原生 Inbox；不另建消息队列。Runtime 重载和 Host 重启都会按持久退役 ID 附着被动闸门，旧 Session 不成为普通、不受管理的业务会话。

这是受信任 Host 的生命周期约束，同权限插件/用户手改 profile 文件不属于安全沙箱。退役不等于 agent-runtime journal 恢复；遗留证据和 PAUSED 继续保留，需要专门协调恢复。活动列表对原生实体缺失/归档的主动诊断与管理面板仍在 TODO。

## 验收

- 43 项 Host 与 57 项真实 Agent Runtime、公开类型和 64 组 Bash 回归通过。覆盖缺失数据目录、另一 Bot 选择、revision、v1 读取、配置重置拒绝、活 turn 拒绝且不取消、保存失败释放闸门、原生并发输入、writer-held/目录冲突、失败预留、CLI 断连重试、重载与新身份防改绑。
- 四种实际安装通过：source、tarball、Git fixture、Web tarball；验证公开 schema 导出及包内 removal.js。实际 Session/Workspace Controller 验证工作区删除、注销保留数据/历史和重新导入的新主 Session。
- Chromium 使用实际安装的 tarball 和本地模型适配器，验证命令卡片、CLI、原生工作区删除后的显式注销、旧窗口阻止执行、SIGKILL 后重启仍 retired、原 ID 重试及重新 import。工作区删除通过测试夹具调用官方 Controller，不宣称已测试原生删除按钮。

证据：`/tmp/mbot-removal-suite.log`、`/tmp/mbot-plugin-install.51T35e`、`/tmp/mbot-gui-runtime.4hYeWm`。没有调用真实 DeepSeek API。
