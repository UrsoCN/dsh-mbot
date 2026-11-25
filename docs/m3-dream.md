# M3：Dreaming 与记忆闭环验收

2026-11-26，Linux，DSH `0.2.2-rc.5`。M3 已完成，下一里程碑是星型调度。入口见 [README](../README.md#dreaming-记忆闭环)，设计见 [design.md §11](design.md#11-dreaming单阶段)。

## 复现

```bash
bash tests/run.sh
bash tests/real-dream.sh
```

第一条命令不调用模型：16 组基础、15 组运行、11 组 Dreaming 检查，共 42 组。第二条使用仓库 `.env` 或环境中的 DeepSeek key，创建 `/tmp` 下独立数据仓库、DSH_HOME、配置和缓存；不改 HOME/用户 DSH profile，不创建凭据副本。成功离线数据清理，真实数据保留供复核。

## 真实闭环

本轮工作区：`/tmp/mbot-real-dream.bPP67Q/ws`。

| 步骤 | 实际结果 |
|---|---|
| `mbot run chief "以后周报一律用中文，记住这条"` | remember 投递到 inbox，MEMORY 与初始内容逐字相同，无新任务 |
| `mbot dream` | 共享 MEMORY 新增用户偏好；来源是 inbox，added 使用本地 2026-11-26；报告与 checkpoint 同一个 dream commit |
| 英文请求 `Draft a short weekly report with three sections: Completed, Next, Risks.` | 回复中文周报正文；空看板下用草稿并说明没有已登记事实，没有编造进展 |
| `git revert <dream commit>` | 恢复初始 MEMORY，移除该报告和 checkpoint；lint 通过，工作树干净 |

Dream commit：`ad1f0bb`；run-id：`20261125T171408Z-dream-ceb9`。这是 UTC 时间，added 日期按本地日期设置。报告和 metadata 在 revert 后可从 Git 中查看：

```bash
git -C /tmp/mbot-real-dream.bPP67Q/ws show ad1f0bb:dream-reports/20261125T171408Z-dream-ceb9.md
git -C /tmp/mbot-real-dream.bPP67Q/ws show ad1f0bb:dream-reports/20261125T171408Z-dream-ceb9.meta.json
```

本次选入 8,009 字节：inbox 142 字节、transcript 7,867 字节，低于 64,000 字节预算，pending 为空。Dreaming 调用 20,771 ms；顶层 token：输入未命中 5,737、输出 2,060、缓存读 75,776、总量 83,573。缓存不重复计入总量；这是单次样本，非固定延迟或整棵代理树的成本承诺。

## 离线证据

- 同一成功事务写共享/私有 MEMORY 与 wiki，原始候选保持不变；后续 run 的冷启动能读取规则，revert 后规则不再注入。
- 共享/私有预算超限、wiki 超限、链接失效、模型出错、报告缺失、报告路径错误、依据为空或写错文件，都恢复所有记忆，只提交失败报告/metadata。
- 旧行删除必须逐文件说明；MEMORY.md 的依据不能被 bots/coder/MEMORY.md 的条目冒充。普通 wiki 页面可在有效依据下删除，必需的 wiki/_index 保留。
- Dreaming 偷改 BOARD 或新建任务被恢复；run/dream 共用锁和嵌套防护。
- 48 字节的 UTF-8 完整行批次能跨多次 dream 续读；未读片段期间追加新内容，按偏移顺序处理，每个输入字节只消费一次。完成后不重复处理旧输入。
- 失败不推进 checkpoint；被替换的未读源使用当前版本，被重命名的源重新入队，避免因 Git rename 分类漏读。
- 完整单行装不进预算时保留进度、生成失败报告且不调用模型，提高预算后可继续。
- 模型报告与 metadata 脱敏；子命令 `--help` 只显示帮助，不再进入候选；本地日期与 UTC run-id 区分。

Checkpoint 存在成功报告 metadata 中，与记忆同一个 commit。失败 metadata 的 processed 表示本次选入材料，失败后不视为已处理；重试仍使用上一成功 checkpoint。revert 也回滚进度，后续会重新整理仍存在的候选。

M3 复用了 M2 生命周期，框架 `bin/` + `lib/` 当前 975 行（含注释和空行）。设计中的体积目标由 800 调整为 1200，以保留显式的续读和失败恢复；纯 Bash、Markdown + Git、单阶段 Dreaming、无插件/数据库的框架不变。
