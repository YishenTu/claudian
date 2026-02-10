# Claudian

![GitHub stars](https://img.shields.io/github/stars/YishenTu/claudian?style=social)
![GitHub release](https://img.shields.io/github/v/release/YishenTu/claudian)
![License](https://img.shields.io/github/license/YishenTu/claudian)

![Preview](Preview.png)

一个将 Claude Code 嵌入 Obsidian 的插件，让 Claude 成为你的 AI 协作伙伴。你的 Vault 即为 Claude 的工作目录，拥有完整的 Agent 能力：文件读写、搜索、Bash 命令执行和多步骤工作流。

## 功能特性

- **完整的 Agent 能力**：利用 Claude Code 的能力在 Obsidian Vault 中读取、写入、编辑文件，搜索内容以及执行 Bash 命令。
- **上下文感知**：自动附加当前聚焦的笔记，通过 `@` 提及其他文件，按标签排除笔记，包含编辑器选中内容（高亮），以及访问外部目录获取额外上下文。
- **视觉支持**：通过拖放、粘贴或输入文件路径发送图片进行分析。
- **内联编辑**：选中文本 + 快捷键，直接在笔记中编辑，支持词级 diff 预览和只读工具访问以获取上下文。
- **指令模式（`#`）**：在聊天输入框中直接添加精炼的自定义指令到系统提示词，支持在弹窗中审查和编辑。
- **斜杠命令**：创建可复用的提示模板，通过 `/command` 触发，支持参数占位符、`@file` 引用和可选的内联 Bash 替换。
- **技能（Skills）**：通过可复用的能力模块扩展 Claudian，基于上下文自动调用，兼容 Claude Code 的技能格式。
- **自定义 Agent**：定义 Claude 可调用的自定义子 Agent，支持工具限制和模型覆盖。
- **Claude Code 插件**：启用通过 CLI 安装的 Claude Code 插件，自动从 `~/.claude/plugins` 发现，支持按 Vault 配置。插件的技能、Agent 和斜杠命令可无缝集成。
- **MCP 支持**：通过 Model Context Protocol 服务器（stdio、SSE、HTTP）连接外部工具和数据源，支持上下文保存模式和 `@` 提及激活。
- **高级模型控制**：运行时自动从 SDK 检测可用模型（支持 `claude-internal` 等定制 CLI），通过环境变量配置自定义模型，精细调节思考预算，以及启用 Sonnet 的 1M 上下文窗口（需要 Max 订阅）。
- **计划模式**：在聊天输入框中通过 Shift+Tab 切换计划模式。Claudian 先探索和设计方案，再提交计划供审批，支持在新会话中批准、在当前会话继续或提供反馈。
- **安全机制**：权限模式（YOLO/Safe/Plan）、安全黑名单以及 Vault 隔离（支持符号链接安全检查）。
- **Chrome 中的 Claude**：通过 `claude-in-chrome` 扩展让 Claude 与 Chrome 交互。

## 环境要求

- 已安装 [Claude Code CLI](https://code.claude.com/docs/en/overview)（强烈推荐通过原生安装方式安装）
- Obsidian v1.8.9+
- Claude 订阅 / API 或支持 Anthropic API 格式的自定义模型提供商（[Openrouter](https://openrouter.ai/docs/guides/guides/claude-code-integration)、[Kimi](https://platform.moonshot.ai/docs/guide/agent-support)、[GLM](https://docs.z.ai/devpack/tool/claude)、[DeepSeek](https://api-docs.deepseek.com/guides/anthropic_api) 等）
- 仅支持桌面端（macOS、Linux、Windows）

## 安装

### 从 GitHub Release 安装（推荐）

1. 从[最新 Release](https://github.com/YishenTu/claudian/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`
2. 在 Vault 的插件文件夹中创建 `claudian` 文件夹：
   ```
   /path/to/vault/.obsidian/plugins/claudian/
   ```
3. 将下载的文件复制到 `claudian` 文件夹中
4. 在 Obsidian 中启用插件：
   - 设置 → 第三方插件 → 启用 "Claudian"

### 使用 BRAT 安装

[BRAT](https://github.com/TfTHacker/obsidian42-brat)（Beta Reviewers Auto-update Tester）允许你直接从 GitHub 安装并自动更新插件。

1. 从 Obsidian 社区插件安装 BRAT 插件
2. 在设置 → 第三方插件中启用 BRAT
3. 打开 BRAT 设置，点击 "Add Beta plugin"
4. 输入仓库 URL：`https://github.com/YishenTu/claudian`
5. 点击 "Add Plugin"，BRAT 将自动安装 Claudian
6. 在设置 → 第三方插件中启用 Claudian

> **提示**：BRAT 会自动检查更新，并在新版本可用时通知你。

### 从源码安装（开发）

1. 将此仓库克隆到 Vault 的插件文件夹：
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/YishenTu/claudian.git
   cd claudian
   ```

2. 安装依赖并构建：
   ```bash
   npm install
   npm run build
   ```

3. 在 Obsidian 中启用插件：
   - 设置 → 第三方插件 → 启用 "Claudian"

### 开发

```bash
# 监听模式
npm run dev

# 生产构建
npm run build
```

> **提示**：复制 `.env.local.example` 为 `.env.local` 或执行 `npm install` 并设置 Vault 路径，以便在开发期间自动复制文件。

## 使用方法

**两种模式：**
1. 点击功能区的机器人图标或使用命令面板打开聊天
2. 选中文本 + 快捷键进行内联编辑

像使用 Claude Code 一样使用——在 Vault 中读取、写入、编辑和搜索文件。

### 上下文

- **文件**：自动附加当前聚焦的笔记；输入 `@` 附加其他文件
- **@-提及下拉框**：输入 `@` 查看 MCP 服务器、Agent、外部上下文和 Vault 文件
  - `@Agents/` 显示可选的自定义 Agent
  - `@mcp-server` 启用上下文保存的 MCP 服务器
  - `@folder/` 过滤来自特定外部上下文的文件（如 `@workspace/`）
  - 默认显示 Vault 文件
- **选中内容**：在编辑器中选中文本后聊天——选中内容会自动包含
- **图片**：拖放、粘贴或输入路径；配置媒体文件夹以支持 `![[image]]` 嵌入
- **外部上下文**：点击工具栏的文件夹图标访问 Vault 外部目录

### 功能详情

- **内联编辑**：选中文本 + 快捷键，直接在笔记中编辑，支持词级 diff 预览
- **指令模式**：输入 `#` 添加精炼的指令到系统提示词
- **斜杠命令**：输入 `/` 使用自定义提示模板或技能
- **技能**：将 `skill/SKILL.md` 文件添加到 `~/.claude/skills/` 或 `{vault}/.claude/skills/`，建议使用 Claude Code 管理技能
- **自定义 Agent**：将 `agent.md` 文件添加到 `~/.claude/agents/`（全局）或 `{vault}/.claude/agents/`（Vault 级）；在聊天中通过 `@Agents/` 选择，或提示 Claudian 调用 Agent
- **Claude Code 插件**：通过设置 → Claude Code 插件启用，建议使用 Claude Code 管理插件
- **MCP**：通过设置 → MCP 服务器添加外部工具；在聊天中使用 `@mcp-server` 激活

## 配置

### 设置项

**个性化**
- **用户名**：你的名字，用于个性化问候
- **排除标签**：阻止笔记自动加载的标签（如 `sensitive`、`private`）
- **媒体文件夹**：配置 Vault 存储附件的位置以支持嵌入图片（如 `attachments`）
- **自定义系统提示词**：附加到默认系统提示词的额外指令（指令模式 `#` 保存在此处）
- **启用自动滚动**：切换流式输出时是否自动滚动到底部（默认：开启）
- **自动生成对话标题**：切换在发送第一条消息后是否自动生成 AI 标题
- **标题生成模型**：用于自动生成对话标题的模型（默认：Auto/Haiku）
- **Vim 风格导航映射**：配置按键绑定，如 `map w scrollUp`、`map s scrollDown`、`map i focusInput`

**快捷键**
- **内联编辑快捷键**：触发选中文本内联编辑的快捷键
- **打开聊天快捷键**：打开聊天侧边栏的快捷键

**斜杠命令**
- 创建/编辑/导入/导出自定义 `/commands`（可选覆盖模型和允许的工具）

**MCP 服务器**
- 添加/编辑/验证/删除 MCP 服务器配置，支持上下文保存模式

**Claude Code 插件**
- 启用/禁用从 `~/.claude/plugins` 发现的 Claude Code 插件
- 用户级插件在所有 Vault 中可用；项目级插件仅在匹配的 Vault 中可用

**安全**
- **加载用户 Claude 设置**：加载 `~/.claude/settings.json`（用户的 Claude Code 权限规则可能绕过 Safe 模式）
- **启用命令黑名单**：阻止危险的 Bash 命令（默认：开启）
- **阻止的命令**：要阻止的模式（支持正则、平台特定）
- **允许的导出路径**：Vault 外部可导出文件的路径（默认：`~/Desktop`、`~/Downloads`）。支持 `~`、`$VAR`、`${VAR}` 和 `%VAR%`（Windows）。

**环境变量**
- **自定义变量**：Claude SDK 的环境变量（KEY=VALUE 格式，支持 `export ` 前缀）
- **环境片段**：保存和恢复环境变量配置

**高级**
- **Claude CLI 路径**：Claude Code CLI 的自定义路径（留空自动检测）

## 安全与权限

| 范围 | 访问权限 |
|------|----------|
| **Vault** | 完全读写（通过 `realpath` 的符号链接安全检查） |
| **导出路径** | 仅写入（如 `~/Desktop`、`~/Downloads`） |
| **外部上下文** | 完全读写（仅限会话，通过文件夹图标添加） |

- **YOLO 模式**：无需审批提示；所有工具调用自动执行（默认）
- **Safe 模式**：每次工具调用需审批；Bash 需精确匹配，文件工具允许前缀匹配
- **Plan 模式**：先探索和设计方案再实施。在聊天输入框中通过 Shift+Tab 切换

## 隐私与数据使用

- **发送到 API 的内容**：你的输入、附加文件、图片和工具调用输出。默认：Anthropic；可通过 `ANTHROPIC_BASE_URL` 自定义端点。
- **本地存储**：设置、会话元数据和命令存储在 `vault/.claude/` 中；会话消息存储在 `~/.claude/projects/`（SDK 原生）；旧版会话在 `vault/.claude/sessions/` 中。
- **无遥测**：除你配置的 API 提供商外无任何追踪。

## 故障排除

### Claude CLI 未找到

如果遇到 `spawn claude ENOENT` 或 `Claude CLI not found`，说明插件无法自动检测你的 Claude 安装位置。使用 Node 版本管理器（nvm、fnm、volta）时常见。

**解决方案**：找到 CLI 路径并在设置 → 高级 → Claude CLI 路径中设置。

| 平台 | 命令 | 示例路径 |
|------|------|----------|
| macOS/Linux | `which claude` | `/Users/you/.volta/bin/claude` |
| Windows（原生） | `where.exe claude` | `C:\Users\you\AppData\Local\Claude\claude.exe` |
| Windows（npm） | `npm root -g` | `{root}\@anthropic-ai\claude-code\cli.js` |

> **注意**：在 Windows 上，避免使用 `.cmd` 包装器。使用 `claude.exe` 或 `cli.js`。

**替代方案**：在设置 → 环境变量 → 自定义变量中将 Node.js bin 目录添加到 PATH。

### npm CLI 和 Node.js 不在同一目录

如果使用 npm 安装的 CLI，检查 `claude` 和 `node` 是否在同一目录：
```bash
dirname $(which claude)
dirname $(which node)
```

如果不同，Obsidian 等 GUI 应用可能找不到 Node.js。

**解决方案**：
1. 安装原生二进制文件（推荐）
2. 在设置 → 环境变量中添加 Node.js 路径：`PATH=/path/to/node/bin`

**仍有问题？** [提交 GitHub Issue](https://github.com/YishenTu/claudian/issues)，附上你的平台、CLI 路径和错误信息。

## 架构

```
src/
├── main.ts                      # 插件入口
├── core/                        # 核心基础设施
│   ├── agent/                   # Claude Agent SDK 封装（ClaudianService）
│   ├── agents/                  # 自定义 Agent 管理（AgentManager）
│   ├── commands/                # 斜杠命令管理（SlashCommandManager）
│   ├── hooks/                   # PreToolUse/PostToolUse 钩子
│   ├── images/                  # 图片缓存和加载
│   ├── mcp/                     # MCP 服务器配置、服务和测试
│   ├── plugins/                 # Claude Code 插件发现和管理
│   ├── prompts/                 # Agent 系统提示词
│   ├── sdk/                     # SDK 消息转换
│   ├── security/                # 审批、黑名单、路径验证
│   ├── storage/                 # 分布式存储系统
│   ├── tools/                   # 工具常量和工具函数
│   └── types/                   # 类型定义
├── features/                    # 功能模块
│   ├── chat/                    # 主聊天视图 + UI、渲染、控制器、标签页
│   ├── inline-edit/             # 内联编辑服务 + UI
│   └── settings/                # 设置标签页 UI
├── shared/                      # 共享 UI 组件和弹窗
│   ├── components/              # 输入工具栏组件、下拉框、选区高亮
│   ├── mention/                 # @-提及下拉框控制器
│   ├── modals/                  # 指令弹窗
│   └── icons.ts                 # 共享 SVG 图标
├── i18n/                        # 国际化（10 种语言）
├── utils/                       # 模块化工具函数
└── style/                       # 模块化 CSS（→ styles.css）
```

## 路线图

- [x] Claude Code 插件支持
- [x] 自定义 Agent（子 Agent）支持
- [x] Chrome 中的 Claude 支持
- [x] `/compact` 命令
- [x] 计划模式
- [x] `rewind` 和 `fork` 支持（包括 `/fork` 命令）
- [x] `!command` 支持
- [ ] 工具渲染器优化
- [ ] Hooks 和其他高级功能
- [ ] 更多功能即将推出！

## 许可证

基于 [MIT 许可证](LICENSE) 授权。

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=YishenTu/claudian&type=date&legend=top-left)](https://www.star-history.com/#YishenTu/claudian&type=date&legend=top-left)

## 致谢

- [Obsidian](https://obsidian.md) 提供的插件 API
- [Anthropic](https://anthropic.com) 的 Claude 和 [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
