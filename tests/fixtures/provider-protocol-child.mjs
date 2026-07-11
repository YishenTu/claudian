import * as readline from 'node:readline';

const mode = process.argv[2];
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }

  if (mode === 'pi') {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: { command: message.type, payload: message.payload ?? null },
      success: true,
      type: 'response',
    })}\n`);
    continue;
  }

  process.stdout.write(`${JSON.stringify({
    id: message.id,
    jsonrpc: '2.0',
    result: { method: message.method, params: message.params ?? null },
  })}\n`);
}
