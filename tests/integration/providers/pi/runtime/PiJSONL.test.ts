import { PassThrough } from 'node:stream';

import { writePiJSONL } from '@/providers/pi/runtime/PiJSONL';

describe('PiJsonl', () => {
  it('writes JSONL records', () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', chunk => chunks.push(chunk.toString('utf8')));

    writePiJSONL(output, { type: 'ping' });

    expect(chunks.join('')).toBe('{"type":"ping"}\n');
  });
});
