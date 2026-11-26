# M5：无人值守工具与第零天演练

2026-11-26，Linux，DSH `0.2.2-rc.5`。M5 的 cron 示例、可选备份、恢复和人工观察工具已实现并测试。**连续 7 天观察尚未完成，M5 整体验收仍待定。** 本次未安装生产 cron。

## 复现

```bash
bash tests/run.sh
bash tests/real-ops.sh
```

离线共 16 + 15 + 11 + 8 + 14 = 64 组检查，不调用模型。真实脚本使用仓库 `.env` 或环境 key，仅在临时 DSH_HOME/.env 写入凭据，再通过 `env -i` 运行；凭据不在环境参数或 crontab 中，结束删除临时凭据文件。所有数据、日志、克隆和本地 bare 备份在 `/tmp`，不修改 HOME 或用户 DSH profile。

## 运维行为

| 入口 | 行为 |
|---|---|
| cron-run tick | 固定工作区，执行 tick，空闲/锁忙/PAUSED 如实记录 |
| cron-run nightly | archive 成功后接 dream，归档错误阻止模型调用 |
| 可选 push | 默认关闭；成功 dream 本地提交后推既有 upstream；无 upstream、URL 改变、拒绝或超时保留本地成功 |
| recover | `/tmp` clone → lint → 只读冷启动；本次清空 grants/关闭 push；校验成功 transcript、零违规与数据未变 |
| observe | 人工加锁、脱敏并提交 ops-log；保存首次 UTC、当日状态、预算、lint、最近 dream 与留存审计违规数量 |

cron 日志保存在 `${XDG_STATE_HOME:-$HOME/.local/state}/mbot/logs`，权限 600，每次独立文件。目录不得在工作区、框架或 DSH_HOME 内。push 的 `.push.log/.push.json` 在 `.mbot/runs` 忽略目录；日志脱敏已知 secret 和 HTTP URL userinfo，push 不提示输入凭据。超时后最多额外等 5 秒强制结束。

observe 不替代人工核对。lint 错误会入记录并返回非 0；运维文件预算超限或目标有未提交改动则恢复/拒绝。违规计数来自当前留存 metadata，不自动判断是否处理；revert 删除的报告仍须从 Git 历史核对。`wiki/ops-log.md` 是所有 Bot（包括 dream）的只读文件，不能让模型编造观察结论。

## 真实结果

工作区 `/tmp/mbot-real-ops.h3htZk/ws`；备份 `/tmp/mbot-real-ops.h3htZk/backup.git`；恢复 `/tmp/mbot-recover.zGzbgB/ws`。

| 阶段 | 证据 |
|---|---|
| 空环境 nightly | 仅临时凭据文件供认证；归档 001 字节不变；dream 合并中文周报规则；成功、零违规 |
| 本地备份 | `.push.json` attempted/success 均 true；bare upstream 与 dream HEAD 相同 |
| PAUSED | nightly 两步均跳过，HEAD 未变；resume 清除暂停、失败计数归零 |
| clone 冷启动 | Chief 正确说明身份、空看板及中文周报规则；成功、零违规、grants 空；只新增 transcript，原仓库未变 |
| revert | 回滚 dream 与 checkpoint，MEMORY 与整理前逐字相同；lint OK |
| 人工观察 | 第零天记录 elapsed=0；明确 7 天待验收；工作树干净 |

真实提交：

```text
6775cce human: ops snapshot 2026-11-26
3fb5d90 Revert "dream: 20261126T012021Z-dream-3360 …"
09abb0c dream: 20261126T012021Z-dream-3360 …
77b9d77 chore(archive): archive 1 done tasks
9bc76c0 human: board set 001 done
8b87f0e human: board add 001 …
50229f6 human: remember (human)
2dee4c6 human: init
```

dream 调用 22,294 ms，顶层总 token 75,644（缓存读 67,840）；恢复问答 15,799 ms，顶层总 token 42,140（缓存读 36,224）。这是一次演练数据，不是持续运行或容量指标。revert 后报告从工作树删除，可用 `git show 09abb0c:dream-reports/20261126T012021Z-dream-3360.meta.json` 复核。

## 离线边界与待验收

14 组运维检查覆盖默认关闭/成功备份、失败 dream 与普通 run 不推、缺失和本地-dot upstream、远端拒绝、超时、模型期间改变目的地、配置校验、空环境 cron、日志路径/权限、nightly 顺序与失败短路、并发日志、clone 冷启动、观察脱敏/锁/预算/失败记录/只读保护与 Bot 入口拒绝。原有 50 组行为全部保持通过。

后续在实际数据仓库部署示例，按本地日期每日使用 observe 并人工核对：至少 7 天记忆持续在预算内，每晚有 dream/dream(failed) commit 和报告，无未处理越权，恢复与回滚操作可复现。当天重复快照和 elapsed 小时数不自动满足验收；最终结论由人类记录在 ops-log 后更新 TODO。
