# Cordis 插件集成与验证

当前基线 `dsh-mbot@0.2.0-rc.1`，Linux/WSL、Node 24.9+，实测 DSH `0.2.2-rc.5`。本文件维护插件安装、公开入口、生命周期和验证方式；用户操作见 [README](README.md)，架构/规划见 [DESIGN](DESIGN.md)，版本记录见 [RELEASE_NOTE](RELEASE_NOTE.md)。

## 安装与资源

`dsh plugin` 调用 pnpm；npm 安装的 DSH 不会自动提供它。首次准备命令行安装环境可运行以下命令；已有 DSH 时只补缺失的 pnpm，并确认两者都在 PATH 中：

```bash
npm install --global --ignore-scripts @deepseek-ai/dsh@0.2.2-rc.5 pnpm@12.23.0
```

```bash
npm ci --ignore-scripts
dsh plugin --profile web add "$PWD"

# 或使用发布包
npm pack --pack-destination /tmp
dsh plugin --profile web add /tmp/dsh-mbot-0.2.0-rc.1.tgz
```

`web` 可替换为目标 profile；也可安装远端可见 tag/commit。安装不运行 build/prepare，Host ESM、公开 `.d.ts`、lazy-CJS client、Bash/Node CLI、模板、prompts/patches、运维资源和文档随包分发。需要 Bash、Git、jq、flock、awk、GNU coreutils 和 C.UTF-8；插件不安装系统依赖。

`cordis.patch.yml` 自动插入以下五个入口，共用 DSH/Cordis 服务和 peers：

| 导出/入口 | 职责 |
|---|---|
| `dsh-mbot` | `mbot` 服务、Bot 登记、配置校验、数据事务和受管理子进程 |
| `dsh-mbot/tools` | 原生 botctl 数据工具；受控主 Session 内使用本轮 lease |
| `dsh-mbot/commands` | 人类 `/mbot` 控制命令与 CommandResult |
| `dsh-mbot/runtime` | Agent 闸门、上下文、Worker、恢复与维护生命周期 |
| `dsh-mbot/ipc` | 本地所有者 CLI 的 profile 私有 Unix 端点 |
| `dsh-mbot/client` | 附着 bare 包根行的 DSH 浏览器 half，Host 不导入它 |
| `mbot` / `botctl` bin | 安装到 profile 的 `node_modules/.bin`；保留独立 CLI |

`dsh.client` 声明客户端注入和 external；`dsh.bundle` 声明 patch 与 Linux/WSL 平台。关闭/卸载通过 Cordis effects 释放注册和监听，等待已转交操作；数据仓库保留。已有进程按实际 HMR 路径接管或重启，不能把修改同模块开关当作真实模块替换验证。

## Host、工具与客户端边界

Host 通过官方 ConfigEditor 保存 profile 配置，操作开始时固定 Bot/目录，volatile 更新不重定向在途操作。Web `init/import` 建立原生工作区与主 Session，保留 provisioning/failed 状态供 repair；基础 headless 缺 Controller 时仅登记数据身份。实例与绑定见 [Bot 登记](docs/bot-instances.md)、[主 Session](docs/main-session.md)。

普通原生工具通过 sandboxPolicy/approval 获得配置数据目录的操作许可；模型不能指定任意宿主目录或命令。受管理主 Session 直接使用本轮 lease，Worker 只持任务派生 token。结构化工具不重入 owner IPC/FIFO，`run/tick/dream` 继续有嵌套防护。服务 argv 不经 shell，取消和卸载等待自己的子进程；凭据与许可在返回 Session 前脱敏。

client 复用 DSH 命令事件和聊天视图，在主 Session 展示独立审计/控制卡片；结果默认不进入模型 role content。Plugins 页面已有最小管理面板与打开主 Session 的入口，完整可编辑面板仍在 P2。注册、订阅、重连、开关/卸载和真实渲染须联合验证，见 [反馈](docs/runtime-feedback.md) 与 [管理面板](docs/sleep-wake.md)。

