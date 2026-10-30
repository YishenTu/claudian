// @test-ci {"inputs":["src/providers/opencode/**","tests/{unit,integration}/providers/opencode/**"]}
import '@/providers';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';
import { testDate } from '@test/helpers/testClock';
import { hasNativeWSL } from '@test/helpers/WSLNativeTarget';
import { onTestFinished } from 'vitest';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderSessionConfig } from '@/core/execution';
import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { LoopbackSessionToolServer } from '@/core/session-tools/LoopbackSessionToolServer';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { OpencodeHTTPSessionKernel } from '@/providers/opencode/execution/OpencodeHTTPSessionKernel';
import { OpencodeSessionPersistence } from '@/providers/opencode/execution/OpencodeSessionPersistence';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { opencodeEnvironment, opencodeHostPath, opencodeTargetPath } from '@/providers/opencode/runtime/OpencodeExecutionTarget';

const cli = process.env.CLAUDIAN_OPENCODE_WSL_CLI;
const available = hasNativeWSL();
if (process.env.CLAUDIAN_REQUIRE_WSL === '1' && !cli) throw new Error('The WSL job must install OpenCode v2 and set CLAUDIAN_OPENCODE_WSL_CLI.');

// Run the fake model in Linux, so Windows -> WSL HTTP is the only network crossing.
// CI uses WSL1; this is also runnable on real NAT/mirrored WSL2 developer machines.
const fakeModel = String.raw`
const fs = require('node:fs'), http = require('node:http');
const server = http.createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const request = JSON.parse(text);
  fs.appendFileSync(process.argv[2], JSON.stringify(request) + '\n');
  const replied = !request.tools?.some(tool => tool.function?.name === 'claudian_list_destinations') || request.messages?.some(message => message.role === 'tool');
  const chunk = { id: 'fake', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta: replied
    ? { content: 'Reply from OpenCode in WSL.' }
    : { role: 'assistant', tool_calls: [{ index: 0, id: 'call_wsl', type: 'function', function: { name: 'claudian_list_destinations', arguments: '{}' } }] }, finish_reason: replied ? 'stop' : 'tool_calls' }] };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port }) + '\n'));
process.stdin.resume(); process.stdin.on('end', () => { server.closeAllConnections(); server.close(); });
`;

