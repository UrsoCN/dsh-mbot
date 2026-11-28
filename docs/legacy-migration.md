# 旧只读回合迁移

当前基线 `0.2.0-rc.1`。旧 Host 可能不认识新 recover 命令，旧 journal 也没有 runtimeOwnership；直接重启会丢失原 Host 的内存记录。对已经由原生日志证明只执行核心只读操作的回合，可以先迁移数据审计，再加载新 Runtime。其他旧写者继续沿 [Runtime 恢复](runtime-recovery.md) 的所有权规则核实。

## 使用

```bash
botctl -C /absolute/Bot/data migrate-readonly --check
botctl -C /absolute/Bot/data migrate-readonly
```

必要时指定 `--session-root /absolute/native/session/store` 或 `--dsh /absolute/dsh`。默认原生日志目录为 DSH_HOME/sessions，沿用 Harness 的 HOME/tilde 解析；它不读取或执行 profile 配置。当前使用实测 DSH 0.2.2-rc.5 的官方持久化后端，从安装的 dsh 可执行文件定位 SDK，未安装到 PATH 时显式传 --dsh。

--check 会取得数据锁，核实完整 journal/私有快照、原生事实、PID 出生身份、许可进程、Git/锁 inode、原预算和准确 commit intent；不作 permit 退役、guard 回滚、Git 提交或清理 journal。检查和正式迁移都重新校验事实，不把先前检查作为许可。

正式迁移不调用模型、不执行生产 profile、不创建另一个 Agent，也不改写原生日志或 Session ID。输出包含 Git 审计及 nativeAccess=read、paused=true、runtimeReloadRequired=true。重复调用在无 journal 时返回 needed=false。保留 PAUSED 供复核，之后加载新 Runtime，再显式 resume。仍运行旧代码的 Host 不会因外部迁移而自动清除内存错误。

## 可迁移条件

- journal 保持原 agent-runtime scope 和完整身份/私有快照，且没有 runtimeOwnership；已有契约按其原规则恢复，不删除/降级字段来套用迁移。
- 官方 read handle 验证原生日志。回合不能来自继承前缀或 subagent；保存事件逐项匹配原生同 seq 事件，原生回合 completed，保存的 finish 与结束原因/模型文本一致。
- 所有实际 tool/call 只能是 botctl 的 boot/status/lint/board_show/task_show，每个都有唯一且成功的 tool/result。Native request/header 中的工具定义必须匹配核心 botctl 的参数/操作集合；不依靠名称猜测。模型输出不得存在未计入的工具调用，回合边界不能交叉。
- Git 基准/分支不变，工作树只允许无修改，或准确 commit intent 与私有副本能证明的 Host 审计产物；已提交时只接受准确的同一审计。其他修改拒绝并保留，不代用户丢弃编辑。

只读核心调用通过 fresh 数据子进程完成，不向既有 daemon/IPC 写者授予权限。因此可在原 Host 仍持有 Session writer 时使用官方 read handle 核对完整、不可改写的旧事件前缀；数据 flock 和遗留 journal 阻止其他受控回合执行，helper/许可进程与 guard 仍需核实。此推导只适用于已证明的只读核心契约，不扩展到 Bash、Worker、PTC、remember/任务写入或任意未知工具。

对 `/proc/environ` 不可读的新进程，通常继续拒绝。只在此契约下，且原 Host 仍存活、进程树能证明目标属于在 helper 开始前已经存在的独立分支时，才排除它；PID 出生身份和父关系重新核实。实际 Host 后代、未知孤儿、存活许可进程或无法建立祖先关系仍拒绝。无需硬编码进程名或用墙钟时间猜测归属。

## 审计与边界

Host proof 存在 /tmp 的 700 目录/600 文件中，并在提交和结算前再核实。Git meta 的 runtime.recovery_proof 保存原生事件 cut/hash、文本 hash 和只读调用的 ID hash/动作/完成位置，不保存权限 token 或输出原生私密正文。原始 journal/snapshot 不被改成 data-subprocesses。

有完整 commit intent 的已提交回合只结算一次；未提交则复用 guard、审计与统一 outcome。未知私有快照、HEAD/锁改变、原生日志缺失、未结束调用或其他写者拒绝。无旧 messages 的头继续旧格式审计，不生成 sealed reply 或虚构可投递回答。

这仍是受信任 Host/核心工具的契约，不能作为对恶意同权限代码的安全沙箱。非只读旧回合、缺失原生日志、Worker/后台/IPC 写者和睡眠 checkpoint 的迁移仍在 TODO。

## 验收

- 冷 Runtime 的只读旧头恢复、核心工具定义/边界校验，以及写动作、缺失结果、未知工具/定义、失败结果与交叉回合拒绝通过；整体为 43 项 Host + 70 项 Runtime，另有类型及 64 组 Bash 回归。
- 四类真实安装检查包含迁移 bin 和 SDK reader/只读证明资源，原有 Runtime Chromium 流程通过。
- `npm run test:gui-migration` 从 bcec931 构造真实旧 Host 包，配合更新后的 Bash 资源与本地 adapter，复现旧 IPC/旧请求头及验收失败；验证官方只读 handle、dry run、独立受保护进程排除、Host 后代拒绝、原 Host 存活时只提交一次、写入/Bash 回合拒绝、安装当前版本后同一 Session 继续对话。没有调用真实 DeepSeek API。

证据：`/tmp/mbot-readonly-migration-suite.log`、`/tmp/mbot-plugin-install.yB4zbm`、`/tmp/mbot-gui-migration.jLfDQP`、`/tmp/mbot-gui-runtime.t3NoPL`。

本地原始反馈中的旧 journal 已按相同入口恢复；实际 Git 审计 completed、无违规、计数 0、工作树干净，只新增 transcript/meta，PAUSED 保留。运行中旧 Host 的其他会话与服务保留，实际续聊的 Runtime 加载另行核验。证据：`/tmp/mbot-original-migration-final-check.json`、`/tmp/mbot-original-migration-result.json`。