Runtime 不可用时 Agent-owned 闸门继续阻止业务执行；同 Agent 的共享 registry/driver 按 ABI 接管，关闭先等待写者、Git 审计和消息/reply flush。中断恢复使用原生 writer/closers 与持久证据，未知契约拒绝，见 [模块交接](docs/runtime-handoff.md) 与 [恢复](docs/runtime-recovery.md)。

## 回归与安装验收

```bash
npm test
npm run test:install
npm run bench:runtime
```

`npm test` 执行公开类型、串行 Host/Runtime 和 Bash 回归，普通模型请求用本地 scripted adapter。`test:install` 默认遍历四种模式，也可用 `npm run test:install -- source`（或 `tarball`、`git`、`web-tarball`）单独复跑。它先检查 node/npm/dsh/pnpm 和系统工具，再使用真实 DSH installer，在 `/tmp` 隔离 source、tarball、无开发依赖 Git fixture 与 Web tarball，验证元数据、服务/工具/命令、主 Session、事务/恢复/checkpoint、内部域 v4 只读事务与公开拒绝、bin/资源及卸载；不使用真实用户 profile。安装、启动或卸载失败时输出对应日志末尾并保留原退出码，完整日志仍留在产物目录。

`bench:runtime` 测量 100/300/1000 轮恢复、Worker 事件与 ignored 快照；`--quick` 供 CI 冒烟。数据及局限见 [Runtime 架构与基准](docs/runtime-architecture.md)。仓库已配置 `.github/workflows/ci.yml`：Node 24.9.0 / 24 各执行串行回归与四种安装模式，安装任务显式准备 DSH `0.2.2-rc.5` 和 pnpm `12.23.0`，失败保留日志。随包镜像见 [ops/ci.yml.example](ops/ci.yml.example)，兼容范围与发布核对见 [发布检查](docs/plugin-standard-review.md)。R5 基准暂缓，不纳入本次 CI。

## 浏览器验收

Playwright/Chromium 可安装在 `/tmp`，避免修改工程依赖或用户 profile：

```bash
npm install --prefix /tmp/mbot-browser-tools --cache /tmp/mbot-browser-tools/npm-cache --ignore-scripts --no-audit --no-fund playwright
PLAYWRIGHT_BROWSERS_PATH=/tmp/mbot-browser-tools/browsers /tmp/mbot-browser-tools/node_modules/.bin/playwright install chromium --only-shell
export MBOT_PLAYWRIGHT_MODULE=/tmp/mbot-browser-tools/node_modules/playwright/index.mjs
export PLAYWRIGHT_BROWSERS_PATH=/tmp/mbot-browser-tools/browsers
npm run test:gui
```

| 专项 | 验证内容 |
|---|---|
| `test:gui` | tarball 安装、命令反馈、目录保存、多窗口/刷新/重启、无业务模型调用 |
| `test:gui-runtime` | 主 Session、审计/停止、队列、晚到写者及 Worker 崩溃恢复 |
| `test:gui-conversations` | tarball 安装、域预留拒绝、双窗口、刷新/Host 重启、私人主 Session 续聊 |
| `test:gui-compaction` | 原生摘要、Git checkpoint、刷新和维护闸门 |
| `test:gui-handoff` | 实际 Runtime 模块替换、原主 Session 与故障证明保留 |
| `test:gui-migration` | 隔离旧安装包、只读旧回合迁移及同 Session 后续对话 |

恢复的 `/proc` 全进程核验与 Chromium 测试不得并行；新浏览器沙箱进程可能不可读，不能为验收放宽写者检查。

## 真实模型与历史证据

`npm run test:real-plugin` 验证已安装原生工具 → 候选 → 包内 Dreaming；`npm run test:real-compaction` 单独验收真实 DeepSeek 摘要。早期 headless 闭环脚本为 `tests/real-run.sh`、`real-dream.sh`、`real-schedule.sh`、`real-ops.sh`。按脚本约定使用已授权 key，隔离 DSH_HOME/XDG/数据并删除临时凭据；不打印/提交 key。

真实模型、浏览器、合成基准和连续运行观察分别记录，不互相替代。`0.1` 插件/模型样本与 `0.1.1` 命令反馈验收合并在 [历史档案](docs/archive/0.1-acceptance.md)，其中临时产物路径仅是当时记录，清理后需按脚本复跑。
