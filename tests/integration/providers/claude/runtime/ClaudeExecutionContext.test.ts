import '@/providers';

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderExecutionEvent } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { resolveChatSystemInstructions } from '@/features/chat/execution/chatExecutionConfiguration';
import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

// The test alias resolves the SDK to the shared fake, whose controls are outside the SDK's types.
const sdkMock = sdkModule as unknown as {
  getLastOptions(): sdkModule.Options | undefined;
  resetMockMessages(): void;
  setMockMessages(messages: unknown[], options?: { appendResult?: boolean }): void;
  setMockRewindFiles(implementation: sdkModule.Query['rewindFiles']): void;
};
const unexpectedInteraction = () => { throw new Error('No interaction expected'); };
const interactionPort = { requestApproval: unexpectedInteraction, askUserQuestion: unexpectedInteraction, dismissInteraction: () => {} };
let native: WSLProcessFixture;
beforeEach(() => {
  native = new WSLProcessFixture();
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
});

it.each([
  ['win32', 'wsl', 'C:\\Vault', '/mnt/c/Vault'],
  ['win32', 'wsl', '\\\\wsl$\\Ubuntu\\home\\linux\\vault', '/home/linux/vault'],
  ['win32', 'native-windows', 'C:\\Vault', 'C:\\Vault'],
  ['darwin', 'wsl', '/Users/me/vault', '/Users/me/vault'],
] as const)('aligns Claude Main Agent and Inline Edit instructions with cwd on %s/%s: %s', async (platform, method, hostPath, executionPath) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  sdkMock.resetMockMessages();
  try {
    const key = getInstallationKey();
    const { host } = await createProviderHostFixture({ vault: sharedVault,
      settings: { model: 'sonnet', providerConfigs: { claude: { ...claudeCatalogFixture(['sonnet']),
        installationMethodsByHost: { [key]: method }, wslDistroOverridesByHost: { [key]: 'Ubuntu' },
      } } },
      overrides: { workingDirectory: hostPath, getResolvedProviderCliPath: async () => '/usr/bin/claude' },
    });
    const expectPrompt = (instructions: string) => {
      const options = sdkMock.getLastOptions();
      expect(options?.cwd).toBe(executionPath);
      const text = (options?.systemPrompt as { prompt: string }).prompt;
      expect(text).toContain(`Vault absolute path: ${executionPath}`);
      expect(text).toContain('Resolve Vault-relative context paths against the Vault absolute path');
      expect(text).toContain(instructions.trim());
    };

    const customText = 'Keep this literal example: C:\\Custom\\Example.md';
    const targetPath = await ProviderRegistry.resolveExecutionWorkingDirectory(host, 'claude', hostPath);
    const systemInstructions = resolveChatSystemInstructions({ systemPrompt: customText, mediaFolder: '', userName: '' }, targetPath);
    expect(systemInstructions.instructions).toContain(customText);
    const session = new ClaudeExecutionBackend(host.getRuntimeHost('claude')).createSession({
      lifecycle: 'persistent', nativePersistence: 'disabled-if-supported', workingDirectory: hostPath,
      interactionPort,
    });
    try {
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({ input: [{ type: 'text', text: 'Read note.md' }],
        configuration: { model: 'sonnet', reasoning: null, permissionMode: 'manual', systemInstructions },
        toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
      }).events) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      expectPrompt(systemInstructions.instructions);
    } finally { await session.dispose(); }

    // Inline Edit resolves its own working directory through the provider registration.
    const inlineEdit = ProviderRegistry.createInlineEditService(host, 'claude');
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'inline-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '<replacement>Done</replacement>' }] } },
      { type: 'result', subtype: 'success' },
    ]);
    try {
      await expect(inlineEdit.send({ instruction: 'Tighten', mode: 'selection', notePath: 'note.md', selectedText: 'Draft' }))
        .resolves.toMatchObject({ success: true });
      expectPrompt(`Vault absolute path: ${executionPath}`);
      expect((sdkMock.getLastOptions()?.systemPrompt as { prompt: string }).prompt).not.toContain(customText);
    } finally { inlineEdit.end(); }
  } finally { Object.defineProperty(process, 'platform', { value: originalPlatform }); }
});

