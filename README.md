# dsh-mbot

DeepSeek Harness 的 Cordis 插件，以 Markdown/Git 管理任务和长期记忆，提供受管理主 Session、Chief/Worker 派活、独立 Dreaming 和可恢复的运行事务。

当前版本 **0.2.0-rc.1**，对应标签 `v0.2.0-rc.1`（2026-11-28）。Bot 实例、主 Session、持久恢复、上下文 checkpoint、自动/手动摘要、sleep/wake 和最小管理面板均已发布。隔离对话域、IM/peer/outbox、Worker Bash/文件/PTC 写工具、完整配置编辑及至少 7 天真实调度观察仍未完成。

| 文档 | 内容 |
|---|---|
| [DESIGN](DESIGN.md) | 当前架构、能力边界和后续规划大纲 |
| [TODO](TODO.md) | 未完成的执行事项与验收出口 |
| [PLUGIN](PLUGIN.md) | 插件结构、安装、兼容与验证 |
| [RELEASE_NOTE](RELEASE_NOTE.md) | 按版本归并的交付与验证记录 |
| [模块文档](docs/README.md) | 数据、Runtime、恢复和运维的详细契约 |
| [AGENTS](AGENTS.md) | 框架维护约定 |

## 安装

支持 Linux/WSL 本地环境，Node.js 24.9+；当前实测 DSH `0.2.2-rc.5`。需要 Bash 4.3+、Git、jq、flock、awk、GNU coreutils 和 C.UTF-8，先配置 Git 姓名/邮箱。

```bash
# 源码目录安装
npm ci --ignore-scripts
dsh plugin --profile web add "$PWD"

# 或安装完整包
npm pack --pack-destination /tmp
dsh plugin --profile web add /tmp/dsh-mbot-0.2.0-rc.1.tgz
```

也可按远端可见的版本安装 `github:UrsoCN/dsh-mbot#v0.2.0-rc.1`。包包含 JS/类型、双 CLI、模板与运行资源，无安装时构建。卸载使用 `dsh plugin --profile web remove dsh-mbot`，独立数据仓库保留；安装不修改全局 PATH、不初始化数据或部署 cron。详情见 [PLUGIN](PLUGIN.md)。

## 创建 Bot 并对话

安装后在 DSH 聊天框执行：

```text
/mbot init /tmp/mbot-demo
/mbot list
/mbot overview
```

Web profile 的 `init` 创建独立 Git 数据、登记 Bot 和原生 DSH 工作区、绑定并打开受管理主 Session。创建不调用模型，命令结果保存在发起会话的卡片中；直接在主 Session 发消息才开始业务回合。已有数据使用 `/mbot import <目录>`，绑定失败使用 `/mbot repair <Bot>`，打开已有会话使用 `/mbot open <Bot>`。

每个 Bot 有稳定身份、独立数据和一个默认私人主 Session，多窗口共用。`chief`、`coder` 是实例内角色。基础 headless profile 缺少 Controller 时只登记数据身份；独立 `mbot init` 只初始化 Git 数据。详见 [实例登记](docs/bot-instances.md) 与 [主 Session](docs/main-session.md)。

## 命令与数据工具

| 入口 | 常用操作 |
|---|---|
| `/mbot` 人类控制 | `init/import/list/select/open/repair/remove/removed`；`status/runtime/stop/recover`；`compact/sleep/wake/overview`；`lint/board/run/tick/archive/dream/pause/resume` |
| 原生 `botctl` 模型工具 | `boot/status/lint`、`board_show/add/set`、`task_show/result`、`remember`；Chief 另有 `worker_spawn/wait/message/stop` |
| `botctl -C <数据目录>` | 独立 Bash 数据操作，任务/结果/候选通过受控事务修改 |
| `botctl --profile …` | 连接已运行 Host 的 `talk/receipt/runtime/stop/bots/recover/remove/removed/compact/sleep/wake/overview` |
| `mbot -C <数据目录>` | 独立 headless 的 `run/tick/dream` 和数据管理；每次运行新建会话 |

