# M2：单次运行闭环验收

2026-11-26，Linux，DSH `0.2.2-rc.5`。M2 已完成，下一里程碑是 Dreaming。入口和恢复操作见 [README](../README.md#单次运行与恢复)，设计决策见 [design.md](design.md#82-单次运行生命周期)。

## 复现

离线回归：

```bash
bash tests/run.sh
```

包含 M1 的 16 组集成检查和 M2 的 15 组运行检查。真实模型验收：

```bash
bash tests/real-run.sh
```

此命令使用仓库 `.env` 或启动环境中的 `DEEPSEEK_API_KEY`，将工作区、DSH_HOME、配置、缓存和运行临时文件放到 `/tmp`；不改 HOME 或用户 DSH profile，不创建凭据文件副本。真实验收产物保留供复核，离线成功用例自动清理。

## 真实结果

本轮工作区：`/tmp/mbot-real-run.VbVY33/ws`。run-id：`20261125T164053Z-run-d6f1`（UTC；本地日期 2026-11-26）。

- 请求：`在看板上加一个任务：整理 README`。
- Chief 实际执行 `botctl board add "整理 README" --owner coder`，创建 `001` 与 `tasks/001.md`，状态 todo。
- 共享 MEMORY 与启动前逐字一致，guard 违规列表为空，botctl lint 通过。
- 数据仓库有 `human: init` 和一个 `run(chief): …` 提交；HEAD 父节点保持原初始化提交，工作树干净。
- transcript 记录实际工具调用、结果和最终回答；meta 标记 `success=true`、退出码 0、reason completed。
- DSH 调用耗时 24,464 ms；顶层用量：输入未命中 3,070、输出 1,210、缓存读 38,400、总 token 42,680。该样本不是延迟承诺，缓存不重复计入总量，Worker 的完整成本不在此统计中。

原始流与 stderr 在工作区 `.mbot/runs/`，Markdown 与 meta 在 `transcripts/2026-11-26/`。路径是临时证据位置，清理后按复现命令重新生成。

## 回归与恢复证据

| 场景 | 验收行为 |
|---|---|
| 正常建任务 | 一次调用一个干净提交，usage 只计算顶层 step_end |
| 改共享/私有 MEMORY、SOUL、AGENTS、wiki、其他文件 | 恢复越权项，记录违规，保留合法任务，运行判失败 |
| 删除 inbox 原始内容 | 按字节前缀发现非追加，恢复候选文件 |
| 改坏 BOARD | 恢复看板与本次任务修改，避免孤立任务 |
| 伪造旧 transcript、旧 raw、失败计数和忽略文件 | 恢复历史内容与控制状态，清理新越权文件 |
| 把 tasks 或 PAUSED 改成软链 | 修复工作区路径，外部目标内容不变 |
| Agent 自行提交、移动 HEAD | 记录观察 HEAD，恢复原提交父节点并立即 PAUSED |
| 运行内调用 mbot | 嵌套调用被拒，普通工具结果仍能结束父会话 |
| 请求/最终回答/stderr 含密钥 | 入库记录、commit 摘要、终端输出脱敏；原始日志保留原样 |
| 非法 JSON、缺失或错误 final、退出 1 | 保存失败审计、累计失败；三次连续失败自动暂停 |
| 超时 | 限时结束，meta 记录退出 124，保存 transcript 并计失败 |
| 并发 run 和人类 botctl 修改 | 第二个 run 跳过，人类变更报忙；期间人工 pause 保留 |
| 脏工作树 | 模型启动前拒绝，不创建业务改动 |
| Git 元数据不可用 | 原始证据保留、失败计数 +1、PAUSED；不伪造成功或强行提交 |

恢复时先查看 `mbot status` 和失败记录。普通运行失败可在处理问题后 `mbot resume`；HEAD/控制路径异常、Git 元数据损坏或提交失败，需要先检查并修复保留的工作区。resume 会清除 PAUSED 与连续失败计数，不会自动丢弃未提交改动。
