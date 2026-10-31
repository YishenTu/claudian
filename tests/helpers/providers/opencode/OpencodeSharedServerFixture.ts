import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';

import type { ProviderExecutionRequest, ProviderSessionConfig } from '@/core/execution';
import { findNodeExecutable, getEnhancedPath } from '@/core/process/env';
import type { ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import type * as ProcessProbe from '@/core/process/ProcessProbe';
import { createProviderHistoryPathContext } from '@/core/providers/historyPathContext';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { SideChatSession } from '@/features/chat/side-chat/SideChatSession';
import { createOpencodeWorkspaceServices } from '@/providers/opencode/app/OpencodeWorkspaceServices';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';
import { buildOpencodeRuntimeEnv } from '@/providers/opencode/runtime/OpencodeRuntimeEnvironment';

// Spawning the fake server is slow on Windows CI runners.
vi.setConfig({ testTimeout: 45_000 });

// A cold Windows runner can exceed the product's 5-second version probe deadline even after the
// warmup below. This suite is not about that deadline, so give probes a budget under the test timeout.
vi.mock('@/core/process/ProcessProbe', async () => {
  const actual: typeof ProcessProbe = (await vi.importActual<typeof import('@/core/process/ProcessProbe')>('@/core/process/ProcessProbe'));
  return { ...actual, runProcessProbe: (options: ManagedStdioProcessOptions) => actual.runProcessProbe(options, 30_000) };
});

// On a cold Windows runner the first Node launch alone can take seconds, so pay that cost once here,
// without a deadline, before any test probes or starts the CLI.
beforeAll(() => {
  if (process.platform !== 'win32') return;
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-shared-v2-warmup-')));
  try {
    const cli = path.join(root, 'opencode.cjs');
    writeOpencodeNativePeer(cli, { scenario: 'workspace' });
    const node = findNodeExecutable(getEnhancedPath(process.env.PATH, cli));
    if (node) execFileSync(node, [cli, '--version'], { env: { ...process.env, PROCESS_LOG: path.join(root, 'processes') }, stdio: 'ignore' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const turn = (text: string): ProviderExecutionRequest => ({
  input: [{ type: 'text', text }],
  configuration: { model: 'opencode:local/chat', permissionMode: 'normal', systemInstructions: { kind: 'explicit', instructions: `Instructions for ${text}` } },
  toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal,
});

async function createFixture(version = '2.0.14') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-shared-v2-')));
  const cli = path.join(root, 'opencode.cjs'), log = path.join(root, 'processes');
  writeOpencodeNativePeer(cli, { scenario: 'workspace', version });
  writeFileSync(path.join(root, 'native.db'), '');
  const hostFixture = await createProviderHostFixture({
    settings: { providerConfigs: { opencode: { enabled: true, cliPath: cli, visibleModels: ['local/chat'], environmentVariables: `OPENCODE_DB=${path.join(root, 'native.db')}\nPROCESS_LOG=${log}\nOPENCODE_CONFIG_CONTENT={}` } } },
    overrides: { workingDirectory: root, getResolvedProviderCliPath: async () => cli },
  });
  const plugin = hostFixture.host;
  const register = vi.spyOn(plugin.sessionToolEndpoint, 'registerCallRoute');
  const runtimeHost = plugin.getRuntimeHost('opencode');
  const workspace = await createOpencodeWorkspaceServices(plugin);
  const backend = new OpencodeExecutionBackend(runtimeHost, workspace);
  const createSession = (config: Partial<ProviderSessionConfig> = {}) => backend.createSession({
    workingDirectory: root, lifecycle: 'persistent', nativePersistence: 'provider-default', ...config,
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
  });
  return { root, cli, log, plugin, workspace, backend, createSession, register,
    environment: buildOpencodeRuntimeEnv(runtimeHost.environmentText, cli),
    processes: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; db: string; generation?: string }) : [],
    async dispose() { await workspace.dispose?.(); await hostFixture.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function createSideFixture() {
  const f = await createFixture();
  await f.workspace.metadataService.loadCatalog();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const source = await control.request<{ data: { id: string } }>('/api/session', { method: 'POST', body: {} });
  const sourceState = { sessionId: source.data.id, databasePath: f.environment.OPENCODE_DB };
  const capabilities = opencodeProviderRegistration.capabilities;
  const history = opencodeProviderRegistration.historyService;
  ProviderWorkspaceRegistry.setServices('opencode', f.workspace);
  const side = new SideChatSession({
    providerId: 'opencode', ephemeral: capabilities.supportsEphemeralFork ?? capabilities.supportsEphemeralSessions,
    lifecycleRegistry: f.plugin.executionLifecycleRegistry, resolveBackend: () => f.backend,
    workingDirectory: f.root,
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
    buildChildResumeState: () => Promise.resolve(history.buildForkProviderState(source.data.id, 'msg_source', sourceState, f.root,
      { ...createProviderHistoryPathContext(f.plugin.settings, 'opencode', f.root), environment: f.environment, vaultPath: f.root }, { lifecycle: 'ephemeral' })),
  });
  return { ...f, control, side, sourceId: source.data.id,
    send: (text: string) => side.execute({ text, images: [], configuration: turn(text).configuration }),
    async dispose() { await side.dispose(); await control.dispose(); ProviderWorkspaceRegistry.setServices('opencode', undefined); await f.dispose(); },
  };
}

async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
}

export { createFixture, createSideFixture, isAlive, turn, waitFor };
