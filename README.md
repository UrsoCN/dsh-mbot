# dsh-mbot

DeepSeek Harness 的 Cordis 插件，以 Markdown/Git 管理任务和长期记忆，复用 Bash 核心完成受控运行、Chief/Worker 派活和独立 Dreaming。

当前版本为 **0.1.1**。能力与已知限制见 [发布说明](docs/RELEASE_NOTE.md)，下一轮见 [TODO](TODO.md)，架构见 [design](docs/design.md)，维护见 [AGENTS](AGENTS.md)。

已具备 Host 服务、原生 botctl、工作区 schema 和聊天区命令反馈。`/mbot init <目录>` 成功后自动保存插件的目录选择，后续 status/工具及重启使用该目录。**尚无自有设置面板、Bot 实例列表或持久主 Session**，这些功能列入 0.2.0。

dev 分支已推进实例登记：`/mbot list`、`/mbot import <目录>`、`/mbot select <botId 或名称>` 可用，插件 init 同时登记稳定 Bot 身份；这些变更尚未进入发布标签。登记和选择会按 profile 保存，DSH 工作区/主 Session 绑定仍待实现。详见 [实例登记](docs/bot-instances.md)。

dev 已实现 [turn 事务基础及数据恢复](docs/turn-transactions.md)，并通过 [原生 Agent Runtime](docs/native-runtime.md) 验证受管理上下文、工具、取消和审计。尚未自动创建用户主 Session；当前 /mbot run 仍使用独立 headless run，/mbot recover 只恢复数据桥的遗留 turn。

## 通过 DSH 安装

支持 Linux/WSL 的本地环境，Node.js 22+，实测 DSH 0.2.2-rc.5。需要 Bash 4.3+、Git、jq、flock、awk、GNU coreutils 和 C.UTF-8；先配置 Git 姓名/邮箱。框架不安装系统依赖。

源码目录安装：

```bash
npm ci --ignore-scripts
dsh plugin --profile web add "$PWD"
```

完整包安装：

```bash
npm pack --pack-destination /tmp
dsh plugin --profile web add /tmp/dsh-mbot-0.1.1.tgz
```

web 可换成 headless。包包含 ESM/类型、脚本、模板、prompts/patches 和运维资源，无安装时构建；已有进程按 HMR 能力生效或重启 DSH。Git 安装可使用 github:UrsoCN/dsh-mbot#<tag-or-commit>，以远端实际可见版本为准。

推荐完整版本 tag（如 v0.1.0 对应包版本 0.1.0）。GitHub Release/Actions 不是安装必需项，分支也不等于 tag；规范检查、CI 与发布建议见 [发布检查](docs/plugin-standard-review.md)。

卸载用 dsh plugin --profile web remove dsh-mbot；独立数据仓库保留。安装提供 profile 的 node_modules/.bin/mbot 和 botctl，但不修改全局 PATH、不初始化数据或部署 cron。

## 快速开始

安装后，在 DSH 聊天框执行：

```text
/mbot init /tmp/mbot-demo
/mbot status
```

结果使用原生命令卡片显示，点击可展开完整输出；不触发模型调用或进入模型 role content。init 保存对应 profile 的 MBot workspace；失败保留此前选择，若仓库已建成但配置保存失败，卡片会明确提示。数据目录不会自动成为 DSH 工作区，也不会创建主 Session。

在源码目录也可以使用终端入口：

```bash
./bin/mbot init /tmp/mbot-demo
./bin/botctl -C /tmp/mbot-demo board add "整理 README" --owner coder
./bin/botctl -C /tmp/mbot-demo board set 001 doing
./bin/botctl -C /tmp/mbot-demo board set 001 done
./bin/botctl -C /tmp/mbot-demo remember "周报使用中文" --as chief --task 001
./bin/botctl -C /tmp/mbot-demo lint
./bin/mbot -C /tmp/mbot-demo status
```

init 接受不存在/空目录，创建模板与 human: init；不会覆盖已有数据，当前也不会登记 DSH 工作区或创建主 Session。后续用同一 -C 目录。长期使用可执行 bash install.sh --workspace ~/.mbot-ws，将入口安装到 ~/.local/bin 并保存用户目录配置。

