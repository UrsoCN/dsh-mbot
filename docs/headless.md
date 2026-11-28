# 独立 headless 工作流

当前基线 `0.2.0-rc.1`。本模块说明 Bash `run/tick/archive` 和任务工具；受管理主 Session 的执行与恢复见 [原生 Runtime](native-runtime.md)。两种入口保留各自契约，独立运行不会创建或替代主 Session。

## 数据工具

`mbot init` 在不存在/空目录生成独立 Git 数据与初始化提交。`botctl boot <role> [--task id]` 输出 SOUL、共享/角色 MEMORY、看板和指定任务；`board show/add/set` 管任务，`task show/result` 读写任务结果，`remember` 追加候选，`lint` 检查预算和链接。

任务状态为 todo/doing/blocked/done，blocked 必须附原因；ID 包括归档且不复用。Chief 先写目标、输入、文件范围和验收再标 doing，Worker 只追加分配任务的结果。人类操作在数据仓库形成 human commit，运行内携带 `MBOT_RUN_ID` 的操作由父 Host 统一提交；目标脏、锁忙或提交失败时拒绝/恢复。

```bash
mbot init /tmp/mbot-example
botctl -C /tmp/mbot-example board add "整理 README" --owner coder
mbot -C /tmp/mbot-example run chief "请推进看板上的任务"
mbot -C /tmp/mbot-example status
```

## 受控运行

每次 run 创建新的 headless Session，使用 workspace-write/never、框架 overlay、超时、全局 flock 和干净 Git 基准。嵌套运行、PAUSED、目录/控制路径异常在模型执行前检查。上下文由角色、长期记忆、看板、任务和请求组装，跨次进展以任务文件为准。

Host 收集 NDJSON，检查退出码、final/reason 和 guard；恢复越权/非追加变更，校验 BOARD/tasks，生成脱敏 transcript/meta 后统一提交。不能将工具事件 completed 当作业务成功。合法任务产出可随失败审计保留，违规、模型失败和异常终止计失败；连续三次故障熔断，HEAD/控制路径异常立即暂停。

入库记录在 `transcripts/`，原始流/stderr 在被忽略且私有的 `.mbot/runs/`。顶层 token 不等于包含 Worker 的总成本。Git 元数据/提交失败保留证据并暂停，不能伪造成功；`resume` 只解除控制状态，不替代事务恢复或丢弃未提交改动。受管理 turn 的中断必须沿 [Runtime 恢复](runtime-recovery.md) 处理。

## 调度与任务归档

Chief 最多同时派两个 fresh Worker、深度 1；每个 Worker 先 boot 自己角色/任务，再执行和追加结果。独立 headless 通过 overlay 开启 interrupt，关闭 fork/Agent Teams/workflow 派活；纠偏/中断后由 Chief 验收或写 blocked 原因。外部产物的提交/合并由人类处理。

`tick` 优先 doing，否则按看板顺序选择 todo；无 todo/doing 时不调用模型，blocked 不自动推进。`archive` 将 done 任务按原字节移到月归档，其他状态保留；没有完成项时不提交，不调用模型。目的冲突或提交失败恢复看板/任务与索引，旧任务 ID 不复用，历史归档链接不因移动而重写。

## 外部目录 grants

`MBOT_GRANTS` 是用冒号分隔、已存在的物理绝对目录列表，支持空格，逐项传给 DSH add-dir。拒绝根目录、框架/数据/DSH 保护范围重叠、软链别名、相对/非规范路径、空项和重复项。仅 run/tick 使用，Dreaming 不继承。

任务声明的文件范围与原生目录授权分层约束。`/tmp` 在 DSH 中可写，在那里写成功不能证明非临时目录的隔离效果。主 Session 原生 Worker 当前只开放 scoped botctl，不因这套 headless grants 自动获得 Bash/文件权限，见 [原生 Worker](native-workers.md)。

## 验证

离线回归 `bash tests/run.sh`；真实模型分别运行 `bash tests/real-run.sh`、`bash tests/real-schedule.sh`。隔离凭据/DSH_HOME/XDG/数据，按脚本保留证据。历史样本与负例见 [M2](archive/0.1-acceptance.md#m2)、[M4](archive/0.1-acceptance.md#m4)，长期调度另按 [运维](operations.md) 验收。
