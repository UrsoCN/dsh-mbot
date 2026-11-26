# 发布说明

## 0.1.1（2026-11-27）

- 修复只执行过 /mbot 命令的新会话没有结果：最小浏览器入口激活聊天视图，复用 DSH 原生命令卡片，支持状态、展开、重放与多窗口同步，不写入模型上下文。
- 插件 init 成功后通过 ConfigEditor 保存实际目录，后续命令/原生工具与重启使用同一选择；串行初始化，保留并发的新配置。失败保留旧选择，创建后保存失败明确报告部分成功。
- 类型、16 项 Cordis、64 组 Bash 检查通过；source/tarball/Git 安装通过；真实 Chromium 验证中文/空格目录、错误、锁忙/PAUSED/空闲、展开、多标签页、刷新/重启及无模型调用。依据与复跑见 [P0 验收](p0-feedback.md)。

CLI init 行为兼容；Bot 实例、DSH 工作区自动登记、受管理主 Session 和自有设置面板仍待 0.2.0。client factory 随包分发，无安装时构建。原有 v0.1.0 标签保留。下文的限制按对应历史版本理解。

## 0.1（npm 包版本 0.1.0）

2026-11-26，首个可运行的 DeepSeek Harness/Cordis Host 插件版本，主要功能实现于 d1bd4e6。本文件将原 TODO 已完成项目收拢为能力与验收摘要；后续见 [TODO](../TODO.md)。发布标签以作者选定提交及 Git refs 为准，不强制固定到该实现提交。

文档整理日期：2026-11-27。以下功能以现有 0.1 代码为基线；新反馈与后续规划尚未作为功能实现发布。

### 已交付

| 阶段 | 完成内容 | 验收依据 |
|---|---|---|
| M0：行为核实 | headless 凭据、NDJSON、权限、AGENTS、环境继承、Worker 并发/深度、中断、模型覆盖 | [M0](m0-spike.md) |
| M1：数据与工具 | 独立 Git 模板、配置解析、安装入口、botctl 看板/任务/候选、预算/链接 lint、锁与回滚 | README、离线集成检查 |
| M2：运行闭环 | run、脱敏 transcript/meta、归属护栏、inbox 前缀保护、暂停/熔断、统一 Git 审计 | [M2](m2-run.md) |
| M3：记忆闭环 | 独立 Dreaming、逐文件删除依据、失败恢复、完整行预算、checkpoint/pending 续读、revert | [M3](m3-dream.md) |
| M4：星型调度 | Chief 持久派活、两 fresh Worker 并发、中断/blocked、tick、原样归档、物理 grants | [M4](m4-schedule.md) |
| M5：运维工具 | cron 示例、私有日志、可选备份、clone 冷启动、PAUSED/resume/revert 演练、人工快照 | [第零天](m5-ops.md)，7 天未完成 |
| Cordis 插件化 | bundle、ESM 服务/公开类型、原生 botctl、/mbot handler、volatile schema、进程清理、完整资源与双 bin | [插件验收](plugin.md) |

Markdown/Git 保存任务与长期记忆；工作 Bot 只读记忆，remember 投递候选，Dreaming 独立整理。源码和 tarball 可用 dsh plugin add 安装；卸载保留数据仓库。不依赖安装时编译，不自动部署生产 cron。

### 兼容与验证

- 实测 Linux、Node 22.23.2、DSH 0.2.2-rc.5；支持 Linux/WSL 的本地环境，需要 Bash、Git、jq、flock、awk、GNU coreutils、C.UTF-8。
- 公开类型、11 项 Cordis、64 组 Bash 检查通过；两种真实安装覆盖激活、工具/命令 handler、schema、bin、卸载。
- 真实模型验证任务/候选 → Dreaming → 后续冷启动 → revert，Worker 并发/中断，以及从另一项目调用包内原生工具和 Dreaming。
- 凭据、node_modules、运行产物不入包；原始日志忽略且私有，入库审计与返回结果脱敏。

这些证据覆盖 Host、事务、安装和模型行为，不等价于完整 Web/本地聊天界面验收。

### 已知限制与安装后反馈

1. 用户报告 /mbot init <path> 创建成功，但聊天区看不到结果，status 也没有提示。Host 返回文本，UI 链待定位修复。
2. 显式 init 路径不自动成为后续选择；当前只建 Git 数据仓库，不登记 DSH 工作区或持久主 Session。run/tick/dream 每次新建 headless 会话。
3. 有 volatile workspace Config schema，尚无自有设置/管理面板、实例列表或浏览器入口。旧文档对“设置页已实现”的描述过宽，现已纠正。
4. chief/coder 是仓库内角色，多 Bot 实例登记/会话绑定/迁移未实现；7 天连续调度观察待完成。

当前可靠入口是 CLI、原生工具与手工 profile patch；界面缺陷优先修于 0.1.1。实例、主 Session、管理面板规划为 0.2.0；主 Session 业务执行必须接入等价审计护栏。

### 发布与后续维护

0.1 是首版名称，0.1.0 是 package.json 版本；Git 分支与发布 tag 必须区分，新 tag 推荐 v0.1.0。Git 安装以远端可见 tag/commit 为准，GitHub Release/Actions 不是安装必需，本说明不宣称已完成 npm 发布。

后续在这里记录变更、迁移、验收、限制；已完成工作从 TODO 移入相应版本。维护者遵循根 [AGENTS](../AGENTS.md)，运行 Chief/Worker 遵循数据仓库协议。

## 0.1.1 附带：规范优化（2026-11-27）

- 修复中英文 locale 为 DSH 使用的 meta.title/meta.description，实际插件管理器读取通过。
- 安装验收增加无开发依赖的 Git fixture；源码链接、Git、tarball 三种方式均验证元数据、激活、工具/命令、schema、bin 与卸载。
- 纠正把 0.1 分支当 tag、把发布标签永久锁定到实现提交的说明；最新复查已有作者推送的 v0.1.0 → 27cb31c。使用完整版本 tag 的建议见 [发布检查](plugin-standard-review.md)；本轮优化未自动并入已有标签或另作发布。

## 设计更新：受管理的主 Session（未实现）

将“只读入口”的过渡方案明确为插件管理上下文的真实交互 Session；规定统一 botctl 门面、DSH Inbox/执行边界、对话域隔离、运行内工具通道、多窗口并发、跨 Bot 异步消息与 compact/睡眠 checkpoint。见 [Session Runtime](session-runtime.md)；本轮只更新设计与 TODO，不宣称新增运行能力。
