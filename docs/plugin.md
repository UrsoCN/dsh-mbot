# Cordis 插件安装与验收

2026-11-26，Linux，Node `22.23.2`，DSH `0.2.2-rc.5`。包 `dsh-mbot@0.1.0` 已成为可安装的 DSH bundle；Bash 核心和独立数据仓库保持原事务、护栏和 Git 审计行为。

本文件保留 0.1 的 Host/安装/模型验收记录。0.1.1 已修复聊天区反馈并保存目录选择，新安装/浏览器依据见 [P0 验收](p0-feedback.md)；volatile schema 不代表自有设置面板已交付。当前也未自动登记 DSH 工作区或绑定主 Session，下一轮范围见 [TODO](../TODO.md) 与 [发布说明](RELEASE_NOTE.md)。

## 安装

从源码目录：

```bash
npm ci --ignore-scripts
dsh plugin --profile web add "$PWD"
```

从完整包：

```bash
npm pack --pack-destination /tmp
dsh plugin --profile web add /tmp/dsh-mbot-0.1.0.tgz
```

Git 远端包含该提交后可用 `github:UrsoCN/dsh-mbot#<commit>`；ESM 代码、声明和全部运行资源随源码分发，不依赖安装时编译或 prepare 授权。本次准备本地提交和完整 tarball，未发布 npm、未推送 Git 远端。

插件只支持 Linux/WSL 的本地执行环境；需要 Bash、GNU coreutils、Git、flock、jq、awk、C.UTF-8 与 Node 22+。凭据放 DSH_HOME/.env。安装按指定 profile 保存 bundle；不会初始化数据、安装 cron 或修改全局 PATH。已有进程按 profile 的 HMR 能力生效，或重启 DSH。

0.1 没有自有设置面板；workspace 可在 profile 的 cordis.patch.yml 中用 id: mbot 的 config 指定（见 [README](../README.md#工作区与配置)）。Host 字段为 volatile；后续操作取新值，在途操作保留开始时的目录。CLI bin 保留 -C 与原有配置来源，不直接读 profile YAML。命令 handler 已接入，实际聊天区反馈尚待修复。

## 结构与行为

| 资源 | 作用 |
|---|---|
| package.json | dsh.bundle、版本/平台、peer 共享、公开 ESM/.d.ts 与 mbot/botctl bin |
| cordis.patch.yml | 插入 mbot、tool-mbot、command-mbot 三行 |
| plugin/index.js | Cordis mbot 服务与 volatile Config；通过 DSH subprocess provider 启动固定脚本 |
| plugin/tools.js | 原生 botctl；结构化任务/候选操作；sandboxPolicy 与 approveEscalation |
| plugin/commands.js | 人类 /mbot 控制命令；命令不送模型，不按 shell 解析 |
| templates/workspace/gitignore | init 生成 .gitignore，避免 npm 省略模板 dotfile |
| lib/bin/prompts/patches/ops | 原有事务、调度、报告、护栏与运维实现，完整入包 |

原生工具的所有操作需要 danger-full-access 或一次 DSH 审批，因为修改的是宿主配置的数据仓库；拒绝发生在执行脚本之前。模型不能选择任意目录，不能调用 run/dream、直接写 MEMORY 或修改长期规则。受 mbot 管理的运行继续用 Bash botctl，由现有宿主护栏验收；原生工具和人类命令拒绝运行内绕过。

服务每次捕获 workspace，argv 不经过 shell；传递 AbortSignal，返回脱敏输出，卸载时终止并等待自己的子进程。原生工具/人类命令注册由 Cordis effect 释放。卸载 bundle 后数据仓库保留，服务和入口不再可用。

## 测试

```bash
npm test
npm run test:install
npm run test:real-plugin
```

公开类型检查、11 项 Cordis 检查与原有 64 组 Bash 检查通过。原生检查覆盖实际工具 pipeline、任务与候选事务、拒绝/一次审批、schema 与参数边界、literal argv、运行内禁止、slash commands、Loader volatile 更新、卸载清理、取消传播与 secret 脱敏（含用户配置选择工作区）。

安装验收使用真实 `dsh plugin add`，在 `/tmp/mbot-plugin-install.Glqpfj` 隔离验证 tarball 和源码两种方式。两者都自动进入 profile bundle 列表，实际加载服务、原生工具和 `/mbot` 命令，创建并提交 001，lint/工作树检查通过，workspace 出现在 volatile schema，profile .bin 可执行；remove 后 bundle 不再启用，数据仓库仍完整。该测试不调用模型，包管理器访问 registry。

## 真实模型验收

独立环境 `/tmp/mbot-real-plugin.Aqd4B6`，数据仓库为 ws，模型从 consumer 项目运行。安装包被真正添加到 headless profile；凭据仅在临时 DSH_HOME/.env，结束删除；没有修改用户 profile。

模型只使用以下三个原生调用，未使用 Bash、文件工具或 Git：

```text
botctl(action=board_add, text=插件原生安装验收, owner=chief)
botctl(action=remember, text=以后周报一律用中文, as=chief, task_id=001)
botctl(action=board_show)
```

这一步 MEMORY 与初始内容相同。随后调用安装包的 profile .bin/mbot dream，规则进入共享 MEMORY，报告 success=true、violations=[]，lint 通过且工作树干净：

```text
3326029 dream: 20261126T143355Z-dream-6292 …
d48e974 human: remember (chief)
7332875 human: board add 001 插件原生安装验收
d059845 human: init
```

安装后的 dream 调用耗时 19,610 ms，顶层 token 72,078（缓存读 65,280）。这是单次插件功能验收，不代替 M5 连续 7 天观察。