模型工具固定使用 Host 选择或本轮绑定的数据目录，权限由原生 sandbox/approval 和数据许可共同检查。主 Session 的原生 Worker 默认开启，仅支持 scoped `botctl`，最多并行两个、深度 1；Bash/文件/PTC 写工具仍在规划。独立 headless Worker 沿用已有 grants 契约，详见 [原生 Worker](docs/native-workers.md) 与 [headless 工作流](docs/headless.md)。

```bash
./bin/mbot init /tmp/mbot-cli-demo
./bin/botctl -C /tmp/mbot-cli-demo board add "整理 README" --owner coder
./bin/botctl -C /tmp/mbot-cli-demo board set 001 doing
./bin/botctl -C /tmp/mbot-cli-demo board set 001 done
./bin/botctl -C /tmp/mbot-cli-demo remember "周报使用中文" --as chief --task 001
./bin/botctl -C /tmp/mbot-cli-demo lint
```

任务 ID 包括归档且不复用，`blocked` 必须附原因。人类数据操作形成 `human` 提交；运行内工具持当前 lease，由 Host 统一验收和提交。控制结果默认不进入模型 role content。

## 配置与管理面板

DSH Plugins 页面已有最小 MBot 面板：查看活跃/退役 Bot、目录、角色、绑定状态和 Runtime 参数，打开主 Session。`/mbot overview` 或 `botctl overview --profile web` 提供运行状态、预算和带来源标注的只读 `effectiveConfig`；凭据只返回引用或掩码。完整配置编辑与跨层并发保存仍待交付，见 [睡眠与管理面板](docs/sleep-wake.md)。

Host 操作按显式 Bot → 调用 Session 的持久绑定 → profile 当前选择 → 旧 `workspace` 路由，在途操作固定原身份。配置保存走官方 ConfigEditor；升级保留角色、记忆、历史及旧 Session 归属。

独立 Bash 的目录优先级为 `-C` → `MBOT_WS` → XDG 用户配置 → `~/.mbot-ws`。长期使用可执行 `bash install.sh --workspace ~/.mbot-ws`，安装入口到 `~/.local/bin`。`.mbot/config` 使用静态 `KEY=value`，不执行 shell/插值，环境优先；独立 CLI 不读取 DSH profile YAML。

| 数据配置 | 默认值 |
|---|---:|
| `MBOT_MEMORY_MAX_LINES` / `MBOT_MEMORY_MAX_CHARS` | 150 / 3000 |
| `MBOT_SOUL_MAX_CHARS` / `MBOT_WIKI_MAX_LINES` / `MBOT_BOARD_MAX_LINES` | 5000 / 200 / 80 |
| `MBOT_TIMEOUT` / `MBOT_DREAM_MAX_BYTES` | 300 秒 / 64000 字节 |
| `MBOT_DSH` / `MBOT_GRANTS` | dsh / 空 |
| `MBOT_PUSH_AFTER_DREAM` / `MBOT_PUSH_TIMEOUT` | 0（关闭）/ 30 秒 |

凭据放被忽略的 `DSH_HOME/.env`（默认 `~/.dsh/.env`），不放 crontab 或命令参数。GUI 登录不代替 headless 的 key 配置。

## 运行、维护与恢复

主 Session 每轮在模型提示组装前取得 lease，固定人格/记忆与来源快照；前台工具和 Worker 静止后，Host 执行 guard、脱敏审计、Git 提交及原生 Session flush。聊天区卡片显示验收结果；`/mbot runtime` 查询状态，`/mbot stop` 停止捕获回合、保留后续 Inbox 并等待收尾。干净用户停止保留原故障计数，违规/执行错误仍计失败。

