// Test iFlow ACP WebSocket connection
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8765');

ws.on('open', function open() {
  console.log('✅ Connected to iFlow ACP Server');
  
  // Try different message formats
  
  // Format 1: Simple text
  // ws.send('hello');
  
  // Format 2: JSON with type
  const msg = {
    jsonrpc: '2.0',
    method: 'query',
    params: {
      prompt: '你好'
    },
    id: 1
  };
  
  console.log('📤 Sending:', JSON.stringify(msg, null, 2));
  ws.send(JSON.stringify(msg));
});

ws.on('message', function message(data) {
  console.log('📨 Received:', data.toString());
});

ws.on('error', function error(err) {
  console.log('❌ Error:', err.message);
});

ws.on('close', function close() {
  console.log('🔌 Connection closed');
});

// Keep alive for 30 seconds
setTimeout(() => {
  console.log('⏰ Timeout, closing...');
  ws.close();
  process.exit(0);
}, 30000);
