# 独立域 Dreaming

默认私人 Dreaming 见 [记忆模块](memory.md)，域候选来源见 [conversation](conversations.md#域候选事务)。本文维护额外对话域的取材、写集和维护设计。

开发分支目前交付了**输入捕获、无工具请求构造与修改建议校验**。它们是内部模块，不提供执行命令，不调用模型、不写记忆，也不持久推进消费进度。域仍为 `reserved`；模型执行、维护事务、失败回滚、恢复、摘要与 sleep/wake 接线仍在 [TODO](../TODO.md)。

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

`plugin/domain-dream-plan.js` 构造独立的 system/user 两条消息，辅助 purpose 为 `mbot-domain-dream`（在官方类型中声明为辅助用途）。只透传 provider/model/maxTokens，不继承 Agent 历史、工具、父请求扩展字段。当前仅构造请求，尚未执行模型。

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

## 待接入的持久维护事务

以下是下一阶段实现要求，尚无公开 API 或持久格式承诺：

1. 先取得 BotCoordinator 屏障，排空该 Bot 全部 Agent/工具/转交操作，再持有 Bot 数据锁。核验干净工作树、锁身份、原 HEAD、无待结算 turn/其他维护；重验持久域归属，固定真实原生 cut 并 flush。
2. 工作树外的私有状态保存版本化维护 journal、原文件/ignored 基线、捕获输入和旧消费 checkpoint。按 UID、0700/0600、非软链祖先、PID 出生身份与 boot_id 校验，原子写并 fsync 后才发布阶段。
3. 记录模型请求身份/hash 后执行独立无工具请求。仅接受正常结束的文本响应，关联 AbortSignal 与 Runtime drain；先持久保存通过校验的完整结果，再进入应用阶段。恢复不能重调已保存结果对应的模型。
4. 应用时复验原 HEAD、全部写集及保护范围，再写本域记忆、报告和消费 checkpoint；同一次 Git 提交封存来源 cut、capture/plan/request/output hash、前后知识版本和明确 commit intent。defer/reject 决定随报告保存。失败不能仅推进 cursor；保护范围外变更不得通过，不能用覆盖未知写者来假装回滚成功。
5. 提交前/后崩溃分别核验原现场与确切 Git 审计；已提交但未回执只补结算与原生 flush，不重复提交/模型调用。未知写者、缺日志/私有证据、旧不支持契约继续拒绝并保留现场。

域摘要和 sleep/wake 将使用同一 scope、知识版本和消费 checkpoint，退役旧域摘要；私人维护不得读取域候选。完成持久恢复、取消、重载、Host 崩溃、跨域与安装验收后，再开放额外域实体和公开准入。维护的信任边界仍是同权限可信 Host，不宣称为恶意同进程插件的安全沙箱。

## 验收

原生 Agent 与内部数据桥夹具已覆盖固定资料/原始审计、增量预算边界、cursor 篡改、缺失/乱序/跨域日志、待结算 journal、失败/取消候选、当前凭据脱敏、共享和敏感文件只读、Git replace 拒绝替换来源，以及逐行来源/删除/链接/预算拒绝。取材和计划校验后 Git 与工作树保持原状。

这些验收不代表域 Dreaming 已能运行或提交。实际结果见 [发布说明](../RELEASE_NOTE.md)，维护接线完成后另补模型调用、持久结果复用与故障恢复验收。
