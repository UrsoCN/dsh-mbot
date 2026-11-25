# M0：DSH 行为实测

2026-11-25，Linux，DSH `0.2.2-rc.5`。验收结论已回填 [design.md §14.2](design.md#142-m0-实测结论2026-11-25dsh-022-rc5)，[TODO M0](../TODO.md) 已完成。

## 复现

依赖：`bash`、`git`、`jq`、`flock`、`timeout`、`zstd`、`node`、`dsh`。`zstd` 仅供此探针查看默认压缩的持久会话，框架运行时不增加该依赖。在仓库 `.env` 中配置 `DEEPSEEK_API_KEY`，或从环境提供，然后运行：

```bash
bash tests/m0-spike.sh all
```

可单独选择 `baseline`、`permissions`、`subagents`、`patch`、`interrupt`。`MBOT_DSH` 可指定 dsh 可执行文件，`MBOT_SPIKE_TIMEOUT` 可修改每个场景的秒数上限（默认 300）。这是调用真实 API 的验收探针，不是未来 M1/M2 的离线回归测试。

脚本创建 `/tmp/mbot-m0.XXXXXX` 下的 Git 工作区、独立 `DSH_HOME`、外置脚本、日志和缓存；不重设 HOME、不修改真实 DSH profile。以 `env -i` 启动 dsh，凭据只来自隔离 `$DSH_HOME/.env`，不出现在 argv 或终端输出。结束时删除该凭据副本；保留日志供复核。真正的越界测试使用当前仓库中的临时 `.m0-outside.XXXXXX/denied.txt`，退出时清理该目录。

日志包括每场景的 `.jsonl`、`.stderr`、`.metrics.json`，以及解压后的 `logs/sessions/*.jsonl`。不把原始会话日志提交进框架 Git 仓库。

## 本轮验收

完整运行的证据目录：`/tmp/mbot-m0.By95Ln/logs`（本机临时产物，清理后用上述命令重新生成）。5 个场景的进程退出码均为 0，`final.reason.kind` 均为 `completed`；探针断言失败数为 0。

| 场景 | 总耗时 | 实际证据 |
|---|---:|---|
| baseline | 7,168 ms | `pwd + ls -a` 成功；顶层答复带根 AGENTS 口令；7 类 NDJSON 事件 |
| permissions | 12,507 ms | 内部读写成功；外部脚本/PATH/运行标识/flock 正常；越界文件写拒绝，外部原文件不变 |
| subagents | 29,595 ms | 两 Worker 同时 running；各自继承环境与 AGENTS；孙代理受深度闸门拒绝；完成后恢复写文件 |
| patch | 3,959 ms | 持久 `assistant/message.data.message.source.model` 为 `deepseek-v4-pro` |
| interrupt | 12,024 ms | 启用 overlay 后，中断正在 `sleep 60` 的 Worker，实际状态转为 inactive |

这些耗时包含启动、网络、模型执行、工具及结束刷新；初次模型请求也可能命中其他调用留下的服务端缓存。它们不是纯进程启动计时，也不是多样本性能评测。

基线有两次 `step_end`，用量逐步相加：`inputTokens=572`、`outputTokens=178`、`cacheReadTokens=11648`、`cacheWriteTokens=0`、`totalTokens=12398`。这里 `inputTokens` 是未命中的输入部分，缓存读已包含在 `totalTokens` 中，不能再累加一次。该统计只覆盖顶层；Worker 完整步骤在各自的持久会话中。

## 实现时必须保留的差异

- `final` 只含 `{type, sessionId, reason, text}`，没有汇总 token。启动失败可只有 `error`，甚至没有 JSON 事件；M2 同时检查进程退出码和终止原因。
- 越界 `write` 的事件是 `status=error`、`error.code=FS_SANDBOX_DENIED`；越界 bash 命令的事件却仍是 `status=completed`，实际 shell 返回 1，输出 `Permission denied`。工具完成不代表业务成功。
- DSH 的临时区可写。第一轮把拒绝目标放在 `/tmp`，两类写入都成功；修正目标位置后才实测到拒绝。这是权限边界的一部分，不能把临时区中的外置脚本当成只读工具部署。
- fresh Worker 的 prompt 未包含根口令；其持久最终答复仍带口令，证明工作区 `AGENTS.md` 原生加载。派活仍需要 `botctl boot` 注入 SOUL、MEMORY 和任务。
- 默认 `maxDepth=1`、`maxActiveSubagents=8`。深度 2 的工具实际失败；并发仅实测两路，8 是安装包源码中的默认值。
- `send_message` 模型工具的实际结果是 `message delivered to agent probe-a`，不是设计初稿所说的 `messageId` 对象。恢复轮产出以实际文件和子会话为证。
- `interrupt_agent` 默认关闭。M4 传入 `tool-subagent-control.config.interrupt: true` overlay；实测返回 `interrupt requested for agent slow-probe`，随后 `list_agents` 显示 inactive。

默认模型是 `deepseek-official/deepseek-flash`。本次切换到 Pro，以响应源而非模型自述核实覆盖有效；Dreaming 要明确使用 Flash 时，同一入口传入以下 overlay：

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
```

后续 M1 不依赖 DSH 的在线调用；M2 的 renderer/guard 和 M4 的控制 patch 应按这些实测结果实现。
