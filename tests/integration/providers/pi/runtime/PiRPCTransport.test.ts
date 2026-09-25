import { PassThrough } from 'node:stream';

import { PiRPCTransport } from '@/providers/pi/runtime/PiRPCTransport';

describe('Pi RPC stream decoding', () => {
  it('preserves fragmented Unicode in responses and streamed events', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new PiRPCTransport({ input, output });
    const events: unknown[] = [];
    transport.onEvent(event => events.push(event));
    try {
      const response = transport.request('get_state');
      const request = JSON.parse(output.read().toString('utf8'));
      const records = [
        { type: 'response', id: request.id, success: true, data: { sessionName: '你好 café 😀' } },
        { type: 'message_update', delta: '你好 café 😀' },
      ];
      for (const byte of Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n')) {
        input.write(Buffer.from([byte]));
      }
      await expect(response).resolves.toEqual({ sessionName: '你好 café 😀' });
      expect(events).toEqual([{ type: 'message_update', delta: '你好 café 😀' }]);
    } finally {
      transport.dispose();
      input.destroy();
      output.destroy();
    }
  });
});
