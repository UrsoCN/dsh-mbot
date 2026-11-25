# dsh-mbot

基于 DeepSeek Harness（DSH）的最小 Bot 系统：纯 Bash 编排，Markdown 保存任务与记忆，Git 保存审计与回滚点。框架仓库与数据仓库分开；Chief 管看板，Worker 执行任务，Dreaming 整理长期记忆。

当前完成 **M0、M1**：工作区初始化、配置、角色模板和 `botctl` 已可用。`mbot run`、Dreaming 和定时调度按 [TODO](TODO.md) 的后续里程碑实现。完整边界见 [设计稿](docs/design.md)。

## 快速开始

需要 Bash 4.3+、Git、`flock`、`awk`、GNU coreutils（含 `realpath/readlink`），以及 `C.UTF-8` locale。后续真实运行还需要 `jq` 和 DSH（已验证 `0.2.2-rc.5`）。先配置 Git 的用户姓名和邮箱。

在当前仓库直接体验，无需安装：

```bash
./bin/mbot init /tmp/mbot-demo
./bin/botctl -C /tmp/mbot-demo board add "整理 README" --owner coder
./bin/botctl -C /tmp/mbot-demo boot coder --task 001
./bin/botctl -C /tmp/mbot-demo board set 001 doing
printf '%s\n' 'README 已整理；检查链接通过。' |
  ./bin/botctl -C /tmp/mbot-demo task result 001 --as coder
./bin/botctl -C /tmp/mbot-demo board set 001 done
./bin/botctl -C /tmp/mbot-demo remember "周报使用中文" --as chief --task 001
./bin/botctl -C /tmp/mbot-demo lint
git -C /tmp/mbot-demo log --oneline
```

`init` 接受不存在或空目录，生成模板及 `human: init` 提交；不会覆盖已有数据。`board add` 输出任务 ID，同时创建任务单。`blocked` 必须给出 `--reason`。`remember` 只追加候选到 inbox，不直接更新 MEMORY。

长期使用时安装入口并选择独立数据目录：

```bash
bash install.sh --workspace ~/.mbot-ws
export PATH="$HOME/.local/bin:$PATH"
mbot init ~/.mbot-ws
botctl board show
```

安装创建到当前框架 `bin/` 的软链；框架目录需要保留。`--bin-dir <dir>` 可选择其他安装位置；已有其他程序或软链同名时拒绝覆盖。生产工具应放在普通的工作区外目录，DSH 的临时区可写。

## 工作区与配置

选择顺序：`-C <dir>` → `MBOT_WS` 环境变量 → `${XDG_CONFIG_HOME:-~/.config}/mbot/config` → `~/.mbot-ws`。配置文件只有一行即可：

```text
MBOT_WS=/absolute/path/to/workspace
```

路径可含空格，可使用成对单/双引号包裹。配置按静态 `KEY=value` 读取：不执行 shell，不展开变量或命令替换，不支持行尾注释。空路径、DSH_HOME 内的路径、与框架重叠的路径均被拒绝；初始化也拒绝嵌套 Git 仓库。已存在的路径别名先解析到物理路径。

工作区缺失时，普通非交互命令直接报错；交互终端会询问路径、保存用户配置并提示执行 `mbot init`。这个流程不会自动创建数据。`init` 是显式创建入口。

数据仓库的 `.mbot/config` 保存预算，环境变量优先于文件中的值：

| 配置 | 默认值 |
|---|---:|
| `MBOT_MEMORY_MAX_LINES` | 150 |
| `MBOT_MEMORY_MAX_CHARS` | 3000 |
| `MBOT_SOUL_MAX_CHARS` | 5000 |
| `MBOT_WIKI_MAX_LINES` | 200 |
| `MBOT_BOARD_MAX_LINES` | 80 |
| `MBOT_TIMEOUT` | 300 秒 |
| `MBOT_DREAM_MAX_BYTES` | 64000 |
| `MBOT_GRANTS` | 空 |
| `MBOT_DSH` | dsh |

运行相关配置将在后续 `mbot run/dream/tick` 阶段使用。密钥放在被 Git 忽略的 `.env` 中，真实无人值守运行使用 `$DSH_HOME/.env`。

## botctl

所有命令支持前置 `-C <dir>`；其他参数见 `botctl --help` 和工作区 `AGENTS.md`。

| 命令 | 行为 |
|---|---|
| `boot <bot> [--task id]` | 输出 SOUL、共享/私有 MEMORY、看板前 30 行、任务 |
| `board show [--status state]` | 显示或按状态过滤看板 |
| `board add "summary" [--owner bot]` | 分配 ID、创建任务、追加 todo；默认 owner 为 chief |
| `board set id state [--owner bot] [--reason text]` | 同步看板与任务状态；blocked 原因追加到任务记录 |
| `task show id` | 显示任务单 |
| `task result id [--as bot] < text` | 在最后的执行记录段追加时间、作者和结果 |
| `remember "fact" [--as bot] [--task id]` | 追加可追溯的记忆候选 |
| `lint` | 检查预算、看板结构/状态/重复 ID、任务一致性与链接 |

角色名对应 `bots/<name>`；人类作者为 `human`。摘要、候选事实和 blocked 原因须为单行。任务结果支持多行，并使用 Markdown 引用保存，避免其中的标题改变任务结构。任务 ID 从 `001` 开始，归档后的任务也参与分配，避免复用。

命令共用 `.mbot/botctl.lock`。人类修改成功后只提交本次目标文件，保留其他暂存；目标已有未提交改动时先报错。命令或提交失败会恢复本次涉及的文件。`MBOT_RUN_ID` 已设时，所有 Bot 变更只改文件，由后续宿主统一验收提交。

`lint` 用 UTF-8 字符数约束 MEMORY/SOUL，实际行数约束 MEMORY/wiki/BOARD，报出文件及超限量。`[[wiki/file.md]]` 链接以工作区根为基准，支持 `#anchor` 和 `|label`，检查目标文件存在且未越界；不检查段落锚点。历史 transcripts 和 dream-reports 是原始材料，不参与该链接检查。托管文件及目录不允许软链。

## 验证

```bash
bash tests/run.sh
```

16 组离线集成检查涵盖命令、配置优先级、初始化、并发、提交隔离与回滚、归档 ID、预算及路径/链接边界。测试只在 `/tmp` 生成数据与用户配置，不调用模型，不使用密钥，不修改 HOME。

DSH 行为探针会调用真实 API；复现见 [M0 实测记录](docs/m0-spike.md)。

## 许可证

[MIT](LICENSE)