## 工作区与配置

Bash 目录优先级为 -C → MBOT_WS → XDG_CONFIG_HOME 下的 mbot/config → ~/.mbot-ws。用户配置只写 MBOT_WS=/absolute/path。静态 KEY=value，不执行 shell/插值；环境优先于数据仓库 .mbot/config。拒绝与框架/DSH_HOME 重叠、嵌套 Git、危险托管软链。

原生工具和 /mbot 的非空 Cordis workspace 优先，留空回退上述来源。0.1 没有自有设置面板，可在对应 profile 的 cordis.patch.yml 中设置：

```yaml
- id: mbot
  config:
    workspace: /absolute/path/to/bot-workspace
```

Host 字段为 volatile，后续操作读取新值，在途操作保留原目录。插件 init 通过官方 ConfigEditor 保存实际目录，并串行处理并发初始化；期间的配置修改不会被静默覆盖。独立 Bash CLI 不读取 profile YAML，CLI init 仍仅初始化数据。

| 配置 | 默认值 |
|---|---:|
| MBOT_MEMORY_MAX_LINES / MBOT_MEMORY_MAX_CHARS | 150 / 3000 |
| MBOT_SOUL_MAX_CHARS / MBOT_WIKI_MAX_LINES / MBOT_BOARD_MAX_LINES | 5000 / 200 / 80 |
| MBOT_TIMEOUT / MBOT_DREAM_MAX_BYTES | 300 秒 / 64000 字节 |
| MBOT_DSH / MBOT_GRANTS | dsh / 空 |
| MBOT_PUSH_AFTER_DREAM / MBOT_PUSH_TIMEOUT | 0（关闭）/ 30 秒 |

凭据放被忽略的 DSH_HOME/.env（默认 ~/.dsh/.env），不放 crontab 或命令参数。GUI 登录不代替 headless 的 key 配置。

## botctl 与 /mbot

| botctl 操作 | 行为 |
|---|---|
| boot <role> [--task id] | 读取 SOUL、共享/私有 MEMORY、看板和任务 |
| board show/add/set | 查看、建任务、改状态；blocked 必须 --reason |
| task show/result | 读任务、从 stdin 追加结果，支持 --as |
| remember "fact" [--as role] [--task id] | 只追加候选到 inbox |
| lint | 检查 UTF-8 预算、任务/看板一致性和链接 |

全部支持前置 -C。任务 ID 包括归档且不复用；人类操作形成 human commit，MBOT_RUN_ID 下只改文件，由 Host 统一验收。目标脏、预算/提交失败会拒绝或恢复。详见 botctl --help。

模型的原生 botctl 操作包括 boot、status、lint、board_show/add/set、task_show/result、remember。它管理 Host 配置的数据仓库，需要完整权限或一次 DSH 审批；不能写 MEMORY 或启动另一个模型。受控 Chief/Worker 继续使用 Bash botctl 与运行 guard。

人类 /mbot 支持 init、status、lint、board、run、tick、archive、dream、pause、resume、help；dev 另有 list/import/select/recover。控制输入按原文处理，不按 shell 解析；只有需要执行任务/整理记忆的 run/tick/dream 调模型。运行、成功、错误、跳过与取消通过命令事件展示，不默认加入模型 role content。

## 单次运行与恢复

```bash
mbot -C /tmp/mbot-demo run chief "请推进看板上的任务"
mbot -C /tmp/mbot-demo status
mbot -C /tmp/mbot-demo pause "等待人工检查"
mbot -C /tmp/mbot-demo resume
```

