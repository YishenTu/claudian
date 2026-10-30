/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"customExportConditions":["node","node-addons"]}
 */

import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { WebSocket } from 'ws';

it('finishes closing every WebSocket before peer teardown resolves', async () => {
  const peer = new NativePeer();
  await peer.open();
  const client = await peer.connect();
  const sockets = [...new Set([...peer.streams.values()].map(stream => stream.socket))];
  const closed = sockets.map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())));
  try {
    client.dispose();
    await peer.close();
    expect(sockets).toHaveLength(2);
    expect(sockets.map(socket => socket.readyState)).toEqual([WebSocket.CLOSED, WebSocket.CLOSED]);
  } finally {
    client.dispose();
    // Drain real closes even if the regression assertion fails; do not leak into jsdom teardown.
    await Promise.all(closed);
  }
});
