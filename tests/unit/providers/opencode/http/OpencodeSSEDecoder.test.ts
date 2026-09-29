import { OpencodeSSEDecoder } from '@/providers/opencode/http/OpencodeHTTPClient';

it('preserves fragmented CRLF, multiline data, comments and multiple frames', () => {
  const receive = jest.fn();
  const decoder = new OpencodeSSEDecoder(receive);
  const frame = ': heartbeat\r\ndata: {"type":"example",\r\ndata: "data":{"text":"你好"}}\r\n\r\n';
  for (const character of frame) decoder.push(character);
  decoder.push('data: {"type":"next","data":{}}\n\n');
  expect(receive.mock.calls.map(([event]) => event)).toEqual([
    { type: 'example', data: { text: '你好' } }, { type: 'next', data: {} },
  ]);
});

it('rejects malformed and oversized events across lines', () => {
  expect(() => new OpencodeSSEDecoder(() => {}).push('data: {bad}\n\n')).toThrow();
  const decoder = new OpencodeSSEDecoder(() => {});
  decoder.push(`data: ${' '.repeat(20 * 1024 * 1024)}\n`);
  expect(() => decoder.push(' '.repeat(13 * 1024 * 1024))).toThrow('size limit');
});

it('scans large fragmented events in linear work', () => {
  const receive = jest.fn();
  const decoder = new OpencodeSSEDecoder(receive);
  const frame = `data: ${JSON.stringify({ type: 'large', data: { text: 'x'.repeat(65536) } })}\n\n`;
  const original = String.prototype.indexOf;
  let scanned = 0;
  const spy = jest.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, search, position) {
    if (search === '\n') scanned += this.length - (position ?? 0);
    return original.call(this, search, position);
  });
  try {
    for (let index = 0; index < frame.length; index += 64) decoder.push(frame.slice(index, index + 64));
    expect(receive).toHaveBeenCalledTimes(1);
    expect(scanned).toBeLessThan(frame.length * 2);
  } finally { spy.mockRestore(); }
});
