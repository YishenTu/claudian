# iFlow SDK 使用指南

本项目已完成从 Claude SDK 到 iFlow SDK 的改造，支持双后端切换。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 构建项目

```bash
npm run build
```

构建产物会生成在项目根目录：
- `main.js` - 插件主文件
- `styles.css` - 样式文件
- `manifest.json` - 插件清单

### 3. 安装到 Obsidian

将构建产物复制到 Obsidian vault 的插件目录：

```bash
# macOS/Linux
cp main.js styles.css manifest.json ~/.obsidian/plugins/claudian/

# Windows
copy main.js styles.css manifest.json %USERPROFILE%\.obsidian\plugins\claudian\
```

或者在开发模式下，直接在 Obsidian 插件目录中构建：

```bash
cd /path/to/your/vault/.obsidian/plugins/claudian
npm run dev  # 监听模式
```

### 4. 启动 iFlow 服务

iFlow SDK 需要一个运行中的 WebSocket 服务器。确保 iFlow 服务已启动：

```bash
# 默认监听 localhost:8765
iflow start
```

### 5. 在 Obsidian 中启用插件

1. 打开 Obsidian
2. 进入 Settings → Community plugins
3. 关闭 Safe mode（如果需要）
4. 找到 "Claudian" 插件并启用

## 配置说明

### 切换后端

编辑 `src/core/agent/config.ts`：

```typescript
// 使用 iFlow SDK
export const SDK_BACKEND: SDKBackend = 'iflow';

// 或使用 Claude SDK
export const SDK_BACKEND: SDKBackend = 'claude';
```

修改后需要重新构建：

```bash
npm run build
```

### iFlow 连接配置

默认配置在 `src/core/agent/IFlowService.ts` 的 `buildClientOptions()` 方法中：

```typescript
{
  host: 'localhost',
  port: 8765,
  timeout: 30000,
  autoStart: true,
}
```

如需修改，可以在 `IFlowClient` 构造函数中传入自定义选项。

## 功能对比

| 功能 | Claude SDK | iFlow SDK | 说明 |
|------|-----------|-----------|------|
| 文本对话 | ✅ | ✅ | 完全支持 |
| 图片上传 | ✅ | ✅ | 支持多图 |
| 工具调用 | ✅ | ✅ | 完全支持 |
| 思考模式 | ✅ | ✅ | Extended thinking |
| 会话持久化 | ✅ | ✅ | Session ID |
| MCP 服务器 | ✅ | ✅ | 完全支持 |
| 权限管理 | ✅ | ✅ | YOLO/Normal 模式 |
| 外部上下文 | ✅ | ✅ | 额外目录访问 |
| Hooks | ✅ | ⚠️ | 需要 iFlow 服务端支持 |
| 持久连接 | ✅ | ✅ | WebSocket 原生支持 |

## 架构说明

### 核心组件

```
src/core/
├── agent/
│   ├── config.ts              # SDK 后端配置（切换点）
│   ├── ServiceFactory.ts      # 服务工厂（创建对应后端服务）
│   ├── IFlowService.ts        # iFlow SDK 服务实现
│   ├── ClaudianService.ts     # Claude SDK 服务实现（保留）
│   └── queryAdapter.ts        # 统一查询接口（用于独立服务）
└── iflow/
    ├── IFlowClient.ts         # WebSocket 客户端
    ├── types.ts               # iFlow 类型定义
    ├── transformIFlowMessage.ts # 消息转换器
    └── index.ts               # 模块导出
```

### 消息流

**iFlow 模式：**
```
User Input → IFlowService → IFlowClient (WebSocket)
                                ↓
                          iFlow Server
                                ↓
IFlowMessage → transformIFlowMessage → StreamChunk → UI
```

**Claude 模式：**
```
User Input → ClaudianService → Claude Agent SDK
                                      ↓
                                Claude API
                                      ↓
SDKMessage → transformSDKMessage → StreamChunk → UI
```

## 开发指南

### 添加新的消息类型

如果 iFlow 支持新的消息类型，需要：

1. 在 `src/core/iflow/types.ts` 中添加类型定义
2. 在 `src/core/iflow/transformIFlowMessage.ts` 中添加转换逻辑
3. 在 `src/core/iflow/IFlowClient.ts` 的 `parseIFlowMessage()` 中添加解析逻辑

### 调试

启用开发模式：

```bash
npm run dev
```

查看 Obsidian 开发者工具（Cmd/Ctrl + Shift + I）中的控制台输出。

### 测试

```bash
# 运行所有测试
npm test

# 只运行单元测试
npm test -- --selectProjects unit

# 只运行集成测试
npm test -- --selectProjects integration

# 查看覆盖率
npm run test:coverage
```

注意：当前测试主要针对 Claude SDK，iFlow SDK 的测试需要单独编写。

## 常见问题

### Q: 连接 iFlow 失败

**A:** 检查以下几点：
1. iFlow 服务是否已启动：`iflow status`
2. 端口是否正确（默认 8765）
3. 防火墙是否阻止了连接
4. 查看 Obsidian 控制台的错误信息

### Q: 工具调用被拒绝

**A:** 检查权限设置：
1. 在插件设置中选择 "YOLO" 模式（自动允许所有工具）
2. 或在 "Normal" 模式下手动批准工具调用
3. 检查 `.claude/settings.json` 中的权限配置

### Q: 会话无法恢复

**A:** 
1. 确保 iFlow 服务支持会话持久化
2. 检查 session ID 是否正确传递
3. 查看 `~/.claude/projects/` 目录下的会话文件

### Q: 如何切换回 Claude SDK

**A:** 
1. 修改 `src/core/agent/config.ts` 中的 `SDK_BACKEND` 为 `'claude'`
2. 运行 `npm run build`
3. 重启 Obsidian 或重新加载插件

## 性能优化

### WebSocket 连接池

iFlow 使用单个 WebSocket 连接处理所有请求，避免了频繁建立连接的开销。

### 消息队列

消息在客户端排队，确保顺序处理，避免并发冲突。

### 会话预热

`preWarm()` 方法在插件启动时建立连接，减少首次查询延迟。

## 贡献指南

欢迎提交 Issue 和 Pull Request！

### 代码规范

- 使用 TypeScript 严格模式
- 遵循现有代码风格
- 添加必要的注释和文档
- 运行 `npm run lint` 检查代码
- 运行 `npm run typecheck` 检查类型

### 提交前检查

```bash
npm run typecheck  # 类型检查
npm run lint       # 代码检查
npm run test       # 运行测试
npm run build      # 构建验证
```

## 许可证

本项目继承原 Claudian 项目的许可证。

## 联系方式

如有问题，请在 GitHub 上提交 Issue。
