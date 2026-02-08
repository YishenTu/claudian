// 在 Obsidian Console (Ctrl+Shift+I) 中运行这个脚本，会把日志保存到 vault

const vault = require('obsidian').app.vault;
const adapter = vault.adapter;

// 获取最近的 console 日志
const consoleLogs = [];
const originalLog = console.log;
console.log = function(...args) {
  consoleLogs.push(args);
  originalLog.apply(console, args);
};

// 等待收集日志...
window._claudianLogs = consoleLogs;
console.log('[Claudian] Console logger ready. Send a message in Claudian, then run: copyToVault()');

// 复制日志到文件
window.copyToVault = function() {
  const logContent = consoleLogs.map(args => 
    args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  ).join('\n');
  
  adapter.write('.claude/debug/console.log', logContent);
  console.log('[Claudian] Logs saved to .claude/debug/console.log');
};

console.log('[Claudian] Script loaded! Usage: copyToVault()');
