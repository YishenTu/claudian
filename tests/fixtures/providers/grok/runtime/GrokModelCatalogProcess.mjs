import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Sanitized native Grok Build 1.0.40 `_x.ai/models/list` result, captured 2026-09-22.
const catalog = JSON.parse(readFileSync(new URL('./models-list.json', import.meta.url), 'utf8'));
const scenario = process.env.GROK_CATALOG_SCENARIO;
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);

if (process.argv.includes('--version')) {
  process.stdout.write('grok 1.0.40\n');
} else if (process.argv.includes('models')) {
  process.stdout.write('Default model: legacy-model\nAvailable models:\n  legacy-model\n');
} else {
  let initialized = false;
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    const respond = result => write({ jsonrpc: '2.0', id: request.id, result });
    const fail = () => write({
      jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' },
    });
    if (request.method === 'initialize') {
      if (scenario === 'hang-initialize') {
        write({ jsonrpc: '2.0', method: 'fixture/waiting', params: {} });
        return;
      }
      initialized = true;
      respond({ protocolVersion: 1, agentCapabilities: {} });
      return;
    }
    if (request.method !== '_x.ai/models/list' || !initialized) {
      fail();
      return;
    }
    if (scenario === 'hang-list') {
      write({ jsonrpc: '2.0', method: 'fixture/waiting', params: {} });
    } else if (scenario === 'unsupported') {
      fail();
    } else if (scenario === 'malformed') {
      respond({ result: { availableModels: 'invalid' } });
    } else if (scenario === 'extension-error') {
      respond({ ...catalog, error: 'private provider diagnostic' });
    } else if (scenario === 'byok') {
      // Sanitized native Grok Build 1.0.41 API-key catalog, captured 2026-09-25.
      respond(JSON.parse(readFileSync(new URL('./models-list-byok.json', import.meta.url), 'utf8')));
    } else if (scenario === 'empty') {
      respond({ result: { currentModelId: 'grok-4.6', availableModels: [] } });
    } else {
      respond(catalog);
    }
  });
}
