# iFlow ACP 协议分析

## 发现

根据服务器日志，iFlow ACP 服务器：
1. ✅ 支持 WebSocket 连接（`ws://localhost:8765`）
2. ✅ 连接成功（看到 `[WS 1] open connection`）
3. ⚠️ 使用 "Gemini Peer" 和 "ACP adapter"
4. ⚠️ 消息格式可能与我们的实现不匹配

## 问题分析

我们的 `IFlowClient` 实现基于 iFlow TypeScript SDK 文档，但实际的 iFlow CLI 使用的是 **ACP (Agent Communication Protocol)**，这可能是一个不同的协议。

## 解决方案

### 方案 1：使用 Claude SDK（推荐）

由于 iFlow ACP 协议与我们的实现不兼容，建议切换回 Claude SDK：

```bash
# 1. 修改配置
# 编辑 src/core/agent/config.ts
# SDK_BACKEND = 'claude'

# 2. 重新构建
npm run build

# 3. 更新插件
cp main.js styles.css manifest.json /Users/stackjane/Documents/zhaotang/.obsidian/plugins/claudian/
```

### 方案 2：实现 ACP 协议适配器

需要：
1. 研究 ACP 协议规范
2. 修改 `IFlowClient` 以支持 ACP 消息格式
3. 实现 Gemini Peer 通信

这需要更多的开发工作和对 ACP 协议的深入了解。

### 方案 3：联系 iFlow 团队

询问：
1. ACP 协议的详细文档
2. TypeScript SDK 是否支持 ACP
3. 如何正确连接和通信

## 当前状态

- ✅ WebSocket 连接成功
- ❌ 消息格式不兼容
- ❌ 无法正常通信

## 建议

**立即切换回 Claude SDK**，原因：
1. Claude SDK 成熟稳定
2. 文档完善
3. 社区支持好
4. 可以立即使用

等 iFlow 提供完整的 SDK 文档后再考虑迁移。

## 切换步骤

```bash
# 1. 修改配置为 Claude
cat > src/core/agent/config.ts << 'EOF'
export type SDKBackend = 'claude' | 'iflow';
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

# 3. 更新插件
cp main.js styles.css manifest.json /Users/stackjane/Documents/zhaotang/.obsidian/plugins/claudian/

# 4. 重启 Obsidian
```

## 总结

iFlow SDK 集成的技术挑战：
- ✅ 代码架构完成
- ✅ WebSocket 连接成功
- ❌ 协议不兼容
- ❌ 缺少 ACP 文档

建议使用 Claude SDK 直到 iFlow 提供完整的 SDK 支持。