每次 run 是新的 headless 会话，使用 workspace-write/never、超时、全局锁和干净基准。Host 恢复越权/非追加写入、检查看板，保存脱敏 transcript/meta 并提交；失败保留审计，三次熔断，HEAD/控制路径异常立即暂停。原始日志在忽略的 .mbot/runs 中，保留私有权限。详情见 [设计](docs/design.md#61-受控运行)、[M2](docs/m2-run.md)。

0.1 不把数据目录自动变成 DSH 原生工作区，也不绑定持久主 Session。每实例的 Chief 主会话、创建/导入/修复与导航列在 [P1](TODO.md)；会话历史不会代替 Markdown/Git 记忆。

dev 的 managed turn 若中断，journal 和私有快照会保留。用 `/mbot recover`（或 Host 已停止时的 `mbot -C <目录> recover`）核实写者并恢复审计，检查 status 后显式 resume；未确定写者/快照或提交身份时拒绝恢复。此命令不恢复旧 headless run，也尚未覆盖真实 Agent/Worker 或睡眠 checkpoint。

下一版主 Session 将由插件组合人格、记忆与近期上下文，直接交互与 IM/Bot 消息共用 Runtime 准入，并统一 compact/睡眠；botctl 是门面，DSH 负责日志/执行。多窗口和隔离对话域设计见 [Session Runtime](docs/session-runtime.md)，当前尚未实现。

## Dreaming 记忆闭环

```bash
mbot -C /tmp/mbot-demo run chief "以后周报一律用中文，记住这条"
mbot -C /tmp/mbot-demo dream
```

工作 Bot 投递候选，独立 Dreaming 整理 MEMORY/wiki 并写报告；输入按完整行限制，checkpoint/pending 支持续读，失败不推进。预算、链接、删除依据或模型失败回滚记忆，只提交失败报告；成功提交 dream，可用 git revert 恢复记忆/checkpoint。详情见 [M3](docs/m3-dream.md)。

## 星型调度、tick 与归档

Chief 写持久派活说明，最多并行两个 fresh Worker；Worker 先 boot、再写自己结果。纠偏/中断后由 Chief 验收或标 blocked。跨次运行只依赖任务，看板 doing 优先；无 todo/doing 的 tick 不调模型。archive 原样归档 done 并提交，冲突/提交失败回滚。见 [M4](docs/m4-schedule.md)。

MBOT_GRANTS 按冒号列出存在的物理绝对目录，可含空格；拒绝保护目录、别名、空项和重复。run/tick 逐项传 add-dir，dream 不继承。外部项目的提交/合并由人类处理。

## 无人值守

[cron 示例](cron/mbot.crontab.example) 每两小时 tick，03:17 archive 成功后接 dream；部署前调整绝对路径和 PATH，框架不自动安装。ops/cron-run.sh 记录私有独立日志，目录在数据仓库/框架/DSH_HOME 外。

备份默认关闭；开启后成功 dream 推既有 upstream，目的地变更、拒绝、超时保留本地提交。ops/recover.sh 克隆到 /tmp 后清空 grants/推送，lint 与只读冷启动验证；ops/observe.sh 由人类提交预算、状态、报告与备注。**7 天连续观察尚未完成**，见 [M5](docs/m5-ops.md)。

## 验证与维护

```bash
npm test
npm run test:install
npm run test:real-plugin
```

dev 当前有公开类型、33 项既有 Cordis、9 项真实 Agent Runtime 和 64 组 Bash 检查；安装检查覆盖源码链接、tarball 和无开发依赖的 Git fixture，验证 Host 激活、原生 Agent/工具、turn/恢复、命令/schema/bin/展示元数据及卸载。Runtime 验证用本地 scripted adapter；real-plugin 使用已授权 key 验证原生工具与包内 Dreaming，产物隔离在 /tmp。更早的真实运行、记忆、调度和运维脚本在 tests/real-*.sh。

`npm run test:gui` 使用 Playwright/Chromium，在隔离 profile 安装 tarball，验证真实聊天区、目录保存、多标签页、刷新/重启及不调用模型。Playwright 和浏览器可安装在 /tmp，通过 MBOT_PLAYWRIGHT_MODULE、PLAYWRIGHT_BROWSERS_PATH 指定。设置页和主 Session 仍需各自验收。详见 [发布说明](docs/RELEASE_NOTE.md)、[插件历史验收](docs/plugin.md)、[维护约定](AGENTS.md)。

## 许可证

[MIT](LICENSE)
