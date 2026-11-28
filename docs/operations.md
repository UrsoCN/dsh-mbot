# 运维与持续运行

当前基线 `0.2.0-rc.1`。cron、备份、clone 冷启动和人工观察工具已交付；**至少 7 天真实调度观察尚未完成**。主 Session 的维护生命周期见 [sleep/wake](sleep-wake.md)，事务中断见 [Runtime 恢复](runtime-recovery.md)。

## 定时运行与日志

[cron/mbot.crontab.example](../cron/mbot.crontab.example) 每两小时 tick，03:17 先 archive、成功再 dream。部署前调整绝对路径/PATH/工作区，框架不自动安装生产 cron。`ops/cron-run.sh` 固定目录并记录空闲、锁忙、PAUSED、失败等真实结果；退出 0 也可能代表跳过，需核对报告。

日志默认在 `${XDG_STATE_HOME:-$HOME/.local/state}/mbot/logs`，每次独立文件、权限 600，不能位于数据仓库、框架或 DSH_HOME 内。凭据放被忽略且私有的 DSH_HOME/.env，不写 crontab 或 argv；入库和运维输出脱敏，原始日志按私有证据处理。

## 可选备份与 clone 冷启动

`MBOT_PUSH_AFTER_DREAM=0` 默认关闭推送。开启后，成功 dream 在本地提交后推既有 upstream；不提示输入凭据。无 upstream、目的 URL 改变、拒绝或超时都保留本地成功，详情记录在忽略的 `.mbot/runs/*.push.log/.push.json`，超时最多额外等待 5 秒强制结束。

`ops/recover.sh` 克隆到 `/tmp`，清空 grants/关闭 push，先 lint，再做 Chief 只读冷启动，检查成功 transcript、零违规和数据未变。它验证 Git 数据/长期记忆可冷启动，不替代恢复原生 Session、Bot 绑定或活动 turn/维护 journal。原数据不被覆盖，生产切换由人类复核。

## 暂停、恢复与回滚

用 `mbot -C <目录> status/pause/resume` 查询和控制独立数据运行。三次连续故障熔断，HEAD/控制路径异常立即暂停；resume 不能跳过未结算 journal。主 Session 先 stop 等待捕获回合，再沿 Host recover 核验已支持写者；恢复完成保留 PAUSED，检查审计后显式 resume。

Dreaming 的 `git revert` 回滚记忆和输入进度，失败备份不回滚本地 dream。数据 clone、turn 恢复和睡眠维护恢复分别有不同证明，不能以“有备份”替代原生/Git/journal 一致性。详细边界见 [持久证据](durable-recovery.md)、[Runtime 恢复](runtime-recovery.md)、[Worker 恢复](worker-recovery.md)。

## 长期观察验收

人类通过 `ops/observe.sh` 加锁、脱敏并提交 `wiki/ops-log.md`，记录首次 UTC、当天状态、预算/lint、最近 dream 和留存违规。该文件对所有 Bot/Dreaming 只读，快照不替代人工核对；违规计数只来自当前留存 metadata，revert 后仍需检查 Git 历史。

连续至少 7 天逐日核对：记忆在预算内，每晚存在 dream/dream(failed) 提交及报告，异常/违规已处理，恢复与回滚可复现。保存中断和实际天数，不能用第零天、同一天重复快照或 elapsed 小时数冒充完整观察。最终由人类在 ops-log 记录结论，再结算 TODO。

主 Session 长跑还需跟踪历史轮数、事件/ignored 体积、恢复时间与内存，并观察睡眠收信、同 Session 唤醒和 checkpoint/摘要更新。规模基准见 [Runtime 架构](runtime-architecture.md)，单次模拟不替代真实连续运行。

## 验证与历史证据

`bash tests/run.sh` 验证运维/备份/日志/锁/预算等离线行为，`bash tests/real-ops.sh` 在隔离 `/tmp` 数据、bare upstream 和 DSH_HOME 下做真实模型演练，不部署 cron。早期第零天结果及提交保存在 [M5 历史记录](archive/0.1-acceptance.md#m5)；清理后的临时证据按脚本复跑。
