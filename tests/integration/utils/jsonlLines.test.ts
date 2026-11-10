import { PassThrough } from 'node:stream';

import { subscribeJSONLLines } from '@/utils/jsonlLines';

describe('subscribeJSONLLines', () => {
  it.each(['\n', ''])('preserves fragmented UTF-8 with terminator %j', async terminator => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const unsubscribe = subscribeJSONLLines(stream, line => lines.push(line));
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
    subscribeJSONLLines(stream, line => lines.push(line));
    const separator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);

    stream.write(`{"a":1}\r\n{"b":"line${separator}separator${paragraphSeparator}still same record"}\n`);

    expect(lines).toEqual([
      '{"a":1}',
      `{"b":"line${separator}separator${paragraphSeparator}still same record"}`,
    ]);
  });

  it('scans fragmented records once instead of rescanning the accumulated prefix', () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const stop = subscribeJSONLLines(stream, line => lines.push(line));
    const original = String.prototype.indexOf;
    let scanned = 0;
    const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, search, position) {
      if (search === '\n') scanned += this.length - (position ?? 0);
      return original.call(this, search, position);
    });
    try {
      for (let index = 0; index < 1024; index++) stream.write('x'.repeat(64));
      stream.write('\r'); stream.write('\n');
      expect(lines).toEqual(['x'.repeat(65536)]);
      expect(scanned).toBeLessThan(2 * 65536);
    } finally { spy.mockRestore(); stop(); stream.destroy(); }
  });
});
