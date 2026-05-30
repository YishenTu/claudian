import { PassThrough } from 'node:stream';

import {
  PiRpcResponseError,
  PiRpcTransport,
  PiRpcTransportClosedError,
} from '@/providers/pi/runtime/PiRpcTransport';

function createTransport() {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: string[] = [];
  output.on('data', chunk => writes.push(chunk.toString('utf8')));
  const transport = new PiRpcTransport({ input, output }, 100);
  transport.start();
  return { input, output, transport, writes };
}

describe('PiRpcTransport', () => {
  it('writes command requests with string ids', async () => {
    const { input, transport, writes } = createTransport();
    const promise = transport.request('get_state', { foo: 'bar' });

    expect(JSON.parse(writes[0]) as unknown).toEqual({
      foo: 'bar',
      id: 'req_1',
      type: 'get_state',
    });

    input.write('{"type":"response","id":"req_1","success":true,"result":{"ok":true}}\n');
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('sends fire-and-forget records without pending request tracking', () => {
    const { transport, writes } = createTransport();

    transport.send({ id: 'ui-1', type: 'extension_ui_response', value: 'ok' });

    expect(JSON.parse(writes[0]) as unknown).toEqual({
      id: 'ui-1',
      type: 'extension_ui_response',
      value: 'ok',
    });
  });

  it('resolves concurrent requests by id out of order', async () => {
    const { input, transport } = createTransport();
    const first = transport.request('first');
    const second = transport.request('second');

    input.write('{"type":"response","id":"req_2","success":true,"result":2}\n');
    input.write('{"type":"response","id":"req_1","success":true,"result":1}\n');

    await expect(second).resolves.toBe(2);
    await expect(first).resolves.toBe(1);
  });

  it('unwraps Pi response data when result is absent', async () => {
    const { input, transport } = createTransport();
    const promise = transport.request('get_available_models');

    input.write('{"type":"response","id":"req_1","success":true,"data":{"models":[{"id":"gpt-5"}]}}\n');

    await expect(promise).resolves.toEqual({ models: [{ id: 'gpt-5' }] });
  });

  it('routes non-response events to listeners', () => {
    const { input, transport } = createTransport();
    const events: unknown[] = [];
    transport.onEvent(event => events.push(event));

    input.write('{"type":"message_update","delta":"hi"}\n');

    expect(events).toEqual([{ type: 'message_update', delta: 'hi' }]);
  });

  it('rejects failed responses and pending requests on dispose', async () => {
    const { input, transport } = createTransport();
    const failed = transport.request('prompt');
    input.write('{"type":"response","id":"req_1","success":false,"error":"boom"}\n');

    await expect(failed).rejects.toBeInstanceOf(PiRpcResponseError);

    const pending = transport.request('prompt');
    transport.dispose();
    await expect(pending).rejects.toBeInstanceOf(PiRpcTransportClosedError);
  });
});
