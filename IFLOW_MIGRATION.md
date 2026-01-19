# iFlow SDK 改造说明

本文档说明了从 Claude SDK 到 iFlow SDK 的改造内容。

## 改造概述

本项目已完成从 `@anthropic-ai/claude-agent-sdk` 到 iFlow TypeScript SDK 的迁移，采用**双后端共存**架构，支持在两种 SDK 之间灵活切换。

## 改造内容

### 1. 新增文件

#### `src/core/iflow/` - iFlow SDK 集成层

- **`types.ts`** - iFlow 消息类型定义
  - `AssistantMessage` - AI 助手文本响应
  - `ToolCallMessage` - 工具执行请求和状态
  - `PlanMessage` - 结构化任务计划
  - `TaskFinishMessage` - 任务完成信号
  - `ThinkingMessage` - 推理/思考内容
  - `ErrorMessage` - 错误消息
  - `IFlowOptions` - 客户端配置选项
  - `IFlowQueryOptions` - 查询选项

- **`IFlowClient.ts`** - WebSocket 客户端实现
  - 连接管理（connect/disconnect）
  - 消息发送（sendMessage/sendMessageWithImages）
  - 会话管理（getSessionId/setSessionId）
  - 中断控制（interrupt）
  - 使用自定义 `MessageIterator` 避免 async generator 语法

- **`transformIFlowMessage.ts`** - 消息转换器
  - 将 iFlow 消息转换为 `StreamChunk` 格式
  - 支持所有 iFlow 消息类型
  - 与 UI 渲染层无缝对接

- **`index.ts`** - 模块导出

#### `src/core/agent/` - 服务层改造

- **`IFlowService.ts`** - iFlow 服务实现
  - 实现与 `ClaudianService` 相同的接口
  - 连接生命周期管理
  - 查询方法（query）
  - 会话管理（session ID）
  - 权限管理（approval）
  - MCP 服务器集成

- **`ServiceFactory.ts`** - 服务工厂
  - `IAgentService` 接口定义
  - `createAgentService()` 工厂方法
  - 根据 `SDK_BACKEND` 配置创建对应服务

- **`config.ts`** - SDK 后端配置
  - `SDK_BACKEND` 配置项（'claude' | 'iflow'）
  - `isClaudeBackend()` / `isIFlowBackend()` 辅助函数

- **`queryAdapter.ts`** - 统一查询接口
  - 为独立服务（InlineEdit、TitleGeneration 等）提供统一接口
  - 动态导入对应 SDK
  - 消息格式转换

### 2. 修改文件

#### 核心服务

- **`src/core/agent/index.ts`**
  - 导出 `ServiceFactory` 和 `IAgentService`
  - 导出 `config` 模块

#### UI 组件

- **`src/features/chat/tabs/Tab.ts`**
  - 使用 `createAgentService()` 创建服务
  - 使用 `IAgentService` 接口类型

- **`src/features/chat/tabs/types.ts`**
  - 使用 `IAgentService` 替代 `ClaudianService`

- **`src/features/chat/tabs/TabManager.ts`**
  - 使用 `IAgentService` 接口

#### 控制器

- **`src/features/chat/controllers/StreamController.ts`**
  - 使用 `IAgentService` 接口

- **`src/features/chat/controllers/ConversationController.ts`**
  - 使用 `IAgentService` 接口

- **`src/features/chat/controllers/InputController.ts`**
  - 使用 `IAgentService` 接口

#### 独立服务

- **`src/features/inline-edit/InlineEditService.ts`**
  - 使用 `queryAdapter` 进行查询

- **`src/features/chat/services/TitleGenerationService.ts`**
  - 使用 `queryAdapter` 进行查询

- **`src/features/chat/services/InstructionRefineService.ts`**
  - 使用 `queryAdapter` 进行查询

#### 视觉更新

- **`src/features/chat/constants.ts`**
  - 更新 `LOGO_SVG` 为 iFlow 紫色聊天气泡图标

### 3. 保留文件（仅 Claude 模式使用）

以下文件仅在 `SDK_BACKEND = 'claude'` 时使用，保持向后兼容：

- `src/core/agent/ClaudianService.ts` - Claude SDK 服务实现
- `src/core/agent/QueryOptionsBuilder.ts` - Claude SDK 选项构建器
- `src/core/agent/MessageChannel.ts` - Claude SDK 消息队列
- `src/core/hooks/DiffTrackingHooks.ts` - 使用 Claude SDK 类型
- `src/core/hooks/SecurityHooks.ts` - 使用 Claude SDK 类型
- `src/core/agent/types.ts` - Claude SDK 类型定义
- `src/core/types/models.ts` - `SdkBeta` 类型

## 架构设计

### 双后端共存

```
┌─────────────────────────────────────────┐
│         Application Layer               │
│  (UI, Controllers, Services)            │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│         IAgentService Interface         │
│  (统一接口，隐藏实现细节)                 │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│ IFlowService  │   │ClaudianService│
│               │   │               │
│ ┌───────────┐ │   │ ┌───────────┐ │
│ │IFlowClient│ │   │ │MessageChan│ │
│ │(WebSocket)│ │   │ │nel        │ │
│ └───────────┘ │   │ └───────────┘ │
└───────┬───────┘   └───────┬───────┘
        │                   │
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│  iFlow Server │   │  Claude SDK   │
└───────────────┘   └───────────────┘
```

### 消息流转换

