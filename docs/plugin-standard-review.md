# DSH 插件规范与发布检查

2026-11-27，依据本机 DSH 0.2.2-rc.5 随包的发布教程、插件索引文档、package-meta 读取代码与 manifest 类型检查。官方参考：[打包与安装](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)、[插件索引](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/plugin-market.md)。其他 DSH 版本应核对对应 API/声明。

## 1. Tag、分支与 GitHub Release

0.1.0 发布核对时：本地与 origin 都已有 refs/tags/v0.1.0，指向 27cb31c，与 package.version=0.1.0 对应，符合推荐命名。此前看到的 refs/heads/0.1 是分支，已与真正的 tag 区分。此处是检查时快照，后续以实际 Git refs 为准，不把标签指向写死在设计文档。locale/测试优化及命令反馈随 0.1.1 分发，不移动原标签。

任意合法 Git tag（包括 0.1）可以供 dsh plugin add 显式安装，GitHub Release/Actions 不是必需项。不过官方索引生成器从 Git 仓库识别历史版本时查找 vX.Y.Z、X.Y.Z 和包名@X.Y.Z；0.1 不在完整版本命名规则中。当前 package.version 是 0.1.1，新发布使用 v0.1.1；下面保留 0.1.0 的标签核对示例。

完成要发布的提交后，可用以下步骤创建真正的 tag（仅适用于 tag 尚不存在的版本，已有 v0.1.0 不必重复创建；本次检查没有执行）。Annotated tag 便于附发布说明，lightweight tag 也能被 DSH 安装/索引识别：

```bash
git tag -a v0.1.0 -m "dsh-mbot 0.1.0"
git push origin v0.1.0
dsh plugin --profile web add github:UrsoCN/dsh-mbot#v0.1.0
```

仅 push 分支不会上传 tag。安装 #0.1 若解析为分支会随分支移动；版本记录/索引用完整 commit SHA 更易复现。DSH 的 Git 更新机制对保存为完整 SHA 的 spec 有支持，直接保存 branch/tag 的安装与可从 GUI 更新是不同能力。

## 2. 当前合规情况

| 项目 | 结果 |
|---|---|
| npm 包身份与版本 | dsh-mbot@0.1.1，有效 SemVer、ESM、公开类型 |
| dsh.bundle 与 patch | 三个入口均按包名引用，能自动激活 |
| Cordis 入口 | apply/name/Config/inject、服务与 effects 清理已接入 |
| 平台与兼容声明 | Node 22+、Linux/WSL、engines.dsh 与 peer 声明存在 |
| 运行资源 | bin/lib/template/prompts/patches/ops、README/LICENSE/文档都入包，脚本有执行权限 |
| Git 安装 | JS 入口随源码提交，当前无需 build/prepare 或安装时脚本授权 |
| 展示元数据 | 已修复为 locale 的 meta.title/meta.description；DSH 实际读取中英文字段通过 |
| UI/client | 0.1.1 已有 dsh.client/./client 与最小 lazy-CJS factory；真实命令聊天区通过，自有面板尚未交付 |

已有引导文档、原生权限检查与类型验收不代替真实聊天区/面板验收；0.1.1 的命令反馈已通过真实浏览器验收；主 Session/面板仍按 TODO 推进，依据见 [P0 验收](p0-feedback.md)。

## 3. 已做的优化与验证

- 修复 locale/en.json、zh.json 的展示字段层级；此前顶层 title/description 会被 DSH 的 meta 读取逻辑忽略。
- 安装验收从源码链接/tarball 扩展到 Git 仓库 fixture。Git fixture 从发布包生成并提交，无开发目录 node_modules，验证当前代码能直接以 Git 安装。
- 三条路径均通过真实 dsh plugin add、激活、原生工具/命令、schema、bin、DSH 插件元数据与卸载验证；没有调用模型或修改用户 profile。
- 公开类型检查和发布包检查通过。记录目录：/tmp/mbot-plugin-install.EV08Gp；本次未推送分支/tag 或发布 npm/GitHub Release。
- 直接以 github:UrsoCN/dsh-mbot#v0.1.0 在隔离 profile 安装成功，bundle 自动启用，dump-config 通过，记录在 /tmp/mbot-published-tag.9w7cj_4v。此安装使用 GitHub tag 源码，不依赖 Release 附件或本仓库的 Actions。

## 4. 推荐的后续优化

1. **兼容范围与测试对齐**：当前 engines.dsh 接受较宽的 0.2 系列稳定版本，但 DSH peers 固定 0.2.2-rc.5，实际只验证了该版本。收窄声明或补兼容矩阵，再扩大支持；语法合规不等于整个范围已验证。
2. **CI**：push/PR 运行 npm ci、npm test、npm run test:install 和包资源检查，使用已测 DSH/Node。自动验证不需要 API key；真实模型验收单独运行。
3. **可选 Release Action**：监听完整版本 tag 或手动触发，校验 tag 去掉 v 后等于 package.version，测试后 npm pack，再上传 tgz/校验和到 GitHub Release。此路径不需要 npm 发布；若未来发布 npm，再单独配置该步骤。
4. **client 构建**：后续新增面板时，必须把 DSH 可加载的 client bundle 放进包。Git 安装若依赖 prepare 构建需遵守 pnpm 脚本授权；也可分发已构建的 tarball。当前纯 JS Host 入口不需要补空 build 脚本。
5. **可选目录展示**：author、bugs URL、icon 与自定义插件索引有助于发现/展示，但不阻止当前安装，也不代替面板的 dsh.client 实现。

推荐先落地 CI，再决定是否需要自动创建 GitHub Release；使用 Git ref 安装时，只要源码、运行入口、依赖和 tag 已在远端可见即可。
