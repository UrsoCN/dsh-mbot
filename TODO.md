# TODO：dsh-mbot 初步实现计划

> 依据 [`docs/design.md`](docs/design.md)（v0.2）。顺序：验证 DSH 行为 → 骨架与 `botctl` → `mbot run` 闭环 → Dreaming → 星型调度 → 无人值守。
> 每个里程碑有**验收**，没过不进下一步。估时按业余投入粗估。
> 已定：纯 Bash、`mbot` + `botctl` 双入口、数据仓库默认 `~/.mbot-ws`、Dreaming 单阶段。

## M0 · Spike：核实 DSH 行为

在临时 git 目录里手动跑，结论回填 `docs/design.md` §14.2。

- [x] 凭据：`DEEPSEEK_API_KEY` 放 `$DSH_HOME/.env`（默认 `~/.dsh/.env`），在 `/tmp` 隔离验证 cron 式空环境下 headless 能跑
- [x] `dsh --profile headless --json "列出当前目录" > run.jsonl`：事件类型、`final` 结构、有无 token 用量
- [x] `--permission-mode workspace-write --approval-policy never`：工作区内读写/bash 正常；越界写被拒的表现
- [x] 工作区根 `AGENTS.md`：顶层会话与 **fresh subagent** 是否都加载
- [x] 环境继承：bash 工具和子代理里能否看到 `mbot` 导出的 `PATH`、`MBOT_RUN_ID`
- [x] 沙箱内执行工作区外的脚本（模拟 `botctl`），并在 `.mbot/` 下 `flock`
- [x] 并行派 2 个 subagent：并发上限；depth=1 时 Worker 再调 `subagent` 的报错
- [x] `send_message` 给已完成的子代理能否恢复一轮
- [x] `--patch` 覆盖默认模型（Dreaming 用低成本模型）
- [x] 冷启动耗时与基线 token
- [x] 依赖：`jq`、`flock`、`git`、`dsh 0.2.2-rc.5` 本机可用

**验收**：§14.2 每项有结论（"不支持 → 改设计"也算）。

2026-11-25 已通过：`bash tests/m0-spike.sh all`，5 个真实 DSH 场景，0 个探针失败。结论与复现见 [`docs/m0-spike.md`](docs/m0-spike.md)；追加核实了显式开启 `interrupt_agent` 后的中断行为。

## M1 · 骨架、配置与 `botctl`

- [x] `git init`；`README.md`（定位 + 快速开始）、`LICENSE`、`.editorconfig`、`.gitignore`
- [x] `lib/config.sh`：工作区解析 `-C` → `MBOT_WS` → `~/.config/mbot/config` → `~/.mbot-ws`；交互终端首次询问并写配置，非交互直接报错；拒绝 `~/.dsh` 下及与框架仓库重叠的路径
- [x] `install.sh`：`bin/*` 软链到 `~/.local/bin`，可选写 `~/.config/mbot/config`
- [x] `templates/workspace/`：
  - [x] `AGENTS.md`：角色、写入归属、看板只能经 `botctl`、`botctl` 命令速查、禁止自行 `git commit` 与调用 `mbot`
  - [x] `MEMORY.md`、`bots/{chief,coder}/{SOUL.md,MEMORY.md}`、`BOARD.md`、`tasks/_template.md`、`wiki/_index.md`、`inbox/.gitkeep`
  - [x] `.mbot/config`（预算、超时、`MBOT_GRANTS`、dsh 路径）、`.gitignore`（`.env`、`.mbot/{runs,lock,botctl.lock,PAUSED,failures}`）
- [x] `mbot init [dir]`：校验 → 拷模板 → `git init` → `human: init`
- [x] `botctl`（`lib/board.sh`、`lib/lint.sh`）：
  - [x] `boot <bot> [--task id]`
  - [x] `board show|add|set`（id 分配、模板建任务单、`blocked` 必须 `--reason`）
  - [x] `task show|result`（只追加到「执行记录 / 结果」段）
  - [x] `remember "<事实>" [--as r] [--task id]` → `inbox/<date>.md`
  - [x] `lint`：MEMORY 行数/字符数（`wc -m`）、SOUL ≤5k、wiki ≤200 行、BOARD ≤80 行 + 表格式 + 状态枚举、`[[链接]]` 存在
  - [x] 变更类命令 `flock .mbot/botctl.lock`；`MBOT_RUN_ID` 已设时不提交，否则提交 `human: …`
- [x] `tests/run.sh`：对 `botctl` 各命令做断言（纯 bash，不引入 bats）

**验收**：`mbot init /tmp/ws` → `botctl -C /tmp/ws board add "试试"` 生成 `001` 与任务单并提交 → `board set 001 blocked` 无 `--reason` 被拒 → 把 MEMORY 写超后 `botctl lint` 报出文件与超限量。

2026-11-26 已通过：`bash tests/run.sh` 共 16 组离线集成检查（含八路并发、提交隔离/失败回滚、UTF-8 预算与链接边界）；另用真实 PTY 验证首次询问、保存带空格路径、缺失工作区不自动创建。使用方法见 [`README.md`](README.md)。

## M2 · 单次运行闭环 `mbot run`

