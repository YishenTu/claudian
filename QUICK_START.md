# 快速开始指南

## 🎯 目标

在 Obsidian 中使用 Claudian 插件，通过 iFlow SDK 与 AI 对话。

## 📋 前置条件

1. ✅ 已安装 Node.js (v16+)
2. ✅ 已安装 Obsidian (https://obsidian.md)
3. ⚠️ 需要安装并启动 iFlow 服务

## 🚀 5 步安装

### 步骤 1: 构建插件

```bash
# 在项目根目录执行
npm install
npm run build
```

构建完成后会生成：
- `main.js` - 插件主文件 (1.6MB)
- `styles.css` - 样式文件 (89KB)
- `manifest.json` - 插件清单

### 步骤 2: 找到或创建 Obsidian Vault

**如果已有 vault：**
- 记住 vault 的路径（包含 `.obsidian` 文件夹的目录）

**如果没有 vault：**
1. 打开 Obsidian
2. 点击 "Create new vault"
3. 输入名称（如：TestVault）
4. 选择位置（如：`~/Documents/ObsidianVault`）
5. 点击 "Create"

### 步骤 3: 安装插件

**方式 A - 自动安装（推荐）：**

```bash
./install-to-obsidian.sh
```

脚本会自动查找 vault 并安装。

**方式 B - 手动安装：**

```bash
# 替换为你的 vault 路径
VAULT="/path/to/your/vault"

# 创建插件目录
mkdir -p "$VAULT/.obsidian/plugins/claudian"

# 复制文件
cp main.js styles.css manifest.json "$VAULT/.obsidian/plugins/claudian/"
```

**方式 C - 开发模式（推荐开发者）：**

```bash
# 创建符号链接，方便开发
VAULT="/path/to/your/vault"
ln -s "$(pwd)" "$VAULT/.obsidian/plugins/claudian"

# 启动监听模式
npm run dev
```

### 步骤 4: 启动 iFlow 服务

```bash
# 启动 iFlow（默认端口 8765）
iflow start

# 验证服务状态
iflow status
```

如果没有安装 iFlow，请参考 iFlow 文档进行安装。

### 步骤 5: 在 Obsidian 中启用插件

1. 打开 Obsidian
2. 打开 Settings (⚙️ 或 `Cmd/Ctrl + ,`)
3. 进入 **Community plugins**
4. 如果显示 "Safe mode is on"，点击 **Turn off Safe mode**
5. 在插件列表中找到 **Claudian**
6. 点击切换按钮启用插件
7. 左侧边栏会出现紫色聊天气泡图标 💬

## ✨ 开始使用

1. 点击左侧边栏的 Claudian 图标（紫色聊天气泡）
2. 在输入框中输入消息
3. 按 `Enter` 发送（`Shift + Enter` 换行）
4. 等待 AI 回复

## 🎨 界面说明

```
┌─────────────────────────────────────┐
│  💬 Claudian                    ⚙️  │  ← 标题栏
├─────────────────────────────────────┤
│                                     │
│  👤 User: 你好                      │  ← 用户消息
│                                     │
│  🤖 Assistant: 你好！我是...        │  ← AI 回复
│                                     │
│  🔧 Tool: Read file.txt             │  ← 工具调用
│     ✅ Success                       │
│                                     │
├─────────────────────────────────────┤
│  📎 🖼️ 🎯 💭 📁 🔌 🔒              │  ← 工具栏
│  ┌─────────────────────────────┐   │
│  │ 输入消息...                  │   │  ← 输入框
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### 工具栏图标说明

- 📎 **文件** - 附加 vault 中的文件
- 🖼️ **图片** - 上传图片
- 🎯 **模型** - 选择 AI 模型
- 💭 **思考** - 设置思考预算
- 📁 **外部** - 添加外部目录
- 🔌 **MCP** - 启用 MCP 服务器
- 🔒 **权限** - 切换权限模式

## 🔧 配置

### 切换到 Claude SDK

如果想使用 Claude SDK 而不是 iFlow：

1. 编辑 `src/core/agent/config.ts`：
   ```typescript
   export const SDK_BACKEND: SDKBackend = 'claude';
   ```

2. 重新构建：
   ```bash
   npm run build
   ```

3. 重新安装或重启 Obsidian

### 修改 iFlow 连接

编辑 `src/core/agent/IFlowService.ts` 中的 `buildClientOptions()`：

```typescript
return {
  host: 'localhost',  // 修改主机
  port: 8765,         // 修改端口
  timeout: 30000,     // 修改超时
  autoStart: true,
};
```

## 🐛 故障排查

### 问题 1: 插件列表中没有 Claudian

**解决方案：**
```bash
# 检查文件是否存在
ls -la /path/to/vault/.obsidian/plugins/claudian/

# 应该看到：
# main.js
# styles.css
# manifest.json
```

如果文件不存在，重新执行步骤 3。

### 问题 2: 连接 iFlow 失败

**解决方案：**
```bash
# 检查 iFlow 服务状态
iflow status

# 如果未运行，启动服务
iflow start

# 检查端口是否被占用
lsof -i :8765
```

### 问题 3: 插件启用后没有反应

**解决方案：**
1. 打开 Obsidian 开发者工具：`Cmd/Ctrl + Shift + I`
2. 查看 Console 标签页的错误信息
3. 截图错误信息以便调试

### 问题 4: 消息发送后无响应

**解决方案：**
1. 检查 iFlow 服务日志
2. 查看 Obsidian 控制台是否有错误
3. 确认网络连接正常
4. 尝试重启 iFlow 服务

## 📚 更多文档

- **IFLOW_USAGE.md** - 详细使用指南
- **IFLOW_MIGRATION.md** - 架构和改造说明
- **OBSIDIAN_SETUP.md** - 详细安装步骤
- **README.md** - 项目概述

## 🎉 完成！

现在你可以在 Obsidian 中使用 AI 助手了！

试试这些功能：
- 💬 基础对话
- 📝 编辑文件
- 🔍 搜索内容
- 🖼️ 分析图片
- 🔧 执行命令
- 📊 生成图表

祝使用愉快！
