# iFlow WebSocket 服务器问题

## 问题描述

插件报错：`Failed to connect to iFlow: WebSocket error: [object Event]`

## 原因分析

当前安装的 iFlow CLI (v0.5.1) 是一个**交互式命令行工具**，不提供 WebSocket 服务器功能。

我们的插件改造基于 iFlow TypeScript SDK 文档（https://platform.iflow.cn/cli/sdk/sdk-typescript），该文档描述的是通过 WebSocket 连接到 iFlow 服务器的方式。

## 解决方案

### 方案 1：切换回 Claude SDK（推荐）

由于当前 iFlow CLI 不提供 WebSocket 服务器，建议暂时切换回 Claude SDK：

#### 步骤：

1. **修改配置**
   ```bash
   # 编辑 src/core/agent/config.ts
   # 将 SDK_BACKEND 改为 'claude'
   ```

2. **重新构建**
   ```bash
   npm run build
   ```

3. **重新安装插件**
   ```bash
   cp main.js styles.css manifest.json /Users/stackjane/Documents/zhaotang/.obsidian/plugins/claudian/
   ```

4. **重启 Obsidian**

5. **配置 Claude CLI**
   - 确保已安装 Claude CLI
   - 设置 ANTHROPIC_API_KEY 环境变量

### 方案 2：等待 iFlow WebSocket 服务器

如果 iFlow 团队计划提供 WebSocket 服务器功能，可以等待更新后再使用 iFlow SDK。

需要的功能：
- WebSocket 服务器监听（默认 localhost:8765）
- 支持消息类型：
  - `assistant` - AI 响应
  - `tool_call` - 工具调用
  - `thinking` - 思考内容
  - `task_finish` - 任务完成
  - `error` - 错误消息

### 方案 3：实现 iFlow CLI 适配器

创建一个适配器，将 iFlow CLI 的交互式模式转换为 WebSocket 服务器：

```typescript
// 伪代码
class IFlowCLIAdapter {
  // 启动 iFlow CLI 进程
  // 通过 stdin/stdout 通信
  // 提供 WebSocket 接口
}
```

这需要额外的开发工作。

### 方案 4：联系 iFlow 团队

询问 iFlow 团队：
1. 是否有 WebSocket 服务器模式？
2. 如何启动 WebSocket 服务器？
3. TypeScript SDK 文档中的 WebSocket 连接方式是否已实现？

## 临时解决方案：使用 Claude SDK

### 快速切换步骤

```bash
# 1. 修改配置
cat > src/core/agent/config.ts << 'EOF'
/**
 * Agent SDK Configuration
 */

export type SDKBackend = 'claude' | 'iflow';

/**
 * Current SDK backend configuration.
 * Set to 'claude' to use Claude Agent SDK
 * Set to 'iflow' to use iFlow SDK
 */
export const SDK_BACKEND: SDKBackend = 'claude';

export function isClaudeBackend(): boolean {
  return SDK_BACKEND === 'claude';
}

export function isIFlowBackend(): boolean {
  return SDK_BACKEND === 'iflow';
}
EOF

# 2. 重新构建
npm run build

# 3. 重新安装
cp main.js styles.css manifest.json /Users/stackjane/Documents/zhaotang/.obsidian/plugins/claudian/

# 4. 重启 Obsidian
```

### 配置 Claude SDK

1. **安装 Claude CLI**
   ```bash
   # macOS
   brew install claude-cli
   
   # 或从官网下载
   # https://claude.ai/download
   ```

2. **设置 API Key**
   ```bash
   export ANTHROPIC_API_KEY="your-api-key-here"
   ```

3. **验证安装**
   ```bash
   claude --version
   ```

## 架构说明

### 当前实现（iFlow SDK）

```
Obsidian Plugin
      ↓
IFlowService
      ↓
IFlowClient (WebSocket)
      ↓
❌ iFlow WebSocket Server (不存在)
```

### Claude SDK 实现

```
Obsidian Plugin
      ↓
ClaudianService
      ↓
Claude Agent SDK
      ↓
✅ Claude API (HTTP)
```

## 总结

**当前状态：**
- ✅ iFlow SDK 集成代码已完成
- ✅ 双后端架构已实现
- ❌ iFlow WebSocket 服务器不可用
- ✅ Claude SDK 可正常使用

**建议：**
1. 短期：切换回 Claude SDK 使用
2. 中期：联系 iFlow 团队确认 WebSocket 服务器功能
3. 长期：根据 iFlow 团队反馈决定是否继续使用 iFlow SDK

## 相关文档

- iFlow CLI 文档：https://platform.iflow.cn/cli
- iFlow TypeScript SDK：https://platform.iflow.cn/cli/sdk/sdk-typescript
- Claude Agent SDK：https://github.com/anthropics/claude-agent-sdk

## 需要帮助？

如果需要切换回 Claude SDK，请告诉我，我会帮你完成切换。
