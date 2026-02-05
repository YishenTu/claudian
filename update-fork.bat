@echo off
REM Claudian Fork 维护脚本 (Windows)
REM 用于从上游仓库合并最新更新到你的维护分支

setlocal

echo === Claudian Fork 维护脚本 ===
echo.
echo 上游仓库: YishenTu/claudian
echo 维护分支: feature/global-cc-config
echo.

REM 检查是否在正确的目录
if not exist ".git" (
  echo 错误: 请在 claudian 仓库目录中运行此脚本
  exit /b 1
)

git remote -v | findstr "YishenTu/claudian" >nul
if errorlevel 1 (
  echo 错误: 请在 claudian 仓库目录中运行此脚本
  exit /b 1
)

REM 保存当前工作
echo 1. 保存当前工作...
git stash push -m "Temporary stash before merge" || true

REM 切换到 main 分支并获取上游更新
echo 2. 获取上游更新...
git checkout main
git fetch origin
git pull origin main

REM 切换到维护分支
echo 3. 切换到维护分支...
git checkout feature/global-cc-config

REM 合并上游更新
echo 4. 合并上游 main 分支...
git merge main -m "chore: merge upstream main changes"

REM 检查是否有冲突
git diff --quiet
if errorlevel 1 (
  echo ⚠️  存在合并冲突，请手动解决后继续
  git status
  exit /b 1
)

REM 恢复工作
echo 5. 恢复之前的工作...
git stash pop || true

REM 推送到 fork
echo 6. 推送到你的 fork...
git push fork feature/global-cc-config

echo.
echo ✅ 更新完成！
echo.
echo 下一步：
echo 1. 在 Obsidian 中重新构建: npm run build
echo 2. 复制 main.js 到插件目录

endlocal