- [x] 入口检查：`PAUSED` → 退出 0；`MBOT_RUN_ID` 已设 → 拒绝；`flock -n`；工作树干净；记录 `HEAD`
- [x] run-id；prompt = `botctl boot <bot> [--task]` + 边界声明 + `<request>`
- [x] 调用：导出 `MBOT_RUN_ID/MBOT_BOT/MBOT_WS/PATH` → `timeout $MBOT_TIMEOUT dsh --profile headless --json --permission-mode workspace-write --approval-policy never`；原始流存 `.mbot/runs/`（`--add-dir` 按 M4 实现）
- [x] `lib/render.sh`：NDJSON → `transcripts/<date>/<run-id>.md`（请求摘要、工具调用、最终回答、本次 `remember` 条目）+ `.meta.json`；脱敏
- [x] `lib/guard.sh`：归属表回滚、`inbox/` 只追加校验、BOARD lint 失败还原、HEAD 比对、违规写 meta
- [x] commit `run(<bot>): <run-id> <摘要>`；失败计数，连续 3 次自动 PAUSED
- [x] `mbot status`、`pause`、`resume`
- [x] `tests/fake-dsh` + 用例：正常改看板 → 提交；偷改 MEMORY → 回滚记违规；删 inbox 行 → 回滚；dsh 退出 1 → 计数 +1；并发两个 run → 第二个跳过；运行内调 `mbot run` → 拒绝

**验收**：真 dsh 跑 `mbot run chief "在看板上加一个任务：整理 README"` → Chief 通过 `botctl board add` 加行，transcript 可读，`git log` 一个干净 commit，MEMORY 未变。

2026-11-26 已通过：16 组基础 + 15 组运行检查；`bash tests/real-run.sh` 使用真实 DSH 生成 `001`，MEMORY 不变，无违规，数据仓库仅有初始化和一次 run 提交且工作树干净。实测与恢复行为见 [`docs/m2-run.md`](docs/m2-run.md)。

## M3 · Dreaming 与记忆闭环

- [ ] `prompts/dream.md`：Analyze（inbox 优先）→ Merge → Rewrite → Report；条目格式、`disputed` 规则
- [ ] `mbot dream`：找上一个 `dream:`（首次 `human: init`）→ 新增 `transcripts/ inbox/ tasks/archive/` 清单 → 按 `MBOT_DREAM_MAX_BYTES` 截断 → 调 dsh
- [ ] guard（dream）：只允许 `MEMORY.md`、`bots/*/MEMORY.md`、`wiki/**`、`dream-reports/**`
- [ ] 失败：lint 不过 / 有删除但报告无依据 → 回滚记忆改动，只提交报告 `dream(failed): …`
- [ ] fake-dsh 用例：正常 → `dream:`；超预算 → `dream(failed)`；偷改 BOARD → 回滚

**验收（记忆闭环）**：`mbot run chief "以后周报一律用中文，记住这条"` → Chief 调 `botctl remember`，MEMORY 不变 → `mbot dream` → 规则进 `MEMORY.md`，有 report 与 `dream:` commit → 下一次 `mbot run` 按规则行事 → `git revert` 后规则消失。

## M4 · 星型调度

- [ ] `bots/chief/SOUL.md`：拆解 → `board add` → 派活 prompt 模板（design §10.3）→ 纠偏/中断 → `board set`
- [ ] `bots/coder/SOUL.md`（+ 可选 `researcher`）：第一步 `botctl boot`，结果 `task result`，值得记的 `remember`
- [ ] `prompts/tick.md`：选一个 `todo` 或推进 `doing`；无事可做立即结束
- [ ] `mbot tick`；`mbot archive`（纯脚本，`chore(archive)`）
- [ ] `MBOT_GRANTS` → `--add-dir`（只接受存在的物理绝对路径）

**验收**：复杂需求 → Chief 拆成 ≥2 个任务、并行派 2 个 Worker → 结果落在各自任务单 → 看板状态正确 → 无越权记录；人为卡住一个 Worker，Chief 能 `interrupt_agent` 并标 `blocked`。

## M5 · 无人值守

- [ ] `cron/mbot.crontab.example`：`PATH`、每 2h `tick`、03:17 `archive && dream`；凭据走 `~/.dsh/.env`
- [ ] dream 成功后可选 `git push`
- [ ] 恢复演练脚本：临时目录 clone → `botctl lint` → 冷启动问答
- [ ] 观察 7 天，人工记在 `wiki/ops-log.md`

**验收**：7 天内 `MEMORY.md` 始终在预算内；每晚有 `dream:`/`dream(failed):` commit 与 report；无未处理越权；演练过一次 `git revert` 与 PAUSED。

## Backlog（v1+，按需）

- [ ] DSH 设置页配置数据目录：极小 Cordis 插件，只声明 `.volatile()` 的 `mbotWorkspace` 字段；`mbot` 读取为配置来源之一
- [ ] `mbot` skill（`~/.dsh/skills/mbot/SKILL.md`）：在任意项目的 DSH 会话里用 `botctl` 看板/派活
- [ ] `mbot chat`：`--session-id` 续接 Chief 顶层会话
- [ ] Worker 结果物理隔离（`tasks/<id>.result.md`）
- [ ] transcripts 按月归档、定期 `git gc`
- [ ] 私有评测集（50–100 条 query）→ 再决定要不要 FTS5/BM25
- [ ] 复活 `源` / `u` 为首批真实 Bot（见 memory-revival.md）
- [ ] 入口层：dsh-im（QQ/Telegram）或 tether 远程触发 `mbot run`
- [ ] 模式 B：`dsh web` 常驻时的 GUI 接入