describe.skipIf(!available || !cli)('native OpenCode WSL adoption', () => {
  it.each(['drive', 'distro'] as const)('runs auth/SSE, plugin relay, store binding and API read from a %s vault', { timeout: 120_000 }, async location => {
    const target = await resolveExecutionTargetAsync({ settings: { installationMethod: 'wsl', wslDistroOverride: '' } });
    const root = await mkdtemp(location === 'drive'
      ? path.join(tmpdir(), 'claudian-opencode-wsl-')
      : path.win32.join(opencodeHostPath('/tmp', target), 'claudian-opencode-wsl-'));
    // Keep cleanup errors separate so they cannot hide a failed native assertion.
    onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const targetRoot = opencodeTargetPath(root, target);
    const log = path.join(root, 'requests.jsonl');
    const fakeFile = path.join(root, 'fake-model.cjs');
    await writeFile(fakeFile, fakeModel);
    await mkdir(path.join(root, 'home'));
    const modelSpec = buildTargetLaunchSpec({ target, hostCwd: root, command: 'node', args: [opencodeTargetPath(fakeFile, target), opencodeTargetPath(log, target)], env: opencodeEnvironment(process.env) });
    const model = new ManagedStdioProcess({ ...modelSpec, cwd: modelSpec.spawnCwd });
    model.start();
    const modelClosed = new Promise<void>(resolve => model.onClose(() => resolve()));
    const modelURL = await new Promise<string>((resolve, reject) => {
      let text = '';
      model.onError(reject);
      model.onClose(state => reject(new Error(`Fake model closed before readiness (code=${state.code}, signal=${state.signal}): ${model.getStderrSnapshot() || 'no stderr'}`)));
      model.stdout.on('data', chunk => {
        text += String(chunk);
        if (text.includes('\n')) resolve((JSON.parse(text.slice(0, text.indexOf('\n'))) as { url: string }).url);
      });
    });
    const endpoint = new LoopbackSessionToolServer();
    const service = new OpencodeServerService(endpoint);
    const list = vi.fn(async () => ({ sessions: [{ sessionId: 'peer', title: 'WSL relay 中文', provider: 'opencode', status: 'idle' as const, active: false }] }));
    const environmentText = Object.entries({
      HOME: `${targetRoot}/home`, XDG_CONFIG_HOME: `${targetRoot}/config`, XDG_CACHE_HOME: `${targetRoot}/cache`,
      XDG_DATA_HOME: '', OPENCODE_CONFIG: '',
      OPENCODE_DB: location === 'distro' ? `${targetRoot}/custom/native.db` : '',
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { fake: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `${modelURL}/v1`, apiKey: 'test-only' }, models: { fake: { name: 'Fake', limit: { context: 32768, output: 4096 } } } } }, model: 'fake/fake' }),
    }).map(([key, value]) => `${key}=${value}`).join('\n');
    const settings = { providerConfigs: { opencode: {
      enabled: true, cliPathsByHost: { [getInstallationKey()]: cli! },
      installationMethodsByHost: { [getInstallationKey()]: 'wsl' }, wslDistroOverridesByHost: { [getInstallationKey()]: target.distroName! },
      environmentVariables: environmentText,
    } } };
    const host = runtimeHostFor({ settings, workingDirectory: root, sessionToolEndpoint: endpoint, getResolvedProviderCliPath: () => cli! }, 'opencode');
    const config: ProviderSessionConfig = { workingDirectory: root, lifecycle: 'persistent', nativePersistence: 'provider-default', interactionPort: { requestApproval: async request => ({ interactionId: request.interactionId, decision: 'allow' }), askUserQuestion: async request => ({ interactionId: request.interactionId, answers: {} }), dismissInteraction() {} }, sessionTools: { list, read: async () => { throw new Error('unused'); }, send: async () => { throw new Error('unused'); } } };
    const output: unknown[] = [];
    const kernel = new OpencodeHTTPSessionKernel({ host, config, getActiveTurnId: () => 'wsl', sessionInstanceId: 'wsl', onClosed: error => output.push(error), onNativeOutput: event => output.push(event) }, service, new OpencodeSessionPersistence(config));
    let serverURL: string | undefined;
    const start = ManagedStdioProcess.prototype.start;
    const observation = vi.spyOn(ManagedStdioProcess.prototype, 'start').mockImplementation(function (this: ManagedStdioProcess) {
      start.call(this);
      let text = '';
      this.stdout.on('data', chunk => {
        text += String(chunk);
        if (text.startsWith('{') && text.includes('\n')) {
          try { const ready = JSON.parse(text.slice(0, text.indexOf('\n'))) as { url?: string }; if (ready.url) serverURL = ready.url; } catch { /* Environment and version probes are not readiness records. */ }
        }
      });
    });
    let messaging: SessionMessagingService | undefined;
    try {
      await kernel.connect({ profile: 'managed', systemPrompt: `Working directory: ${targetRoot}` });
      const session = await kernel.openSession();
      const expectedDatabase = opencodeHostPath(location === 'drive' ? `${targetRoot}/home/.local/share/opencode/opencode.db` : `${targetRoot}/custom/native.db`, target);
      expect(session.databasePath).toBe(expectedDatabase);
      expect(serverURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+/u);
      expect([401, 403]).toContain((await fetch(new URL('/api/info', serverURL))).status);
      await kernel.setModel(session.sessionId, 'fake/fake');
      kernel.setAutoApprove(true);
      await kernel.prompt(session.sessionId, { text: 'List sessions', files: [], userText: null }, { toolPolicy: { kind: 'provider-default' }, signal: AbortSignal.timeout(40_000) });
      expect(list).toHaveBeenCalledTimes(1);
      expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_completed', isError: false, content: expect.stringContaining('WSL relay 中文') })]));
      const environment = await service.targetEnvironment.resolve(target, root, environmentText, cli!);
      const control = await service.acquire(cli!, root, environment, undefined, target);
      try {
        expect(await control.request(`/api/session/${session.sessionId}`)).toMatchObject({ data: { location: { directory: targetRoot } } });
      } finally { await control.dispose(); }
      // The public API must hydrate the Linux database through the same provider policy.
      ProviderWorkspaceRegistry.setServices('opencode', { serverService: service } as any);
      const repository = new ConversationRepository({
        providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator, getSettings: () => settings, getVaultPath: () => root, onConversationDeleted: async () => undefined,
        persistence: {
          metadataReader: { revalidate: vi.fn(), load: vi.fn(), scan: vi.fn(), loadMetadata: vi.fn(), scanMetadata: vi.fn(), listMetadata: vi.fn() },
          saveMetadata: async () => undefined, deleteCurrentMetadata: async () => undefined, assignMetadataToDevice: async () => undefined,
        } as ConversationPersistence,
      });
      repository.replaceAll([{ id: 'conversation', providerId: 'opencode', sessionId: session.sessionId, messages: [], title: 'WSL', providerState: { databasePath: session.databasePath }, createdAt: testDate().getTime(), lastActivityAt: testDate().getTime() } as Conversation]);
      const chatHost = { ensureConversationMetadataLoaded: async () => undefined, getConversationById: (id: string) => repository.getById(id), sessionRuntimes: { get: () => undefined } } as unknown as ChatFeatureHost;
      messaging = new SessionMessagingService({ getHost: () => chatHost, getActiveConversationId: () => null, refreshModelControls: () => undefined });
      expect(await createClaudianAPI(messaging).read('conversation')).toContain('Reply from OpenCode in WSL.');
      const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { messages?: Array<{ role: string; content: unknown }> });
      expect(requests.flatMap(request => request.messages ?? [])).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', content: expect.stringContaining('WSL relay 中文') })]));
    } finally {
      observation.mockRestore();
      await messaging?.dispose();
      ProviderWorkspaceRegistry.setServices('opencode', undefined);
      await kernel.dispose();
      await service.dispose();
      await endpoint.close();
      // EOF closes the Linux fixture itself; killing wsl.exe does not prove that.
      model.stdin.end();
      await modelClosed;
    }
  });
});
