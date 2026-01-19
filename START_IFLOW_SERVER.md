# 启动 iFlow 服务器

## ✅ 问题已解决！

iFlow CLI 提供了 **ACP (Agent Communication Protocol)** 服务器模式，可以通过 HTTP/WebSocket 与插件通信。

## 🚀 启动命令

```bash
iflow --experimental-acp --port 8765 --yolo
```

### 参数说明

- `--experimental-acp` - 启动 ACP 服务器模式
- `--port 8765` - 指定端口（默认 8765，与插件配置一致）
- `--yolo` - 自动允许所有操作（推荐，避免频繁确认）

## 📊 服务器状态

启动成功后会看到：

```
[ACP] starting server with: {
  "workspace": "/path/to/your/workspace",
  "port": "8765",
  "verbose": false,
  "disableTools": false
}
🚀 iFlow ACP Server running at http://localhost:8765
```

## 🔍 验证服务器

检查服务器是否正在运行：

```bash
# 检查端口
lsof -i :8765

# 或使用 curl 测试
curl http://localhost:8765
```

## 📝 使用步骤

### 1. 启动 iFlow 服务器

```bash
# 在项目目录或任意目录启动
iflow --experimental-acp --port 8765 --yolo
```

**提示**：保持这个终端窗口打开，服务器会持续运行。

### 2. 更新插件

```bash
# 重新构建（如果还没构建）
npm run build

# 复制到 Obsidian vault
cp main.js styles.css manifest.json /Users/stackjane/Documents/zhaotang/.obsidian/plugins/claudian/
```

### 3. 重启 Obsidian

- 完全退出 Obsidian
- 重新打开 Obsidian
- 打开 zhaotang vault

### 4. 测试对话

1. 点击左侧边栏的紫色聊天气泡图标 💬
2. 输入消息：`你好`
3. 应该能正常收到回复

## 🎯 后台运行（可选）

如果想让服务器在后台运行：

```bash
# 使用 nohup
nohup iflow --experimental-acp --port 8765 --yolo > iflow.log 2>&1 &

# 查看日志
tail -f iflow.log

# 停止服务器
pkill -f "iflow.*experimental-acp"
```

或者使用 `screen` 或 `tmux`：

```bash
# 使用 screen
screen -S iflow
iflow --experimental-acp --port 8765 --yolo
# 按 Ctrl+A 然后 D 来分离

# 重新连接
screen -r iflow
```

## 🔧 故障排查

### 问题 1: 端口被占用

```bash
# 查看占用端口的进程
lsof -i :8765

# 杀死进程
kill -9 <PID>

# 或使用其他端口
iflow --experimental-acp --port 8766 --yolo
```

如果使用其他端口，需要修改插件代码中的端口配置。

### 问题 2: 连接失败

1. 确认服务器正在运行
2. 检查防火墙设置
3. 查看 Obsidian 开发者工具的控制台错误

### 问题 3: 服务器崩溃

查看错误日志：
```bash
# 如果使用 nohup
cat iflow.log

# 或直接运行查看输出
iflow --experimental-acp --port 8765 --yolo
```

## 📚 ACP 协议说明

ACP (Agent Communication Protocol) 是 iFlow 提供的通信协议，支持：

- ✅ HTTP/WebSocket 连接
- ✅ 实时消息流
- ✅ 工具调用
- ✅ 会话管理
- ✅ 文件操作

## 🎉 完成！

现在你可以：
1. ✅ iFlow 服务器运行在 localhost:8765
2. ✅ 插件配置为 iFlow 模式
3. ✅ 在 Obsidian 中正常使用

## 💡 提示

- 每次使用插件前确保 iFlow 服务器正在运行
- 可以创建一个启动脚本方便使用
- 建议使用 `--yolo` 模式避免频繁确认

## 🔗 相关命令

```bash
# 启动服务器
iflow --experimental-acp --port 8765 --yolo

# 检查状态
lsof -i :8765

# 停止服务器
pkill -f "iflow.*experimental-acp"

# 查看帮助
iflow --help
```

祝使用愉快！🚀
