# Obsidian 插件安装指南

## 方式一：自动安装（推荐）

如果你已经有 Obsidian vault，运行安装脚本：

```bash
./install-to-obsidian.sh
```

脚本会自动查找你的 vault 并安装插件。

## 方式二：手动安装

### 1. 找到你的 Obsidian vault 位置

Obsidian vault 是包含 `.obsidian` 文件夹的目录。常见位置：
- `~/Documents/ObsidianVault/`
- `~/Desktop/MyVault/`
- 或你创建 vault 时指定的任何位置

### 2. 创建插件目录

```bash
# 替换 /path/to/your/vault 为你的实际 vault 路径
mkdir -p /path/to/your/vault/.obsidian/plugins/claudian
```

### 3. 复制插件文件

```bash
# 在项目根目录执行
cp main.js /path/to/your/vault/.obsidian/plugins/claudian/
cp styles.css /path/to/your/vault/.obsidian/plugins/claudian/
cp manifest.json /path/to/your/vault/.obsidian/plugins/claudian/
```

### 4. 在 Obsidian 中启用插件

1. 打开 Obsidian
2. 打开 Settings (⚙️)
3. 进入 **Community plugins**
4. 如果显示 "Safe mode is on"，点击 **Turn off Safe mode**
5. 点击 **Browse** 或在已安装插件列表中找到 **Claudian**
6. 点击切换按钮启用插件

## 方式三：开发模式（推荐开发者）

如果你想边开发边测试：

### 1. 在 vault 中创建符号链接

```bash
# 替换路径
VAULT_PATH="/path/to/your/vault"
PROJECT_PATH="$(pwd)"

# 创建插件目录
mkdir -p "$VAULT_PATH/.obsidian/plugins"

# 创建符号链接
ln -s "$PROJECT_PATH" "$VAULT_PATH/.obsidian/plugins/claudian"
```

### 2. 启动开发模式

```bash
npm run dev
```

这样修改代码后会自动重新构建，在 Obsidian 中重新加载插件即可看到更改。

## 如果你还没有 Obsidian vault

### 1. 下载并安装 Obsidian

访问 https://obsidian.md 下载 Obsidian。

### 2. 创建新 vault

1. 打开 Obsidian
2. 点击 "Create new vault"
3. 输入 vault 名称（例如：MyVault）
4. 选择保存位置（例如：`~/Documents/ObsidianVault`）
5. 点击 "Create"

### 3. 然后按照上面的方式安装插件

## 启动 iFlow 服务

在使用插件前，确保 iFlow 服务已启动：

```bash
# 启动 iFlow 服务（默认端口 8765）
iflow start

# 检查服务状态
iflow status
```

## 验证安装

1. 在 Obsidian 中，点击左侧边栏的 Claudian 图标（紫色聊天气泡）
2. 应该会打开聊天界面
3. 输入消息测试是否能正常对话

## 常见问题

### Q: 插件列表中没有 Claudian

**A:** 
1. 确认文件已正确复制到 `.obsidian/plugins/claudian/` 目录
2. 确认目录中有 `main.js`、`styles.css`、`manifest.json` 三个文件
3. 重启 Obsidian

### Q: 插件启用后没有反应

**A:**
1. 打开 Obsidian 开发者工具：`Cmd/Ctrl + Shift + I`
2. 查看 Console 标签页的错误信息
3. 确认 iFlow 服务是否已启动：`iflow status`

### Q: 连接 iFlow 失败

**A:**
1. 确认 iFlow 服务已启动：`iflow start`
2. 确认端口正确（默认 8765）
3. 检查防火墙设置
4. 查看 Obsidian 控制台的错误信息

### Q: 如何切换回 Claude SDK

**A:**
1. 编辑 `src/core/agent/config.ts`
2. 修改 `SDK_BACKEND` 为 `'claude'`
3. 运行 `npm run build`
4. 重新安装插件或重启 Obsidian

## 快速命令参考

```bash
# 构建插件
npm run build

# 开发模式（自动重新构建）
npm run dev

# 类型检查
npm run typecheck

# 代码检查
npm run lint

# 运行测试
npm test

# 安装到 Obsidian
./install-to-obsidian.sh

# 或手动复制
cp main.js styles.css manifest.json /path/to/vault/.obsidian/plugins/claudian/
```

## 下一步

安装完成后，查看以下文档了解更多：
- `IFLOW_USAGE.md` - 详细使用指南
- `IFLOW_MIGRATION.md` - 改造说明和架构文档
- `README.md` - 项目概述

## 需要帮助？

如果遇到问题：
1. 查看 Obsidian 开发者工具的控制台输出
2. 检查 iFlow 服务日志
3. 查看上述常见问题部分
4. 在 GitHub 上提交 Issue
