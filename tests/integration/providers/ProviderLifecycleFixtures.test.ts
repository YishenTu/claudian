import * as path from 'node:path';

import { AcpClientConnection } from '@/providers/acp/AcpClientConnection';
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

  it('runs the Kimi initialize/session/config/permission/prompt flow through a real ACP child', async () => {
    const processOwner = new AcpSubprocess({
      args: [fixturePath, 'kimi-acp'],
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
    const permissionRequests: unknown[] = [];
    const notifications: unknown[] = [];
    const connection = new AcpClientConnection({
      clientInfo: { name: 'claudian-kimi-fixture', version: '0.0.0' },
      delegate: {
        onSessionNotification: notification => {
          notifications.push(notification);
        },
        requestPermission: async request => {
          permissionRequests.push(request);
          return { outcome: { outcome: 'selected', optionId: 'approve_once' } };
        },
      },
      transport,
    });
    transport.start();

    try {
      const initialized = await connection.initialize();
      expect(initialized).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: 'Kimi Code CLI Fixture', version: '0.27.0' },
        authMethods: [{ id: 'login' }],
      });

      const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(session.sessionId).toBe('kimi-fixture-session');
      expect(session.configOptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'model', currentValue: 'kimi-code/k2' }),
        expect.objectContaining({ id: 'thinking', currentValue: 'off' }),
        expect.objectContaining({ id: 'mode', currentValue: 'default' }),
      ]));

      const configured = await connection.setConfigOption({
        configId: 'model',
        sessionId: session.sessionId,
        type: 'select',
        value: 'kimi-code/k3',
      });
      expect(configured.configOptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'model', currentValue: 'kimi-code/k3' }),
      ]));

      await expect(connection.prompt({
        prompt: [{ type: 'text', text: 'fixture prompt' }],
        sessionId: session.sessionId,
      })).resolves.toMatchObject({ stopReason: 'end_turn' });
      expect(permissionRequests).toEqual([
        expect.objectContaining({
          sessionId: 'kimi-fixture-session',
          options: expect.arrayContaining([
            expect.objectContaining({ optionId: 'approve_once' }),
            expect.objectContaining({ optionId: 'reject' }),
          ]),
        }),
      ]);
      expect(notifications).toEqual([
        expect.objectContaining({
          sessionId: 'kimi-fixture-session',
          update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
        }),
      ]);
    } finally {
      connection.dispose();
      transport.dispose();
      await processOwner.shutdown();
    }
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
