#!/bin/bash
# Claudian Fork 维护脚本
# 用于从上游仓库合并最新更新到你的维护分支

set -e

CLONEDIR="${CLONE_DIR:-/tmp/claudian}"
UPSTREAM="YishenTu/claudian"
BRANCH="feature/global-cc-config"

echo "=== Claudian Fork 维护脚本 ==="
echo ""
echo "上游仓库: $UPSTREAM"
echo "维护分支: $BRANCH"
echo ""

# 检查是否在正确的目录
if [ ! -d ".git" ] || ! git remote -v | grep -q "YishenTu/claudian"; then
  echo "错误: 请在 claudian 仓库目录中运行此脚本"
  exit 1
fi

# 保存当前工作
git stash push -m "Temporary stash before merge" || true

# 切换到 main 分支并获取上游更新
echo "1. 获取上游更新..."
git checkout main
git fetch origin
git pull origin main

# 切换到维护分支
echo "2. 切换到维护分支..."
git checkout "$BRANCH"

# 合并上游更新
echo "3. 合并上游 main 分支..."
git merge main -m "chore: merge upstream main changes"

# 检查是否有冲突
if git diff --quiet; then
  echo "✅ 合并成功，无冲突"
else
  echo "⚠️  存在合并冲突，请手动解决后继续"
  git status
  exit 1
fi

# 恢复工作
echo "4. 恢复之前的工作..."
git stash pop || true

# 推送到 fork
echo "5. 推送到你的 fork..."
git push fork "$BRANCH"

echo ""
echo "✅ 更新完成！"
echo ""
echo "下一步："
echo "1. 在 Obsidian 中重新构建: npm run build"
echo "2. 复制 main.js 到插件目录"
