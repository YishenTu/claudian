# Claudian 修改记录

## 修改目标

让 Claudian 与 Claude Code CLI 共享配置，避免重复配置。

## 已实现的修改

### 1. Skills 全局共享

**文件**: `src/core/storage/SkillStorage.ts`

**改动**:
- 优先从 `~/.claude/skills/` 读取 skills
- Vault skills 作为后备（同名时全局优先）
- 保存时默认保存到全局位置

**效果**: 在 CC 中配置的 skills，Claudian 可以直接使用

---

### 2. MCP 全局共享

**文件**: `src/core/storage/McpStorage.ts`

**改动**:
- 优先从 `~/.claude/mcp.json` 读取 MCP 配置
- Vault `.claude/mcp.json` 作为后备
- 保存时默认保存到全局位置

**效果**: 在 CC 中配置的 MCP servers，Claudian 可以直接使用

---

### 3. 存储服务配置

**文件**: `src/core/storage/StorageService.ts`

**改动**:
```typescript
// 传递 { preferGlobal: true } 选项给 SkillStorage 和 McpStorage
this.skills = new SkillStorage(this.adapter, { preferGlobal: true });
this.mcp = new McpStorage(this.adapter, { preferGlobal: true });
```

---

### 4. LaTeX 流式渲染优化

**文件**: `src/features/chat/controllers/StreamController.ts`

**改动**:
- 流式输出期间：纯文本显示（无 markdown 渲染，无 MathJax）
- 流式结束时：一次性渲染完整 markdown + LaTeX

**原因**: 每次调用 `renderContent()` 都会触发 MathJax 处理全部内容，导致卡顿

**效果**: 流式输出飞快，结束时格式正确

---

## 未修改（保持原样）

| 功能 | 位置 | 说明 |
|------|------|------|
| **Agents** | `~/.claude/agents/` | 已原生支持 |
| **Hooks** | `~/.claude/settings.json` | SDK 自动处理 |
| **工作目录** | vault 路径 | 保持不变 |
| **历史记录** | `~/.claude/projects/{vault}/` | 按 vault 隔离 |

---

## Fork 维护

**Fork 仓库**: https://github.com/Sophomoresty/claudian

**分支**: `feature/global-cc-config`

**上游仓库**: https://github.com/YishenTu/claudian

**更新方式**:
```bash
cd C:\Users\Sophomores\AppData\Local\Temp\claudian
git checkout main
git pull origin main
git checkout feature/global-cc-config
git merge main
# 解决冲突后
git push fork feature/global-cc-config
```

---

## 构建部署

```bash
# 构建
cd C:\Users\Sophomores\AppData\Local\Temp\claudian
npm run build

# 部署到 Obsidian
cp main.js "E:/obsidian-notes/.obsidian/plugins/claudian/main.js"

# 重载 Obsidian: Ctrl+R
```
