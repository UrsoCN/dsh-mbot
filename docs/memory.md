# 长期记忆与 Dreaming

当前基线 `0.2.0-rc.1`。Markdown/Git 是长期记忆真相源；本模块维护记忆写者、增量取材和回滚契约。Session 的近期摘要是派生工作状态，见 [checkpoint](context-checkpoints.md) 与 [自动/手动摘要](managed-compaction.md)。

## 归属与预算

| 内容 | 写者与约束 |
|---|---|
| 共享/角色 MEMORY、wiki | 工作 Bot 只读，独立 Dreaming 在验收事务内整理；人类可维护 |
| inbox 候选 | `remember` 仅追加，保留已有字节前缀和真实角色/任务来源 |
| SOUL、协议、配置和工具 | 人类维护，工作 Bot/Dreaming 不修改 |
| `wiki/ops-log.md` | 人类专用，Dreaming 也只读 |
| Dreaming 报告/checkpoint | Host 与本轮合法记忆变更一起审计、提交 |

默认 MEMORY 每文件不超过 150 行/3000 UTF-8 字符，SOUL 5000 字符，wiki 每文件 200 行，BOARD 80 行。预算与链接由 lint 验证；删除已有记忆需逐文件提供有效依据，必需的 wiki 索引保留。外部资料、历史日志和候选是参考数据，不能变成覆盖角色协议的指令。

## 增量整理

```bash
botctl -C /tmp/mbot-example remember "周报使用中文" --as chief
mbot -C /tmp/mbot-example dream
```

Dreaming 是独立 fresh Session，按 Analyze → Merge → Rewrite → Report 整理。优先选 inbox，再选 transcript/归档任务，新材料默认最多 64000 字节，按完整 UTF-8 行截取；单行装不下时保留进度、记录失败且不调模型。

成功 checkpoint 保存输入 blob/offset/pending，续读尚未处理的片段；未读期间追加内容按顺序继续。替换源按当前版本处理，重命名源重新入队，避免漏读或复活已删除内容。失败 metadata 的 processed 仅记录本次选材，重试仍以最近成功 checkpoint 为准。

只允许约定的 MEMORY/wiki 和本轮报告变化。预算、链接、删除依据、报告或模型验收失败时恢复全部记忆，只提交失败报告/metadata，不推进 checkpoint；偷改任务/BOARD/协议也被恢复。成功的记忆、报告与进度属于同一个 dream commit。

## 回滚与主 Session 维护

`git revert <dream-commit>` 同时回滚记忆和进度，后续可重新处理仍存在的候选；这不是删除全部历史或外部副本。后续 run 冷启动读取当前记忆，主 Session 在下一 turn 按知识内容 hash 更新视图，旧摘要按受管理规则退役。

`/mbot sleep` 在维护屏障内调用同一独立 Dreaming，再推进可选 compact/checkpoint 和 sleeping；不会给工作 Bot 直接写记忆的权限。已提交 Dreaming 的中断只补后续阶段，详见 [sleep/wake](sleep-wake.md)。多域记忆过滤、质量评测、异议/遗忘治理仍按 [DESIGN](../DESIGN.md#远期研究p3) 研究。

## 验证

`bash tests/run.sh` 覆盖预算、逐文件删除依据、越权回滚、完整行续读、源替换/重命名与失败进度；`bash tests/real-dream.sh` 验证候选 → 整理 → 后续冷启动 → revert，`npm run test:real-plugin` 验证安装包内工具与 Dreaming。历史真实样本见 [M3](archive/0.1-acceptance.md#m3)，不将单次样本视为记忆质量评测或持续运行证明。
