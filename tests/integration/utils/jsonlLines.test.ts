import { once } from 'node:events';
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

  it('finishes once when the stream emits end and then close, keeping errors handled until unsubscribe', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const onEnd = vi.fn();
    const errors: Error[] = [];
    const unsubscribe = subscribeJSONLLines(stream, line => lines.push(line), onEnd, error => errors.push(error));
    const closed = once(stream, 'close');

    stream.end('{"a":1}\n{"b":2}');
    await closed;

    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(onEnd).toHaveBeenCalledTimes(1);

    const late = new Error('late');
    stream.emit('error', late);
    expect(errors).toEqual([late]);

    unsubscribe();
    expect(() => stream.emit('error', new Error('after unsubscribe'))).toThrow('after unsubscribe');
    expect(errors).toEqual([late]);
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
