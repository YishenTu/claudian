import { PassThrough } from 'node:stream';

import { subscribePiJSONLLines, writePiJSONL } from '@/providers/pi/runtime/PiJSONL';

describe('PiJsonl', () => {
  it.each(['\n', ''])('preserves fragmented UTF-8 with terminator %j', async terminator => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const unsubscribe = subscribePiJSONLLines(stream, line => lines.push(line));
    try {
      for (const byte of Buffer.from(`你好 café 😀${terminator}`)) {
        stream.write(Buffer.from([byte]));
      }
      stream.end();
      await new Promise(resolve => setImmediate(resolve));
      expect(lines).toEqual(['你好 café 😀']);
    } finally {
      unsubscribe();
      stream.destroy();
    }
  });

  it('splits only on LF and strips CR', () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    subscribePiJSONLLines(stream, line => lines.push(line));
    const separator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);

    stream.write(`{"a":1}\r\n{"b":"line${separator}separator${paragraphSeparator}still same record"}\n`);

    expect(lines).toEqual([
      '{"a":1}',
      `{"b":"line${separator}separator${paragraphSeparator}still same record"}`,
    ]);
  });

  it('writes JSONL records', () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', chunk => chunks.push(chunk.toString('utf8')));

    writePiJSONL(output, { type: 'ping' });

    expect(chunks.join('')).toBe('{"type":"ping"}\n');
  });
});
