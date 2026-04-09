# OpenCode Provider 集成文档

## 概述

OpenCode Provider 已成功集成到 Claudian 插件中，遵循与 Claude 和 Codex Provider 相同的架构模式。

## 架构设计

### 核心组件

```
src/providers/opencode/
├── runtime/
│   ├── OpenCodeChatRuntime.ts      # 核心运行时（JSON-RPC over stdio）
│   └── OpenCodeCliResolver.ts      # CLI 路径检测和解析
├── aux/
│   ├── OpenCodeTitleGenerationService.ts    # 标题生成
│   ├── OpenCodeInstructionRefineService.ts  # 指令精化
│   └── OpenCodeInlineEditService.ts         # 行内编辑
├── history/
│   └── OpenCodeConversationHistoryService.ts  # 会话历史管理
├── app/
│   └── OpenCodeWorkspaceServices.ts          # 工作区服务
├── ui/
│   └── OpenCodeSettingsTab.ts                # 设置 UI
├── types/
│   └── providerState.ts                      # 类型定义
├── capabilities.ts                           # 能力声明
├── registration.ts                           # Provider 注册
└── CLAUDE.md                                 # 架构文档
```

### 通信协议

OpenCode 通过 **ACP (Agent Client Protocol)** 进行通信：

```
┌─────────────┐         stdio (JSON-RPC 2.0)        ┌──────────────┐
│  Claudian   │ ◄─────────────────────────────────► │   OpenCode   │
│  Plugin     │       ACP Protocol v1               │   CLI (acp)  │
└─────────────┘                                     └──────────────┘
```

**协议流程**：
1. `initialize` → 协议版本协商
2. `session/new` → 创建会话（指定工作目录和 MCP 服务器）
3. `session/prompt` → 发送用户消息
4. `session/update` → 接收流式响应（notifications）
5. `session/cancel` → 取消当前轮次

## 安装和配置

### 前提条件

1. **安装 OpenCode**：
   ```bash
   # 使用官方安装脚本
   curl -fsSL https://opencode.ai/install | bash
   
   # 或使用 npm
   npm i -g opencode-ai@latest
   ```

2. **配置 AI Provider**：
   OpenCode 支持多种 AI 模型（OpenAI、Anthropic、Google 等）。确保已配置至少一个 Provider 的 API Key。

### Claudian 插件配置

1. 在 Obsidian 中启用 Claudian 插件
2. 打开 Claudian 设置
3. 在 Provider 选择中选择 "OpenCode"
4. （可选）在高级设置中配置 OpenCode CLI 路径

## 功能支持

### ✅ 已实现

- [x] 基础聊天对话
- [x] 流式响应
- [x] 会话管理（创建、恢复）
- [x] 取消流式响应
- [x] 图像附件支持
- [x] MCP 工具支持
- [x] 多标签页
- [x] 会话历史
- [x] CLI 自动检测

### ⏳ 待完善

- [ ] Plan Mode（计划模式）
- [ ] Rewind（回退消息）
- [ ] Fork（会话分叉）
- [ ] 增强的标题生成（通过 LLM）
- [ ] Skill/Command 目录
- [ ] 子代理支持
- [ ] 更精细的权限管理

## 使用方式

### 侧边栏聊天

1. 点击 Claudian 图标打开侧边栏
2. 在顶部选择 "OpenCode" Provider
3. 输入消息并发送
4. OpenCode 将在你的笔记库上下文中工作

### 行内编辑

1. 在笔记中选中文本
2. 使用快捷键触发行内编辑
3. 输入编辑指令
4. OpenCode 将生成修改建议

### Slash 命令和技能

目前 OpenCode Provider 暂不支持 Slash 命令和技能目录（可通过 ACP 协议后续扩展）。

## 故障排查

### OpenCode CLI 未找到

**症状**：`OpenCode CLI not found` 错误

**解决方案**：
1. 确认 OpenCode 已正确安装
2. 在设置中手动配置 CLI 路径：
   - Windows: `C:\Users\<你>\AppData\Roaming\npm\opencode.cmd`
   - macOS/Linux: `/usr/local/bin/opencode`

### 会话创建失败

**症状**：无法创建新会话

**解决方案**：
1. 检查 OpenCode 配置（`~/.opencode/` 或项目根目录的 `.opencode/`）
2. 确认至少配置了一个 AI Provider
3. 测试 OpenCode CLI 是否正常工作：
   ```bash
   opencode acp --cwd /path/to/vault
   ```

### 响应缓慢

**原因**：首次启动需要冷启动 OpenCode 进程

**优化**：
- OpenCode 进程会保持活跃状态（persistent runtime）
- 后续交互将更快

## 架构对比

| 特性 | Claude | Codex | OpenCode |
|------|--------|-------|----------|
| **SDK/协议** | Claude Agent SDK | Codex app-server (JSON-RPC) | OpenCode ACP (JSON-RPC) |
| **进程管理** | SDK 内部管理 | 自定义 spawn | 自定义 spawn |
| **会话管理** | 持久化查询 | 线程-based | ACP 会话 |
| **历史记录** | SDK 管理 | JSONL 文件 | ACP 协议 |
| **流式响应** | SDK 事件 | 文件 tailing + RPC | ACP notifications |
| **命令发现** | 运行时发现 | 技能目录 | 暂未支持 |

## 开发指南

### 测试 ACP 协议

```bash
# 手动测试 ACP 协议
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | opencode acp
```

### 调试日志

在开发模式下，OpenCode 的 stderr 输出会显示在 Obsidian 控制台中。

### 扩展功能

要添加新功能，参考以下模式：

1. **添加新工具调用支持**：修改 `OpenCodeChatRuntime.handleSessionUpdate()`
2. **添加设置选项**：修改 `OpenCodeSettingsTab.ts`
3. **增强能力声明**：修改 `capabilities.ts`

## 技术细节

### JSON-RPC 传输层

```typescript
// 请求格式
{
  jsonrpc: "2.0",
  id: <number>,
  method: "session/prompt",
  params: { sessionId: "...", prompt: "..." }
}

// 响应格式
{
  jsonrpc: "2.0",
  id: <number>,
  result: { ... }
}

// Notification（流式更新）
{
  jsonrpc: "2.0",
  method: "session/update",
  params: { 
    sessionId: "...",
    update: { sessionUpdate: "agent_message_chunk", ... }
  }
}
```

### 会话状态管理

OpenCode Provider 状态存储在 `Conversation.providerState` 中：

```typescript
interface OpenCodeProviderState {
  sessionId: string | null;     // ACP 会话 ID
  threadId: string | null;      // 线程 ID（未来使用）
  sessionFilePath?: string;     // 会话文件路径
  cwd: string;                  // 工作目录
}
```

## 贡献和反馈

如果你遇到问题或有改进建议，请提交 GitHub Issue 或联系维护者。

## 许可证

与 Claudian 插件相同 - MIT 许可证。
