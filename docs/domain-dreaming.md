# 独立域 Dreaming

默认私人 Dreaming 见 [记忆模块](memory.md)，域候选来源见 [conversation](conversations.md#域候选事务)。本文维护额外对话域的取材、写集和维护设计。

开发分支已接通**取材、无工具模型执行、逐行写集、持久维护和中断恢复**。可信所有者 Host 可对已附着域调用 `ctx.mbotRuntime.dream(agent, { signal?, timeoutMs? })`，返回 `empty` 或带 commit/checkpoint 的 `committed`；它不会创建实体或开放业务准入。域仍为 `reserved`，所有者域命令、公开激活、摘要与 sleep/wake 联合流程仍在 [TODO](../TODO.md)。现有 `/mbot dream` 继续是私人 headless 入口，不能据此执行域维护。

## 已实现的来源契约

`plugin/domain-dream-source.js` 的 `captureDomainDream` 接收 Host 固定的 scope、角色、完整原生日志、Git commit 和可选增量位置。它只读取已提交资料和原审计中的候选，忽略工作树草稿。

- Bot/conversation/Session、来源 key、visibility、权限 hash 必须一致。日志从 seq 0 连续排列，不继承其他 Session；活动回合、未知/未提交回合及待结算 turn journal 均拒绝。
- 与 checkpoint 共用 `plugin/context-restore.js`：检查原审计 commit、父 HEAD、版本化 outcome、域知识与 snapshot 链、原生 tool-call/dispatch/result 和候选 blob。读取禁用 Git replace；候选不会被当前文件或展示卡片替代。
- 使用官方 `foldSurface` 重建各 snapshot 的原生来源 cut，再核验 Inbox 原始字节。只接收 journal v5 中 `success=true/outcome=completed` 的候选，且每条必须有成功原生回执。失败/取消候选保留审计，但不自动输入模型；v4 只读回合继续参与历史证明，不产生候选。
- 输入只包含显式发布的域文档和选中候选。私人任务、历史、摘要与未列入清单的文件不进入模型请求。协议、SOUL 和候选中的文字都是引用数据，不能改变本次维护的权限。
- 文档和旧候选按当前凭据规则重新脱敏。身份/路径若含凭据则拒绝，避免改写来源。发生脱敏的文档只读，防止模型用掩码覆盖它没见过的原内容。

来源按原生 turn、文件内记录顺序排列。增量 cursor 绑定 scope hash、原 commit/meta、turn/runId、行索引、callId、知识版本和候选 hash；必须与一个已核验来源完全匹配。它只是**读取位置**，不证明候选已经消费；调用方必须从已验证的维护 Git checkpoint 取得上次位置。

默认输入 JSON 上限 64000 字节，包括资料、身份、来源和预算说明；完整候选逐条装入，不截断 UTF-8 或正文。一条也装不下时明确失败，不能跳过阻塞项。输出 `nextCursor/more` 只供后续事务使用，捕获阶段没有进度写入。`captureHash` 绑定固定知识、原生日志 cut、输入、预算和增量位置，它是完整性检查，不能单独充当维护授权或恢复证明。

## 已实现的模型与写集契约

`plugin/domain-dream-plan.js` 构造独立的 system/user 两条消息，辅助 purpose 为 `mbot-domain-dream`（在官方类型中声明为辅助用途）。只透传 provider/model/maxTokens，不继承 Agent 历史、工具、父请求扩展字段。Host 从该 Agent 的官方 `model.current()` 捕获 provider/model，以 maxTokens=4096 调用其 scoped LLM；Agent 闸门只允许当前维护持有的确切请求对象。请求和嵌套消息冻结，原生/用户/超时/Runtime 关闭信号关联到同一次执行，helper 退出也取消模型。只接受正常 stop 的文本结果；工具、异常结束和超出输出预算的响应不进入写集。

模型必须返回精确结构的 JSON：

```json
{
  "decisions": [{"sourceId": "捕获的来源 ID", "action": "merge", "reason": "本次取舍依据"}],
  "changes": [{
    "path": "memory/conversations/<conversationId>/MEMORY.md",
    "baseHash": "捕获文档的 textHash",
    "edits": [{"startLine": 2, "deleteCount": 0, "lines": ["带归属与不确定性的记忆"],
      "sourceIds": ["捕获的来源 ID"], "reason": "插入、替换或删除依据"}]
  }],
  "report": "本次取舍、冲突和删除的解释"
}
```

每条来源恰有一个 `merge/defer/reject` 决定。每个 merge 必须被实际修改引用；每个修改只能引用 merge 来源。defer 表示本次已审阅、保留供人工复核，后续成功提交可推进经过它的 cursor，不自动无限重试。候选文件始终保留，决定不等于对内容真实性的证明。

可写范围只含显式发布、未被脱敏的本域 memory/reference；共享资料、协议、SOUL、VIEW、私人目录及新文件均不可写。编辑使用原文的 1 基行号，必须升序且不重叠，插入/替换/删除都要说明依据。Host 重建完整目标字节，保留未修改行及原末尾换行状态；不让模型直接执行文件操作。

插入文本的链接只接受 `[[显式发布路径.md]]`，可带 `#anchor` 或 `|label`，只核验目标文件在清单中，不自动读取链接或校验文内锚点。其他方括号链接、HTML 和反斜杠语法拒绝；已有未修改行保持原样。新增资料需人类先发布到 VIEW。

校验最终实际视图的合并 memory 行/字符预算、SOUL 字符数及逐份 reference 行数，与普通 turn 共用 `domain-budget.js`；被脱敏的只读资料仍按原提交内容计数。另有单文件 64 KiB、总资料 256 KiB 和默认响应 128 KiB 上限。响应中的凭据、非法 Unicode/NUL/CR、越界来源、重复决定、无效删除及空修改均拒绝。通过后生成冻结的 write set（路径、前后 hash、目标字节）、完整建议与 `planHash`，不会应用到工作树。

## 持久维护事务

`plugin/domain-dream.js` 负责 Host 生命周期，`bin/mbot-maintenance` 持有 `.mbot/lock` 与 `.mbot/botctl.lock`，`domain-maintenance.mjs` 执行受限 NDJSON 协议。模型不取得数据写工具；全部文件写入与 Git 变更在 helper 内执行。Git 写子进程继承两把锁，helper 被杀也不能让仍活动的子写者与恢复重叠。

1. BotCoordinator 屏障排空已知 Agent/工具/转交操作，原生 `agent.runMaintenance` 保留执行所有权。固定域登记与目录，flush 完整 Session，拒绝未结算 turn/其他维护、PAUSED、脏工作树或索引；保存 HEAD/ref、Git/锁 inode 和包括 ignored 文件的完整工作树基线。
2. 从 Git/原生日志递归认证旧消费 checkpoint，随后捕获来源。无新候选返回 `empty`，不调用模型或写入消费进度。工作树外私有目录保存完整输入及阶段快照；先 fsync，再发布 `maintenance/current.json`，最后发布工作树内 `.mbot/runs/maintenance.json` 标记。
3. 原生 input marker 绑定 maintenanceId/scope/head/capture/request hash，flush 后才执行模型。output marker 绑定 plan/rawOutput hash 与规范化 token 用量；模型结果再次在持锁 helper 中核验，再持久发布 `planned`。未持久的响应不能由恢复重新猜测或合成。
4. 重验基线、锁和写集，使用同目标目录的确定性临时文件，按原模式写入、fsync、rename、fsync 父目录。私有 Git index 按确切字节生成 blob/tree/commit，绕过 clean filter 对审计字节的改写；先封存 commit intent，再用原 HEAD 的 compare-and-swap 更新 ref，同步普通 index。
5. 本域记忆、报告 `memory/conversations/<id>/<maintenanceId>.dream.json` 和 `DREAMING.json` 同一次提交。报告保存来源、模型选择、请求/输出/计划 hash、原生位置、用量和知识版本前后值；checkpoint 保存 scope、报告 hash 与增量 cursor。每次续读都认证整个链，裸 cursor、删除/回退/人类改写 checkpoint 不会被当作成功消费。
6. 原生 result marker 与 Session flush 完成后才清除维护标记和 journal。去重核验精确终态，不能把已提交改成 aborted。模型失败或提交前取消校验原基线并结算 aborted，不推进候选；应用/提交阶段有歧义时保留现场，通过恢复处理。

维护 journal 为 schema v2 / kind `domain-dream`，旧 compact/sleep 保持 v1。状态位于 `<stateRoot>/maintenance/<workspaceHash>/dream-<uuid>/`，每份快照以内容 hash 命名，外层 `current.json` 指向已落盘阶段。目录/文件按 UID、0700/0600、非软链及父路径核验，helper/Host 都绑定 PID 出生身份和 boot_id。快照 hash 只检查完整性，恢复仍需重建原生/Git 证明和派生写集。

阶段依次为 `prepared → running → planned → applying → committing → committed → settled`；取消经 `aborting → aborted → settled`。工作树标记独立于阶段，普通 Host 模型准入及独立 CLI mutation/run/dream/resume 都拒绝绕过。保留既有 PAUSED；维护本身不改私人故障计数。输入控制帧上限 32 MiB，每次 helper 控制请求期限 60 秒；模型默认 300 秒，helper 另受数据配置 `MBOT_TIMEOUT + 60` 秒总期限约束。

## 中断恢复

通过已有 `/mbot recover [Bot]`、`botctl recover --profile … --bot …` 或可信 Host `recoverTurn` 进入。已有 Agent 继续使用原实例；冷启动调用官方 Session Controller `resolveAgent`，保持原 Session ID、原生日志和 Inbox，不创建替代历史。

- 原 helper 必须退出；Git 子写者仍持锁时拒绝。原 Host 若仍活着，需要同一 Agent cell 保存且已 drain 的捕获证明；跨 Runtime 模块重载保留该证明，不能仅凭 PID 或调用者声称完成就接管。
- 重新认证原域登记、私有路径/版本/阶段、原生来源 cut、上次消费链和模型结果；从已校验计划重新推导报告、checkpoint、每项目标字节/模式与临时路径，逐项比较持久写集。
- `prepared/running` 没有完整计划，恢复只中止。`planned/applying/committing` 有可重验计划且未提交时，复用原计划完成提交，不再调用模型。部分目标文件与已声明临时文件仅可为明确原/新字节或合法前缀；其他差异拒绝并保留，不能覆盖未知写者。
- HEAD 已等于封存 commit 时，验证唯一报告来源、确切文件范围/模式/字节、知识变更和整个消费链，只补普通 index、原生 result/flush 与清理，不重复提交。清理中断按 `settledFrom` 继续。再次恢复返回无需处理。

当前维护只接受已支持的域候选契约。缺失原生日志、未审计回合、旧不支持写者、变更的凭据规则使旧材料无法重验，以及损坏的消费链均拒绝；不编辑 scope 或删除证明来放行。当前消费链验证限 1024 次维护，历史锚点/归档仍需单独设计。未知外来写者不在此 helper 契约内，信任边界仍是同权限可信 Host，不宣称为恶意同进程插件的安全沙箱。

## 验收

原生 Agent 与内部候选桥夹具覆盖来源筛选、固定 Git/原生 cut、预算/脱敏和跨域拒绝，以及真实 `runtime.dream` 的两轮增量、空输入幂等、下一轮知识更新与私人 canary 隔离。模型使用本地 scripted adapter。

维护专项覆盖无效输出、用户取消、Runtime 卸载等待、晚到 Inbox、计划/提交响应丢失、回执 flush 失败、实际 Git 提交前后 SIGKILL、真实部分写入、整个 Host SIGKILL 后冷恢复、孤立 Git 子写者持锁、CLI mutation/resume 拒绝、checkpoint 改写、重新计算 hash 后的派生写集篡改与未知文件修改拒绝。源码/tarball/Git/Web tarball 安装夹具实际调用包内维护服务并验证消费链与重复无模型调用。

这些测试不代表公开域实体、域摘要、sleep/wake 或真实 API 验收完成；公开域仍 reserved。具体通过结果与保留的失败证据见 [发布说明](../RELEASE_NOTE.md)。
