import * as path from 'node:path';

import { AcpJsonRpcTransport } from '@/providers/acp/AcpJsonRpcTransport';
import { AcpSubprocess } from '@/providers/acp/AcpSubprocess';
import { CodexAppServerProcess } from '@/providers/codex/runtime/CodexAppServerProcess';
import { CodexRpcTransport } from '@/providers/codex/runtime/CodexRpcTransport';
import { PiRpcTransport } from '@/providers/pi/runtime/PiRpcTransport';
import { PiSubprocess } from '@/providers/pi/runtime/PiSubprocess';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/provider-protocol-child.mjs');

describe('provider lifecycle fixture subprocesses', () => {
  it('runs a Codex JSON-RPC request through the real process and transport owners', async () => {
    const processOwner = new CodexAppServerProcess({
      args: [fixturePath, 'codex'],
      command: process.execPath,
      env: { ...process.env } as Record<string, string>,
      spawnCwd: process.cwd(),
    });
    processOwner.start();
    const transport = new CodexRpcTransport(processOwner);
    transport.start();

    await expect(transport.request('fixture/ping', { value: 1 }, 2_000)).resolves.toEqual({
      method: 'fixture/ping',
      params: { value: 1 },
    });

    transport.dispose();
    await processOwner.shutdown();
    expect(processOwner.isAlive()).toBe(false);
  });

  it('runs an ACP request through the real process and transport owners', async () => {
    const processOwner = new AcpSubprocess({
      args: [fixturePath, 'acp'],
      command: process.execPath,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    processOwner.start();
    const transport = new AcpJsonRpcTransport({
      input: processOwner.stdout,
      onClose: listener => processOwner.onClose(listener),
      output: processOwner.stdin,
    }, 2_000);

    await expect(transport.request('fixture/ping', { value: 2 })).resolves.toEqual({
      method: 'fixture/ping',
      params: { value: 2 },
    });

    transport.dispose();
    await processOwner.shutdown();
    expect(processOwner.isAlive()).toBe(false);
  });

  it('runs a Pi RPC request through the real process and transport owners', async () => {
    const processOwner = new PiSubprocess({
      args: [fixturePath, 'pi'],
      command: process.execPath,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    processOwner.start();
    const transport = new PiRpcTransport({
      input: processOwner.stdout,
      onClose: listener => processOwner.onClose(listener),
      output: processOwner.stdin,
    }, 2_000);

    await expect(transport.request('fixture_ping', { payload: 3 })).resolves.toEqual({
      command: 'fixture_ping',
      payload: 3,
    });

    transport.dispose();
    await processOwner.shutdown();
    expect(processOwner.isAlive()).toBe(false);
  });
});
