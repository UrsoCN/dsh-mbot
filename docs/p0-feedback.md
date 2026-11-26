# 0.1.1 命令反馈与目录选择验收

2026-11-27，Linux、Node 22.23.2、DSH 0.2.2-rc.5、Playwright Chromium headless。

## 根因与修复

真实 Web profile 中 init 已创建仓库，commands.execute 也已写入 command/run、command/done，但新会话仍显示 Hero 空白页。DSH 的 chatViewDefinition.isActive 排除普通 command 节点，DefaultConversationViews 因此不挂载聊天视图；不是 Bash 缺少 stdout。

plugin/client.js 是附着 bare dsh-mbot 根行的 lazy-CJS factory；独立 MBot 活动 target 使已有命令事件激活 Conversation。DSH 原生 Chat 持有唯一结果卡片，支持运行态、错误、展开、多窗口与历史重放。不修改 DSH 核心，不注入模型消息。

MBotService.initialize 串行初始化，从随包 Bash 的固定 Initialized 输出捕获实际目录，通过官方 ConfigEditor 保存所属 profile 行。Cordis fiber 可能经追踪代理包装，按稳定 uid 匹配归属。保存前检查原 workspace 值，保留并发的新配置；ConfigEditor 负责锁、校验、原子写入和 Loader reconciliation，volatile 更新保留服务。

没有 profile-owned 配置入口时创建前报错；创建失败保留旧选择，仓库创建后保存失败明确显示部分成功及恢复方式。独立 CLI init 继续只初始化数据，不读取 DSH profile。

## 验收

- npm test：公开类型、16 项 Cordis、原有 64 组 Bash 检查通过，包括真实 commands.execute 生命周期/无模型 surface、运行中取消的持久错误、并发初始化/配置编辑及保存失败。
- npm run test:install：source、tarball、无开发依赖 Git fixture 的安装/元数据/激活/工具/命令/schema/bin/卸载通过；client 与公开声明入包。证据：/tmp/mbot-plugin-install.5mj8eA。
- npm run test:gui：tarball 安装、独立 Web Host 和 Chromium，中文/空格 init → status、已存在目录/未知命令错误、空闲 tick、锁忙/PAUSED/dream、展开正文、多标签页、刷新、Host 重启与再次 status 通过。事件记录无 user/message、assistant/message、turn/start 或模型请求。证据：/tmp/mbot-gui-test.gc7V3o，含 commands.png、restart.png、events.jsonl。

取消按 DSH AbortSignal/RPC 语义保存 error 命令事件，本版未添加专属取消按钮。Bot 实例、主 Session、管理面板尚未实现；不将第零天写成连续 7 天观察。

## 复跑

测试的 DSH cwd、DSH_HOME、XDG、Corepack、缓存、数据和浏览器产物均在 /tmp，不读取真实 profile 或工程 .env，无需 key。

```bash
npm install --prefix /tmp/mbot-browser-tools --cache /tmp/mbot-browser-tools/npm-cache --ignore-scripts --no-audit --no-fund playwright
PLAYWRIGHT_BROWSERS_PATH=/tmp/mbot-browser-tools/browsers /tmp/mbot-browser-tools/node_modules/.bin/playwright install chromium --only-shell
MBOT_PLAYWRIGHT_MODULE=/tmp/mbot-browser-tools/node_modules/playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=/tmp/mbot-browser-tools/browsers npm run test:gui
```
