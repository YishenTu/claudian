#!/bin/bash
VAULT="E:/obsidian-notes"

case "$1" in
  read)
    if [ -f "$VAULT/.claude/debug/console.log" ]; then
      echo "=== 性能日志 ==="
      grep "\[Claudian\]" "$VAULT/.claude/debug/console.log" || echo "无日志"
      
      echo ""
      echo "=== 统计 ==="
      chunks=$(grep -o "\[Claudian\] Chunk [0-9]*" "$VAULT/.claude/debug/console.log" | wc -l)
      renders=$(grep -o "\[Claudian\] Render [0-9]*" "$VAULT/.claude/debug/console.log" | wc -l)
      echo "Chunks: $chunks, Renders: $renders"
      
      if [ "$chunks" -gt 0 ]; then
        echo "减少: $(( 100 * (chunks - renders) / chunks ))%"
      fi
    else
      echo "❌ 日志文件不存在"
      echo ""
      echo "请在 Obsidian Console 中运行："
      echo ""
      echo "  console.log((...args) => window._logs.push(args));"
      echo "  window.copyToVault = () => {"
      echo "    const vault = app.vault;"
      echo "    vault.adapter.write('.claude/debug/console.log', _logs.join('\n'));"
      echo "    console.log('已保存');"
      echo "  };"
      echo ""
    fi
    ;;
  build)
    npm run build
    cp main.js "$VAULT/.obsidian/plugins/claudian/"
    cp manifest.json "$VAULT/.obsidian/plugins/claudian/"
    cp styles.css "$VAULT/.obsidian/plugins/claudian/"
    echo "✅ 已构建并复制"
    ;;
  *)
    echo "用法: $0 {read|build}"
    ;;
esac