```
iFlow Message Types          StreamChunk Types
─────────────────────       ─────────────────
AssistantMessage      →     text
ToolCallMessage       →     tool_use / tool_result
PlanMessage           →     text (formatted)
TaskFinishMessage     →     done
ThinkingMessage       →     thinking
ErrorMessage          →     error
```

### 接口统一

`IAgentService` 接口确保两种实现提供相同的功能：

```typescript
interface IAgentService {
  // 查询方法
  query(prompt, images?, history?, options?): AsyncGenerator<StreamChunk>
  
  // 生命周期
  preWarm(sessionId?, paths?): Promise<void>
  cancel(): void
  cleanup(): void
  closePersistentQuery(reason?): void
  restartPersistentQuery(reason?): Promise<void>
  
  // 会话管理
  getSessionId(): string | null
  setSessionId(id): void
  resetSession(): void
  consumeSessionInvalidation(): boolean
  
  // 状态
  isPersistentQueryActive(): boolean
  
  // 配置
  loadCCPermissions(): Promise<void>
  loadMcpServers(): Promise<void>
  reloadMcpServers(): Promise<void>
  setApprovalCallback(callback): void
}
```

## 切换方式

### 编译时切换

修改 `src/core/agent/config.ts`：

```typescript
// 使用 iFlow SDK
export const SDK_BACKEND: SDKBackend = 'iflow';

// 使用 Claude SDK
export const SDK_BACKEND: SDKBackend = 'claude';
```

然后重新构建：

```bash
npm run build
```

### 运行时要求

**iFlow 模式：**
- 需要运行中的 iFlow WebSocket 服务器（默认 `localhost:8765`）
- 支持会话持久化
- 支持 MCP 服务器

**Claude 模式：**
- 需要 Claude CLI 可执行文件
- 需要有效的 Anthropic API 密钥
- 支持所有原有功能

## 功能对比

| 功能 | Claude SDK | iFlow SDK | 说明 |
|------|-----------|-----------|------|
| 基础对话 | ✅ | ✅ | 完全支持 |
| 图片上传 | ✅ | ✅ | 多图支持 |
| 工具调用 | ✅ | ✅ | 完全支持 |
| Extended Thinking | ✅ | ✅ | 可配置 token 预算 |
| 会话持久化 | ✅ | ✅ | Session ID |
| MCP 服务器 | ✅ | ✅ | 完全支持 |
| 权限管理 | ✅ | ✅ | YOLO/Normal 模式 |
| 外部上下文 | ✅ | ✅ | additionalDirectories |
| PreToolUse Hooks | ✅ | ⚠️ | 需服务端支持 |
| PostToolUse Hooks | ✅ | ⚠️ | 需服务端支持 |
| 持久连接 | ✅ | ✅ | WebSocket 原生 |
| 消息队列 | ✅ | ✅ | 内置支持 |

## 技术细节

### WebSocket vs HTTP

**iFlow (WebSocket):**
- 优点：双向通信、低延迟、持久连接
- 缺点：需要服务器支持、连接管理复杂

**Claude SDK (HTTP):**
- 优点：简单、可靠、广泛支持
- 缺点：单向通信、需要轮询

### 消息迭代器

iFlow 使用自定义 `MessageIterator` 类而非 async generator：

```typescript
class MessageIterator implements AsyncIterableIterator<IFlowMessage> {
  next(): Promise<IteratorResult<IFlowMessage, undefined>> {
    // 实现逻辑
  }
}
```

这避免了 TypeScript async generator 需要 `tslib` 的问题。

### 类型安全

所有消息类型都有完整的 TypeScript 定义，确保编译时类型检查。

## 测试

当前测试主要针对 Claude SDK。iFlow SDK 的测试需要：

1. Mock WebSocket 连接
2. Mock iFlow 服务器响应
3. 测试消息转换逻辑
4. 测试错误处理

建议添加：
- `tests/unit/core/iflow/IFlowClient.test.ts`
- `tests/unit/core/iflow/transformIFlowMessage.test.ts`
- `tests/unit/core/agent/IFlowService.test.ts`
- `tests/integration/core/iflow/iflow.test.ts`

## 性能考虑

### 连接复用

iFlow 使用单个 WebSocket 连接处理所有请求，避免频繁建立连接。

### 消息批处理

消息在客户端排队，可以批量发送，减少网络往返。

### 预热机制

`preWarm()` 在插件启动时建立连接，减少首次查询延迟。

## 未来改进

1. **动态切换**：支持运行时切换后端，无需重启
2. **连接池**：支持多个 WebSocket 连接，提高并发性能
3. **重连机制**：自动重连断开的 WebSocket
4. **离线模式**：缓存消息，网络恢复后重发
5. **性能监控**：添加性能指标收集和报告
6. **完整测试**：为 iFlow SDK 添加完整的单元和集成测试

## 兼容性

- **向后兼容**：保留所有 Claude SDK 功能
- **向前兼容**：iFlow SDK 支持未来扩展
- **平滑迁移**：可随时切换回 Claude SDK

## 总结

本次改造实现了：
- ✅ 完整的 iFlow SDK 集成
- ✅ 双后端共存架构
- ✅ 统一的接口抽象
- ✅ 类型安全保证
- ✅ 向后兼容性
- ✅ 灵活的切换机制

项目现在可以根据需求选择使用 Claude SDK 或 iFlow SDK，为未来的扩展提供了良好的基础。
