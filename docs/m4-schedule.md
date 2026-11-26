# M4：星型调度验收

2026-11-26，Linux，DSH `0.2.2-rc.5`。本文件保留 M4 的历史验收。入口见 [README](../README.md#星型调度tick-与归档)，当前约定见 [设计](design.md#5-任务记忆与归属)。

## 复现

```bash
bash tests/run.sh
bash tests/real-schedule.sh
```

离线有 16 + 15 + 11 + 8 = 50 组检查，不调用模型。真实测试使用仓库 `.env` 或环境中的 DeepSeek key，创建独立 `/tmp` 工作区、项目、DSH_HOME 和缓存；不改 HOME 或用户 DSH profile。zstd 仅用于解压持久会话验证 Worker 第一条工具命令，不增加框架运行依赖。

## 真实结果

工作区：`/tmp/mbot-real-schedule.sH10dB/ws`；外部项目：同目录旁的 `project`。

| 阶段 | 结果 |
|---|---|
| 并行开发 | Chief 建 001/002，持久写派活说明并标 doing；coder-001/002 同时 running |
| Worker 001 | 第一工具操作 boot coder --task 001；写 greet.sh，默认输出 Hello, world!，Ada 输出 Hello, Ada!，参数不 eval；结果写自己任务单 |
| Worker 002 | 第一工具操作 boot coder --task 002；独立写中文 README，用法与输出正确，结果写自己任务单 |
| Chief 验收 | 只读验收两份产物，验证输出、文件和 coder 结果；两个任务 done；外部项目 HEAD 未变 |
| 人为卡住 | 新任务 003，coder-003 boot 后写 started 标记并 sleep 30；Chief 确认进入 sleep，再 interrupt_agent |
| 中断结果 | coder-003 inactive；003 blocked，附「人为中断验收，Worker 未完成」原因；不误标 done |
| 归档 | 001/002 原样移动到 tasks/archive/2026-11，003 保留；chore(archive) 提交；MEMORY 与初始内容逐字相同，lint 通过，数据仓库干净 |

真实 list_agents 的原始结果：

```text
lead [running] — root agent
coder-001 [running] — 实现 greet.sh 脚本
coder-002 [running] — 编写 README.md 中文说明
```

两次 run 的 metadata 均为 `success=true`、退出 0、reason completed、violations 空；grants 明确记录项目物理目录。持久会话共三个 Worker，脚本从各自日志验证了第一条工具调用为对应 boot。数据仓库提交为：

```text
26e1589 chore(archive): archive 2 done tasks
5ff99ef run(chief): 20261126T004457Z-run-2cf3 …
ba58098 run(chief): 20261126T004328Z-run-7a08 …
8753682 human: init
```

并行 run 调用 89,167 ms，顶层总 token 232,345（缓存读 208,768）；中断 run 调用 30,965 ms，顶层总 token 109,626（缓存读 100,992）。这些只覆盖 Chief 的顶层流，不是含 Worker 的总成本，也不是延迟承诺。

## 离线边界

- 无 todo/doing 的 tick 即使 DSH 不可用也直接跳过；有 doing 时优先，否则按看板顺序选择 todo，blocked 不变。
- archive 保留 done 任务字节，其他状态保留；无完成项不提交，不调用模型；归档后的 ID 不复用。
- 目的文件冲突、提交失败会恢复看板/任务与索引，不留下半份归档。
- grants 支持空格和共同前缀，逐项形成独立 add-dir；拒绝 root、保护目录重叠、空项、重复、相对路径、软链别名与非规范路径，均在调用模型前失败。
- dream 不授予外部目录；tick/archive 尊重 PAUSED、全局锁和运行内禁用规则。
- 历史归档任务不检查旧链接目标，原始记录不因移动而改写。

本次模拟项目位于 `/tmp`，该区域在本机 DSH 中本就可写；这里验证了真实参数接受、目录记录及任务行为，不把 `/tmp` 的写成功当成非临时目录沙箱隔离的证明。每个 Worker 的文件范围由任务协议限定，仓库级边界由 DSH grants 限定；外部产物由人类审阅、提交和合并。
