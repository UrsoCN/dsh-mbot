# 插件发布与兼容检查

当前包版本 `0.2.0-rc.1`，已有完整版本标签 `v0.1.0`、`v0.1.1`、`v0.2.0-rc.1`。本文件维护发布核对流程，安装与验证入口见根 [PLUGIN](../PLUGIN.md)，已交付版本见 [RELEASE_NOTE](../RELEASE_NOTE.md)。不移动既有标签，不将本地提交、Git tag、GitHub Release 与 npm 发布混为一项。

## 包与入口

| 核对项 | 当前约定 |
|---|---|
| 版本 | package.json 与 lock 一致，有效 SemVer；tag 使用对应完整版本 |
| 共享依赖 | Host 不导入 client；DSH/Cordis 服务使用 peers，与实际 SDK 类型/源码一起验证 |
| bundle | 五个入口：mbot、tools、commands、runtime、ipc；bare 包根行附着 client |
| client | `dsh.client`、`./client` 与 lazy-CJS factory 随包，无安装时 build/prepare；已有最小 Plugins 面板 |
| 资源 | 双 bin 及执行权限、plugin/类型、lib/templates/prompts/patches/ops/cron/locale、根核心文档与 docs |
| 隔离 | key/.env、node_modules、临时日志/tarball 不入包；测试不使用用户真实 profile |

每次移动根文档或修改 files/export/资源后检查 `npm pack`，防止 README 或模块链接在安装包里失效。schema、handler 和组件通过不等于实际 Plugins/聊天区/重连/卸载验收；完整可编辑面板仍在 P2。

## 发布核对顺序

1. 明确发布范围，对照 DESIGN/TODO/RELEASE_NOTE 与实际代码；提交并检查干净工作树，不把待办写成已实现。
2. 核对 package/lock/公开声明、bundle/patch、平台与依赖矩阵；按变更执行 `npm test`、`npm run test:install`，必要时补对应真实 GUI/API 专项。
3. 在 `/tmp` 生成并检查包，确认必需文档/模板/可执行脚本齐全、无凭据或开发产物；安装源码链接、tarball、无开发依赖 Git fixture 和 Web tarball。
4. 核对 `refs/heads` 与 `refs/tags`，仅为尚不存在且已获授权的版本创建/推送完整 tag。已有 rc.1 不需为文档整理移动标签。
5. 根据实际授权发布到目标渠道；Git 远端可见的 tag/commit 已可用于 DSH 安装，GitHub Release 附件和 npm 发布各自独立记录。

```bash
git status --short
git tag --sort=-version:refname
npm pack --ignore-scripts --pack-destination /tmp
```

安装规范以 DSH 对应版本随包文档/类型为准。现有基线来自本机 `0.2.2-rc.5` 的发布教程、manifest/package-meta 与真实 installer；旧版标签安装证据保留在 [历史档案](archive/0.1-acceptance.md)。其他版本需重新核对。

## 兼容范围与 CI

`engines.dsh` 当前为 `>=0.2.2-rc.5 <0.3.0`，DSH peers 固定 `0.2.2-rc.5`，实测也集中在该版本。声明范围不等于每个版本已经验证；扩大支持前补矩阵，必要时收窄范围。Linux/WSL、Node 22+ 与 GNU/Bash 工具依赖继续保留。

[ops/ci.yml.example](../ops/ci.yml.example) 已提供类型、Bash、串行 Host/Runtime、包资源和快速性能基准模板，仓库尚未启用 `.github/workflows`。启用时确认目标仓库的 workflow 写权限，并补安装矩阵；真实模型与浏览器作为专项，避免恢复全进程检查与 Chromium 并行。

可选 Release Action 在授权 tag/手动触发后验证版本、测试和打包，再上传 tgz/校验和；不隐含 npm 发布或外部推送授权。新增 client 构建链时重新验收 Git/source/tarball 与脚本授权，不为当前纯 JS 入口增加空 build 步骤。
