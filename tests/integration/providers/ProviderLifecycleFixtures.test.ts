import * as path from 'node:path';

import { AcpJsonRpcTransport } from '@/providers/acp/AcpJsonRpcTransport';
import { AcpSubprocess } from '@/providers/acp/AcpSubprocess';
import { CodexAppServerProcess } from '@/providers/codex/runtime/CodexAppServerProcess';
import { CodexRpcTransport } from '@/providers/codex/runtime/CodexRpcTransport';
import { GrokChatRuntime } from '@/providers/grok/runtime/GrokChatRuntime';
import { PiRpcTransport } from '@/providers/pi/runtime/PiRpcTransport';
import { PiSubprocess } from '@/providers/pi/runtime/PiSubprocess';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/provider-protocol-child.mjs');

describe('provider lifecycle fixture subprocesses', () => {
  it('runs the Grok chat lifecycle through a real ACP subprocess', async () => {
    let launchSpec: { args: string[]; command: string } | null = null;
    let processOwner: AcpSubprocess | null = null;
    const settings = {
      model: 'grok/grok-4.5',
      permissionMode: 'normal',
      providerConfigs: { grok: { enabled: true } },
    };
    const runtime = new GrokChatRuntime({
      app: { vault: { adapter: { basePath: process.cwd() } } },
      manifest: { version: 'test' },
      settings,
    } as any, {
      cliResolver: { resolveFromSettings: () => '/fixture/grok' },
      processFactory: (spec) => {
        launchSpec = { args: [...spec.args], command: spec.command };
        processOwner = new AcpSubprocess({
          ...spec,
          args: [fixturePath, 'grok'],
          command: process.execPath,
        });
        return processOwner;
      },
    });

    const chunks = [];
    for await (const chunk of runtime.query(runtime.prepareTurn({ text: 'ping' }))) {
      chunks.push(chunk);
    }

    expect(launchSpec).toEqual({
      args: ['agent', '--no-leader', 'stdio'],
      command: '/fixture/grok',
    });
    expect(chunks).toContainEqual({ content: 'fixture Grok response', type: 'text' });
    expect(runtime.getSessionId()).toBe('fixture-grok-session');

    runtime.cleanup();
    await waitFor(() => processOwner?.isAlive() === false);
  });

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

  it('ignores primitive Codex frames from a real process before a valid response', async () => {
    const processOwner = new CodexAppServerProcess({
      args: [fixturePath, 'codex'],
      command: process.execPath,
      env: { ...process.env } as Record<string, string>,
      spawnCwd: process.cwd(),
    });
    processOwner.start();
    const transport = new CodexRpcTransport(processOwner);
    transport.start();

    await expect(transport.request('fixture/primitive', {}, 2_000)).resolves.toEqual({
      method: 'fixture/primitive',
      params: {},
    });

    transport.dispose();
    await processOwner.shutdown();
  });

  it('rejects pending Codex requests when the real subprocess exits', async () => {
    const processOwner = new CodexAppServerProcess({
      args: [fixturePath, 'codex'],
      command: process.execPath,
      env: { ...process.env } as Record<string, string>,
      spawnCwd: process.cwd(),
    });
    processOwner.start();
    const transport = new CodexRpcTransport(processOwner);
    transport.start();

    await expect(transport.request('fixture/exit', {}, 2_000)).rejects.toThrow(
      'App-server process exited',
    );

    transport.dispose();
    await processOwner.shutdown();
  });

  it('rejects pending ACP requests when the real subprocess exits', async () => {
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

    await expect(transport.request('fixture/exit')).rejects.toThrow(
      /JSON-RPC input closed|ACP subprocess exited/,
    );

    transport.dispose();
    await processOwner.shutdown();
  });

  it('rejects pending Pi requests when the real subprocess exits', async () => {
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

    await expect(transport.request('fixture_exit')).rejects.toThrow(
      /Pi RPC input closed|Pi subprocess exited/,
    );

    transport.dispose();
    await processOwner.shutdown();
  });

  it('enforces request deadlines against a non-responsive real subprocess', async () => {
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
    }, 200);

    await expect(transport.request('fixture/hang')).rejects.toThrow('Request timeout');

    transport.dispose();
    await processOwner.shutdown();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for provider fixture process cleanup.');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