`/compact`、`/mbot compact` 与 `botctl compact` 经过统一维护屏障、Bot 数据锁和持久 journal。`/mbot sleep` 执行 cutoff → 独立 Dreaming → 可选 compact/checkpoint → 持久睡眠；睡眠继续收信并跨重启保留，`/mbot wake` 使用原主 Session。详见 [摘要](docs/managed-compaction.md)、[sleep/wake](docs/sleep-wake.md)。

中断后使用 `/mbot recover [Bot]` 或 `botctl recover --profile web --bot <稳定ID>`。恢复核验原生写者、工作树外私有快照、PID/`boot_id`、Git 和 journal，不调用模型或自动 resume；检查结果后显式恢复运行。当前覆盖已支持的前台契约、scoped Worker v3 和维护中断；未知写者、非只读旧契约及缺失原生日志仍拒绝。独立 `mbot -C <目录> recover` 仅处理 `data-subprocesses`，详见 [恢复边界](docs/runtime-recovery.md)。

所有者本地终端可向同一主 Session 投递并查回已审计回答：

```bash
botctl bots --profile web
botctl talk --profile web --bot <Bot-ID> --request-id manual-001 --text '整理今天的任务'
botctl receipt --profile web --bot <Bot-ID> --request-id manual-001 --wait
```

同 ID 重试复用原消息；断连只结束等待。`confirmed/ended` 与 Git 事务成功是不同状态，回复查询联合核验原生/Git/journal。详见 [本地 IPC](docs/host-ipc.md) 和 [请求结果](docs/request-replies.md)。IM 投递/ack 和独立 Bot 通信尚未开放。

注销使用 `/mbot remove <Bot>`，`/mbot removed` 查看退役身份。注销保留数据、日志、Inbox 和恢复证据，旧 Session 继续受闸门保护；重新 import 同一目录创建新身份。旧只读回合可先用 `botctl -C <目录> migrate-readonly --check` 核验，见 [Bot 退役](docs/bot-removal.md) 与 [旧回合迁移](docs/legacy-migration.md)。

## Dreaming、调度与运维

工作 Bot 只读长期记忆，`remember` 追加候选；独立 Dreaming 整理 MEMORY/wiki，按完整行预算续读，失败回滚记忆且不推进进度。成功报告与记忆同一次提交，可用 `git revert` 回滚，详见 [记忆模块](docs/memory.md)。

独立 `run/tick` 由 Chief 先写任务再派 fresh Worker，`tick` 优先 doing、空闲不调模型，`archive` 原样归档 done。`MBOT_GRANTS` 只对 run/tick 授予物理绝对目录，Dreaming 不继承；外部项目提交/合并由人类处理，详见 [headless 工作流](docs/headless.md)。

[cron 示例](cron/mbot.crontab.example) 每两小时 tick，03:17 归档成功后 dream；框架不自动部署。备份默认关闭，开启后只推既有 upstream。`ops/recover.sh` 做 clone 冷启动，`ops/observe.sh` 由人类记录预算、报告与异常。**至少 7 天连续观察尚未完成**，见 [运维模块](docs/operations.md)。

## 验证与维护

```bash
npm test
npm run test:install
npm run bench:runtime
```

默认回归使用隔离数据与本地 scripted adapter，Host/Runtime 文件串行执行；安装覆盖源码链接、tarball、Git fixture 与 Web tarball。仓库 CI 在 Node 24.9.0 和 24 系列分别执行回归与安装矩阵，DSH 固定为 0.2.2-rc.5。真实模型、GUI 和长跑按需另验，不能由类型/schema 检查替代。浏览器与恢复的全进程核验不要并行，复跑命令及环境见 [PLUGIN](PLUGIN.md)。

规划新增和范围调整先更新 [DESIGN](DESIGN.md)，可执行事项列入 [TODO](TODO.md)，交付后归入 [RELEASE_NOTE](RELEASE_NOTE.md)。模块契约见 [文档索引](docs/README.md)，早期验收合并保存在 [历史档案](docs/archive/0.1-acceptance.md)。

## 许可证

[MIT](LICENSE)