it('completes a successful WSL turn when the optional native-history environment probe fails', async () => {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  sdkMock.resetMockMessages();
  const key = getInstallationKey();
  native.reply = request => request.executable === '/usr/bin/awk' ? { stderr: 'awk: not found', code: 127 } : undefined;
  try {
    const { host } = await createProviderHostFixture({ vault: sharedVault,
      settings: { model: 'sonnet', providerConfigs: { claude: { ...claudeCatalogFixture(['sonnet']),
        installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' },
      } } },
      overrides: { workingDirectory: 'C:\\Vault', getResolvedProviderCliPath: async () => '/usr/bin/claude' },
    });
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'session-result' },
      { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: 'Successful reply' }] } },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, usage: { output_tokens: 10 } },
    ], { appendResult: false });
    const session = new ClaudeExecutionBackend(host.getRuntimeHost('claude')).createSession({
      lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: 'C:\\Vault', interactionPort,
    });
    try {
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({ input: [{ type: 'text', text: 'Hello' }],
        configuration: { model: 'sonnet', reasoning: null, permissionMode: 'manual',
          systemInstructions: { kind: 'explicit', instructions: 'Reply.' } },
        toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
      }).events) events.push(event);
      // Turn statistics reach the Linux store probe, which fails in the distro.
      expect(native.requests.map(request => request.executable)).toEqual(['/usr/bin/awk']);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(events.some(event => event.type === 'execution_error')).toBe(false);
    } finally { await session.dispose(); }
  } finally { Object.defineProperty(process, 'platform', { value: platform }); }
});

// WindowsHostFS models Windows paths on POSIX hosts; on Windows they are real host paths.
it.skipIf(process.platform === 'win32')('reports live WSL tool paths and rewind changes at their Windows host paths', async () => {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  onTestFinished(() => { Object.defineProperty(process, 'platform', { value: platform }); });
  sdkMock.resetMockMessages();
  const files = createWindowsHostFS({ fs, fsPromises });
  await files.write('C:\\Vault\\note.md', 'Current note');
  const key = getInstallationKey();
  const { host } = await createProviderHostFixture({ vault: sharedVault,
    settings: { model: 'sonnet', providerConfigs: { claude: { ...claudeCatalogFixture(['sonnet']),
      installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' },
    } } },
    overrides: { workingDirectory: 'C:\\Vault', getResolvedProviderCliPath: async () => '/usr/bin/claude' },
  });
  sdkMock.setMockMessages([
    { type: 'system', subtype: 'init', session_id: 'wsl-session' },
    { type: 'assistant', uuid: 'assistant-1', message: { content: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/mnt/c/Vault/note.md' } },
    ] } },
    { type: 'user', uuid: 'result-1', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'Current note' }] } },
    { type: 'assistant', uuid: 'assistant-2', message: { content: [{ type: 'text', text: 'Read it' }] } },
  ]);
  // The CLI reports checkpointed files at their Linux paths.
  sdkMock.setMockRewindFiles(async () => ({ canRewind: true, filesChanged: ['/mnt/c/Vault/note.md'] }));
  const session = new ClaudeExecutionBackend(host.getRuntimeHost('claude')).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: 'C:\\Vault', interactionPort,
  });
  try {
    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute({ input: [{ type: 'text', text: 'Read note.md' }],
      configuration: { model: 'sonnet', reasoning: null, permissionMode: 'yolo',
        systemInstructions: { kind: 'explicit', instructions: 'Reply.' } },
      toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
    }).events) events.push(event);
    expect(events.find(event => event.type === 'tool_started')).toMatchObject({
      name: 'Read', input: { file_path: 'C:\\Vault\\note.md' },
    });
    await expect(session.rewind('user-1', undefined)).resolves.toMatchObject({
      canRewind: true, filesChanged: ['C:\\Vault\\note.md'],
    });
    expect(await files.read('C:\\Vault\\note.md')).toBe('Current note');
  } finally { await session.dispose(); }
});

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
