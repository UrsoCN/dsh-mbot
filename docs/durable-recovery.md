# 持久恢复证据与跨重启进程身份

当前基线 `0.2.0-rc.1`。活动回合的私有恢复快照位于工作树外持久状态目录，PID 出生身份与 Linux 内核 `boot_id` 联合核验，使已支持契约在宿主机重启或 `/tmp` 清理后仍可恢复。此能力在 R1 交付，以下保留路径、版本与写盘顺序契约。

## 持久私有状态目录与定位规则

Host 与独立 CLI 共用 [plugin/turn-state.js](../plugin/turn-state.js) / [bin/turn-state.mjs](../bin/turn-state.mjs) 的定位规则，路径位于 Bot 数据工作树之外：

1. `MBOT_STATE_DIR`（显式指定绝对路径）
2. `${XDG_STATE_HOME}/mbot`
3. 若设置了隔离的 `DSH_HOME` 且未设置以上两项，则派生 `${DSH_HOME}/mbot-state`（避免测试或隔离 profile 写入宿主 `~/.local/state`）
4. 默认 `~/.local/state/mbot`

单次回合的私有快照目录为：

```text
<stateRoot>/turns/<sha256(workspacePath)[0..31]>/<runId>/
```

所有祖先目录（`<stateRoot>`、`turns`、`<workspaceHash>`、`<runId>`）必须满足：非软链目录、当前 UID 拥有、权限严格为 `0700`，且 `<stateRoot>` 的规范路径不能与 Bot 数据工作树重叠（防止 guard 自我复制或通过工作树写权限修改私有恢复证据）。

## 写盘与发布顺序

1. `bin/mbot-turn` 持有 `.mbot/lock` 与 `.mbot/botctl.lock`，创建上述 `0700` 持久快照目录并 `fsync` 父目录。
2. 写入 `header.json`、`token.json`、`ledger.json`（含 `scratchFormatVersion: 1` 与 `bootId`）、`ignored.list`、`settings`、`secrets.json`、`grants.json` 及空日志，全部 `fsync` 落盘后再通过原子写 + `fsync` + `rename` + `fsync(parentDir)` 发布数据仓库内的 `.mbot/runs/active-turn.json`。
3. 发布 `active-turn.json` 后将其同步快照入 `ignored/.mbot/runs/active-turn.json` 并追加至 `ignored.list`（同步 `fsync`），使 guard 校验能精确识别当前回合控制文件，而不豁免整个 `.mbot`。
4. Worker 委托/事件/封存（`bin/turn-actor.mjs`）、`finish.json`、`commit-intent.json`、阶段切换（`committing`/`committed`/`abandoned`）以及恢复派生文件均使用原子替换与文件/目录 `fsync`。
5. 结算清除 `active-turn.json` 并同步 `.mbot/failures` 与 `.mbot/runs` 目录，随后清理该回合持久快照目录。

## 跨重启进程身份（boot_id）

- `bin/mbot-turn`、`plugin/runtime-recovery.js`、`plugin/ipc.js` 均读取 `/proc/sys/kernel/random/boot_id`（小写 UUID）并写入 journal / proof / IPC `owner.json`。
- `bin/turn-writers.mjs` 在核验 `pid`/`ownerPid` 时同时比对 `bootId`：
  - **同次启动（`sameBoot`）**：保持原有精确 `pid + pidStart` 存活校验，及基于 `record.pidStart` 的不可读进程保守拒绝。
  - **跨次启动（`record.bootId !== currentBootId`）**：上一次内核启动中的旧 helper/Host 进程已必然终止，不会因为重启后 PID 与 `/proc/<pid>/stat` 启动节拍复用而误判旧宿主存活；但仍全量扫描当前同 UID 可读进程，若发现任何仍携带原 `MBOT_PERMIT_TOKEN` / 派生 Actor token 的进程，继续拒绝恢复。
- `bin/turn-receipt.mjs` 与 `plugin/ipc.js` 同步校验 `bootId`，避免重启后因 PID/tick 复用而永久误判审计进行中或 IPC 端点被占。

## 向后兼容与拒绝边界

- **旧 `/tmp` reader 保留**：不搬迁活跃快照，不补写缺失证明。无 `scratchFormatVersion` 的旧 `/tmp/mbot-turn.<alnum>` journal 仍可按原规则验证和恢复；若旧 `/tmp` 快照已随重启丢失，继续保守拒绝并保留 `.mbot/runs/active-turn.json`。
- **防篡改与失败闭合**：
  - 声明了 `scratchFormatVersion` 却指向 `/tmp/mbot-turn.*`、未知 `scratchFormatVersion`、路径不匹配当前 `stateRoot/workspace/runId`、目录权限非 `0700` 或存在软链祖先均拒绝恢复。
  - 未知 Writer 契约、原生日志缺失、锁/Git inode 变更、HEAD 偏离或 `commit-intent.json` 损坏仍保持拒绝。

## 验收范围

- 数据桥测试：持久目录位于数据仓库与 `/tmp/mbot-turn.*` 之外；篡改 `scratchFormatVersion`、放宽目录权限（`0755`）均拒绝；模拟跨重启 `bootId` 变化且旧 PID+starttime 与当前进程碰撞时，活 permit 进程仍拒绝，退出后单次恢复并清理持久快照；旧 `/tmp/mbot-turn.*` 无 `scratchFormatVersion`/`bootId` 的遗留 journal 仍可恢复。
- 原生 Runtime/Worker v3 测试：带 scoped botctl Worker 的中断回合在模拟跨重启（新 `bootId` + PID 碰撞）下通过原生 closers 单次恢复，不重跑模型，恢复后显式 `resume` 沿用同一主 Session 继续对话。
- 全量回归（类型、Host/Runtime 套件、64 组 Bash）与 source/tarball/Git/web-tarball 四类安装验收通过。
