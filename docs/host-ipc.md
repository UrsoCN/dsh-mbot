# dev：botctl 本地宿主入口

2026-11-27。`botctl` 的外部入口已接入 [所有者消息准入](message-admission.md)，复用 Bot 的实际主 Session、原生 Inbox 与 Runtime。这里提供本地所有者 CLI；IM、独立 Bot 通信、隔离对话域、审计终态/回复 outbox 和睡眠仍在 [TODO](../TODO.md)。包仍为 0.1.1，属于未发布的 dev。

## 使用

安装 dev 插件并启动对应的 `dsh --profile web`，在聊天区用 `/mbot init <目录>` 或 import/repair 建立 ready 的 Bot 主 Session。随后另开终端：

```bash
botctl bots --profile web
botctl talk --profile web --bot 'bot-实际ID' --request-id 'manual-001' --text '整理今天的任务'
botctl receipt --profile web --bot 'bot-实际ID' --request-id 'manual-001'
botctl runtime --profile web --bot 'bot-实际ID'
botctl stop --profile web --bot 'bot-实际ID'
```

源码可用 `./bin/botctl`；安装后的 bin 在 profile 的 node_modules/.bin 下。框架不修改全局 PATH。`--bot` 可接受登记名称，稳定脚本建议用 bots 返回的 botId。`--profile` 必须显式指定，并使用与宿主相同的 DSH_HOME。支持中文 profile 名和符号链接指向的同一 profile。

多行 UTF-8 文本用 stdin：

```bash
printf '第一行\n第二行\n' | botctl talk --profile web --bot 'bot-实际ID' --request-id 'manual-002' --stdin
```

talk 支持可选 `--correlation-id`；必须提供 request-id，且 `--text`/`--stdin` 二选一。正文保留原字节对应的 UTF-8 文本，不按 shell 解析；stdin 上限 262144 字节，非法 UTF-8 拒绝。重复发送同 ID/同正文复用 MessageId；更改正文/关联 ID 后应使用新 ID。

Host 命令不使用 `-C`，也不读取旧的默认数据目录来选择另一 Bot。已有 boot/board/task/remember/lint 和 `-C` 的 Bash 数据入口保持兼容。外部 Host CLI 不依赖 Node 包安装时编译；其客户端只使用 Node 内置模块。

基础 headless profile 可以查询 bots；没有 ready 的原生主 Session/Controller 时 talk 明确拒绝，不创建替代会话或启动独立 headless 模型。宿主未运行/插件关闭时明确返回 unavailable。运行内的 MBOT_RUN_ID/DSH_MBOT_* 身份禁止使用本地所有者命令；结构化数据工具继续使用当前 lease，peer 以后使用自己的来源通道。

## 收据与退出状态

stdout 是 JSON，包含 schemaVersion、transportId、profileId、instanceId、ok 和 value/error。transportId 只关联一次连接，requestId 才是业务重试身份。

| 退出码 | 含义 |
|---|---|
| 0 | 操作得到确认；talk 只表示准入/持久化成功 |
| 1 | 宿主不可用，或操作明确拒绝 |
| 2 | CLI 参数/输入错误或试图从 managed run 调所有者入口 |
| 3 | 传输/持久确认不确定；talk 用原 requestId 查回/重试 |

`value.confirmation` 和 `value.delivery` 沿用消息准入的两个维度。queued/claimed/ended/cancelled 不等同于 guard/Git 提交成功，查询 runtime 看事务结果；缺失 requestId 查询返回 null。当前不会等待完整模型回答、输出聊天流或向 IM 投递结果。

连接默认等待 15 秒。关闭终端、超时或断连仅结束观察，不取消已转交的输入。不会自动重连重发，更不会为了得到回执创建另一个 Agent。stop 通过专用控制通道等待捕获回合的原生工具/审计，并保留待办；传输不确定时先查询状态，重复 stop 可能捕获后来的回合，不能当成同一次取消的重试。

同 ID 重试确认失败后归还 Inbox 的输入，不合成唤醒消息；仍由下一条新 followup 恢复 FIFO。可靠的独立 wake/睡眠恢复继续在 TODO。

## Cordis 与端点归属

bundle 新增 `dsh-mbot/ipc`，提供 `ctx.mbotIpc.status()` 与 Config。默认按官方 profileContext.dir 的 canonical 路径和当前 UID 生成短 `/tmp/dsh-mbot-<uid>-<hash>` 目录，避免 Unix socket 路径长度限制，不扫描或修改 profile 配置文件。不同 profile/DSH_HOME 得到不同端点。

目录必须为本用户所有且权限 0700，socket/锁/归属记录为 0600；符号链接、其他文件类型及宽权限拒绝，不把已有不安全目录静默 chmod 成安全目录。socket 使用本地文件权限作为所有者访问边界，没有 TCP 监听或额外明文 token。相同 UID 的进程属于同一可信本地用户，此能力不宣称为抵御恶意同权限插件或进程的沙箱。

Config 可关闭入口或显式配置短目录：

```yaml
- id: mbot-ipc
  config:
    enabled: true
    directory: /tmp/my-private-mbot-ipc
```

显式目录使用 `--endpoint-dir /tmp/my-private-mbot-ipc`，与 `--profile` 二选一。配置 enabled=false 或关闭该 Cordis 行会清理监听；其他 Web/Runtime 和数据 CLI 能力保留。无 profileContext 的自定义 Host 需配置目录，否则状态 unavailable。

同一端点由 flock 选出一个 Host；另一 Host 的 IPC 状态是 busy，不能删除活端点或创建第二个消费队列。旧 Host 关闭/异常退出后，新启动或重载的 Host 可接管。ready 主 Session 仍由官方 Controller resolve，另一 Agent writer 占用时报告错误，不回退 create。

端点的 owner.json 原子保存 schemaVersion、PID 出生身份、instanceId 和 profileId，不记录对话。仅锁进程退出不能证明宿主静止：若原 PID/出生身份仍存活，后继 Host 仍须等待。监听锁意外丢失会停止准入；正常关闭先停止监听、断开观察者、join 所有已转交操作，再移除自己的归属记录并释放 flock。锁文件保留 inode，避免两把 flock 保护不同文件。只有已证明原 Host 不再存活且取得 flock 时，才回收符合类型/所有者/权限的遗留 socket。

原生 Session log 继续保存消息，IPC 不复制队列。重启后去重由 Runtime 的原生日志投影恢复；agent-runtime journal 的完整恢复仍未交付，不能删除 journal 或改 scope 绕过。

## 验证

真实 Agent/CLI 验收覆盖多行中文、字面 shell 字符、请求重试/冲突、来源篡改、权限/路径、连接超时、断连、卸载 drain、锁进程丢失、第二 Host、原生停止及 profile 隔离。类型和既有 Host/Bash 回归继续保留。

source/tarball/Git 基础安装与 Web tarball 安装覆盖实际 bin/资源/端点；基础 Host 不产生非受管理模型会话。Chromium 在安装后的 Web profile 验证 CLI 消息出现在主会话、原生审计、CLI stop/待办保留以及 SIGKILL 重启后同 MessageId 查回、无重复模型调用。使用本地 scripted adapter，没有调用真实 DeepSeek API。

复跑 `npm test`、`npm run test:install`、`npm run test:gui-runtime`；浏览器命令需指定临时 Playwright/Chromium 路径。具体本阶段证据见发布说明。
