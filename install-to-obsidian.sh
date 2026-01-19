#!/bin/bash

# Obsidian 插件安装脚本
# 用于将构建好的插件安装到 Obsidian vault

set -e

echo "🚀 Claudian (iFlow) 插件安装脚本"
echo "================================"
echo ""

# 检查是否已构建
if [ ! -f "main.js" ]; then
    echo "❌ 未找到 main.js，请先运行构建："
    echo "   npm run build"
    exit 1
fi

# 查找 Obsidian vault 目录
echo "🔍 查找 Obsidian vault..."

# 尝试多种方式查找
VAULT_DIRS=""

# 方式1: 使用 mdfind (macOS Spotlight)
if command -v mdfind &> /dev/null; then
    VAULT_DIRS=$(mdfind "kMDItemContentType == 'public.folder' && kMDItemDisplayName == '.obsidian'" 2>/dev/null | grep -v "Library/Application Support" | head -10)
fi

# 方式2: 查找常见位置
if [ -z "$VAULT_DIRS" ]; then
    for dir in ~/Documents ~/Desktop ~/Obsidian ~; do
        if [ -d "$dir" ]; then
            found=$(find "$dir" -maxdepth 2 -type d -name ".obsidian" 2>/dev/null | head -5)
            if [ -n "$found" ]; then
                VAULT_DIRS="$VAULT_DIRS"$'\n'"$found"
            fi
        fi
    done
fi

# 清理空行
VAULT_DIRS=$(echo "$VAULT_DIRS" | grep -v '^$')

if [ -z "$VAULT_DIRS" ]; then
    echo "❌ 未找到 Obsidian vault"
    echo ""
    echo "请确保："
    echo "  1. 已安装 Obsidian (https://obsidian.md)"
    echo "  2. 已创建至少一个 vault"
    echo ""
    echo "或手动指定 vault 路径："
    echo "  ./install-to-obsidian.sh /path/to/your/vault"
    echo ""
    echo "查看详细安装指南："
    echo "  cat OBSIDIAN_SETUP.md"
    exit 1
fi

# 如果提供了参数，使用指定的 vault
if [ -n "$1" ]; then
    VAULT_PATH="$1"
    if [ ! -d "$VAULT_PATH/.obsidian" ]; then
        echo "❌ 指定的路径不是有效的 Obsidian vault: $VAULT_PATH"
        exit 1
    fi
else
    # 显示找到的 vault 列表
    echo "找到以下 vault："
    echo ""
    
    IFS=$'\n' read -d '' -r -a VAULT_ARRAY <<< "$VAULT_DIRS" || true
    
    for i in "${!VAULT_ARRAY[@]}"; do
        VAULT_DIR="${VAULT_ARRAY[$i]}"
        VAULT_NAME=$(basename "$(dirname "$VAULT_DIR")")
        echo "  [$((i+1))] $VAULT_NAME"
        echo "      $VAULT_DIR"
    done
    
    echo ""
    read -p "请选择 vault 编号 (1-${#VAULT_ARRAY[@]}): " CHOICE
    
    if [ -z "$CHOICE" ] || [ "$CHOICE" -lt 1 ] || [ "$CHOICE" -gt "${#VAULT_ARRAY[@]}" ]; then
        echo "❌ 无效的选择"
        exit 1
    fi
    
    VAULT_PATH=$(dirname "${VAULT_ARRAY[$((CHOICE-1))]}")
fi

echo ""
echo "📁 目标 vault: $VAULT_PATH"

# 创建插件目录
PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/claudian"
echo "📦 创建插件目录: $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"

# 复制文件
echo "📋 复制插件文件..."
cp main.js "$PLUGIN_DIR/"
cp styles.css "$PLUGIN_DIR/"
cp manifest.json "$PLUGIN_DIR/"

echo ""
echo "✅ 安装完成！"
echo ""
echo "📝 下一步："
echo "  1. 打开 Obsidian"
echo "  2. 进入 Settings → Community plugins"
echo "  3. 如果需要，关闭 Safe mode"
echo "  4. 找到 'Claudian' 插件并启用"
echo ""
echo "⚠️  注意："
echo "  - 确保 iFlow 服务已启动: iflow start"
echo "  - 默认连接 localhost:8765"
echo ""
