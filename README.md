# Claudian Plus

[![GitHub stars](https://img.shields.io/github/stars/wuyifan-code/Claudian-plus?style=social)](https://github.com/wuyifan-code/Claudian-plus)
[![GitHub release](https://img.shields.io/github/v/release/wuyifan-code/Claudian-plus)](https://github.com/wuyifan-code/Claudian-plus/releases)
[![License](https://img.shields.io/github/license/wuyifan-code/Claudian-plus)](LICENSE)

> A Codex-first AI workspace for Obsidian.

插件 ID：`Claudian-plus`

基于 [Claudian](https://github.com/YishenTu/claudian) 的增强分支，面向长期使用 Obsidian、Coding Agent 和 AI 工作流的用户。

Claudian Plus 把 Codex、Claude、OpenCode 和 Pi 接入同一个 Obsidian 对话工作区，保留本地优先的笔记上下文、Provider 原生会话与编辑能力，并逐步补齐历史检索、RAG 和知识洞察。

![Claudian Plus preview](assets/Preview.png)

## 为什么做 Plus

Claudian Plus 的优先级不是再做一个聊天窗口，而是让 Agent 真正成为 Obsidian 知识库里的工作入口：

- Codex 是默认 Agent，优先适配 `gpt-5.6-sol`，同时允许动态发现和自定义模型。
- 对话上下文和笔记上下文在同一处管理，减少在 Obsidian、终端和浏览器之间来回切换。
- Agent 的思考和工具执行过程默认收起，主内容保持清晰；需要时仍可展开查看细节。
- 对话悬浮大纲只提取用户问题和助手正文标题，保持一条一条的导航标记，不把 Thought 或工具标题混进大纲。
- 先保留 Provider 原生能力，再在上层补齐跨 Provider 的历史、检索和洞察体验。

## 当前状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Codex-first 默认体验 | ✅ 已实现 | 新安装默认启用 Codex，并选择 Codex 作为设置和空白对话的 Provider。 |
| GPT-5.6 模型偏好 | ✅ 已实现 | 偏好 `gpt-5.6-sol`；如果运行时没有返回该模型，会回退到发现的模型或自定义模型。 |
| Codex 悬浮对话大纲 | ✅ 已实现 | 支持用户问题、助手 H1–H3 标题、悬浮预览、键盘操作、当前位置追踪和点击跳转。 |
| 执行过程降噪 | ✅ 已实现 | Thought / 工具过程默认折叠为低干扰的执行详情，不参与大纲索引。 |
| 多 Provider 工作区 | ✅ 已实现 | Codex、Claude、OpenCode、Pi 共用对话工作区和 Provider 选择器。 |
| `@file`、`@folder`、Slash Commands、Skills、MCP | ✅ 已实现 | 继续沿用上游 Claudian 的上下文和 Agent 扩展方式。 |
| 多标签页、历史会话、行内编辑 | ✅ 已实现 | 保留上游的聊天和编辑工作流。 |
| 拖拽笔记和文件夹 | ✅ MVP 已实现 | 从 Obsidian 或文件管理器拖入输入区，自动识别 Vault 内的笔记/文件夹，插入 `@path` / `@folder/` 上下文。 |
| 历史聊天检索 | ✅ MVP 已实现 | 历史下拉框支持按标题、首条消息预览和 Provider 搜索；全文索引与日期/模型筛选留待下一迭代。 |
| 混合 RAG / 语义检索 | ✅ 本地 MVP 已实现 | `/vault-search` 使用词法匹配、标题/路径、链接和近期修改时间加权，结果保留来源和命中词；尚未接入远程 embedding。 |
| 类 flomo 洞察 | ✅ 可追溯入口已实现 | `/insight` 基于本地来源生成带 `[n]` 引用的 Agent 提示，可一键交给当前 Agent；自动聚类和定时洞察留待下一迭代。 |

### 今日规划的落地边界

这一版先把四条链路做成可用闭环：入口、来源、上下文和失败提示都在本地完成，不会偷偷上传 Vault 内容，也不会改写已有会话数据。下一阶段再接入全文历史索引、真正的向量 embedding、重排器、主题聚类和定时洞察任务。

可用入口：

- 在聊天输入框输入 `/vault-search 关键词`，查看带路径、标题和摘录的来源卡片。
- 输入 `/insight 主题`，确认来源后点击 **Ask agent for an insight**，把带引用的分析任务送入当前 Agent。
- 将 Vault 笔记或文件夹拖到输入区；文件会进入现有文件上下文，文件夹会插入可继续编辑的 `@folder/` 句柄。
- 打开历史下拉框后直接在搜索框输入标题、首条消息片段或 Provider。

详细路线图见 [ENHANCEMENTS.md](ENHANCEMENTS.md)。

## 安装

### 从 Release 安装

Claudian Plus 目前未上架 Obsidian Community Plugins。

1. 从 [最新 Release](https://github.com/wuyifan-code/Claudian-plus/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在 Obsidian 库中创建目录 `.obsidian/plugins/Claudian-plus/`。
3. 将三个文件放入该目录。
4. 打开 Obsidian 设置 → 第三方插件，启用 **Claudian Plus**。

### 从源码安装

需要 Node.js 24。

```bash
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/wuyifan-code/Claudian-plus.git
cd Claudian-plus
npm install
npm run build
```

如果希望构建后自动复制到某个 Vault，可以设置 `OBSIDIAN_VAULT`：

```bash
# macOS / Linux
OBSIDIAN_VAULT="/path/to/vault" npm run build

# Windows PowerShell
$env:OBSIDIAN_VAULT = "D:\Obsidian\My Vault"
npm run build
```

也可以在仓库根目录创建 `.env.local`：

```dotenv
OBSIDIAN_VAULT=D:\Obsidian\My Vault
```

## 首次配置

1. 安装并登录 [Codex CLI](https://github.com/openai/codex)，确保 `codex` 能在终端中运行。
2. 在 Obsidian 中启用 Claudian Plus。
3. 打开插件设置，确认 Provider 为 **Codex**。
4. 在 Codex 设置中发现模型；如果环境中存在 `gpt-5.6-sol`，它会作为首选模型使用。
5. 根据任务选择权限模式：新安装默认为 `normal`，需要完全自动执行时再手动选择 `YOLO`。

Claude、OpenCode 和 Pi 需要各自的 CLI、登录状态或 Provider 配置；它们不会因为启用 Claudian Plus 就自动获得认证。

## 权限与数据安全

- 新安装默认使用 `normal` 权限模式，不会默认给 Agent 机器级免确认权限。
- 现有 Vault 的设置、会话和登录状态不会被静默迁移或覆盖。
- Provider 环境指纹只用于检测配置变化，API Key 和 URL 不会以明文写入指纹。
- 插件不包含遥测；网络请求来自你主动使用的 Provider、MCP 服务或对应 SDK / CLI。
- Claudian Plus 与官方 Claudian 目前不要在同一个 Vault 中同时启用：两者仍可能共享 `.claudian/` 数据和 Provider 原生会话目录。

常见数据位置包括：

```text
.claudian/                         共享设置与会话元数据
.claude/                           Claude Code 项目配置、命令、Skills 和 Agents
.codex/                            Codex Vault Skills 与 Agents
.opencode/                         OpenCode Agents
.pi/                               Pi Vault 会话
~/.claude/projects/                Claude 原生会话
~/.codex/sessions/                 Codex 原生会话
```

## 开发与验证

```bash
npm run dev          # 监听源码并生成开发构建
npm run build        # 生成生产构建
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint
npm run test         # 完整测试
npm run test:unit    # Jest 单元测试
npm run test:watch   # 监听测试
```

提交改动前建议至少运行：

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## 上游与许可证

Claudian Plus 基于 [YishenTu/claudian](https://github.com/YishenTu/claudian) 及其贡献者的公开代码、架构和文档开发。上游项目仍是重要的同步来源，感谢所有贡献者。

本项目依据 [MIT License](LICENSE) 发布。
