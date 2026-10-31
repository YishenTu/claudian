import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import type { ProviderSessionConfig } from '@/core/execution';
import { SESSION_TOOL_ROUTE_HEADER } from '@/core/session-tools/SessionToolEndpoint';
import { OpencodeHTTPSessionKernel } from '@/providers/opencode/execution/OpencodeHTTPSessionKernel';
import { OpencodeSessionPersistence } from '@/providers/opencode/execution/OpencodeSessionPersistence';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { resolveOpencodeTarget } from '@/providers/opencode/runtime/OpencodeExecutionTarget';

interface FakeLLMRequest {
  tools?: Array<{ function?: { name?: string } }>;
  messages?: Array<{ role: string; content?: unknown }>;
}

// Opt in with a real installed v2 binary. The normal suite has no OpenCode installation dependency.
const cli = process.env.CLAUDIAN_OPENCODE_NATIVE_CLI;
it.skipIf(!cli)('registers session tools and carries the native caller through a spawned relay in OpenCode v2', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-opencode-native-'));
  const callers: string[] = [];
  const outputs: unknown[] = [];
  const requests: FakeLLMRequest[] = [];
  const fakeLLM = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as FakeLLMRequest;
    requests.push(request);
    const replied = !request.tools?.some(tool => tool.function?.name === 'claudian_list_destinations') || request.messages?.some(message => message.role === 'tool');
    const chunk = { id: 'fake', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta: replied
      ? { content: 'Verified relay result.' }
      : { role: 'assistant', tool_calls: [{ index: 0, id: 'call_native', type: 'function', function: { name: 'claudian_list_destinations', arguments: '{}' } }] }, finish_reason: replied ? 'stop' : 'tool_calls' }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => fakeLLM.listen(0, '127.0.0.1', resolve));
  const address = fakeLLM.address() as { port: number };
  const fixture = await createProviderHostFixture({ overrides: { workingDirectory: root, getResolvedProviderCliPath: async () => cli! } });
  const service = new OpencodeServerService(fixture.host.sessionToolEndpoint);
  const host = fixture.host.getRuntimeHost('opencode');
  const route = await fixture.host.sessionToolEndpoint.registerCallRoute(async request => {
    callers.push(request.callerNativeId);
    return { isError: false, text: 'verified relay 中文' };
  });
  // Native macOS/Linux stand-in for the Windows executable: the plugin still spawns a real child.
  // The WSL suite exercises the actual PowerShell relay across interop.
  const relay = path.join(root, 'relay.cjs');
  await writeFile(relay, `const { createInterface } = require('node:readline');
const input = createInterface({ input: process.stdin });
const controller = new AbortController();
input.on('close', () => controller.abort());
input.once('line', async line => {
  try {
    const response = await fetch(process.env.TEST_RELAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', [${JSON.stringify(SESSION_TOOL_ROUTE_HEADER)}]: process.env.TEST_RELAY_ROUTE }, body: line, signal: controller.signal });
    if (!response.ok) process.exitCode = 1;
    else process.stdout.write(await response.text() + '\\n');
  } catch { process.exitCode = 1; }
  input.close();
});
`);
  const env = {
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
    OPENCODE_CONFIG: '', OPENCODE_DB: path.join(root, 'native.db'), OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    CLAUDIAN_SESSION_TOOLS_RELAY: JSON.stringify({ command: process.execPath, args: [relay], env: { TEST_RELAY_URL: route.url, TEST_RELAY_ROUTE: route.routeId } }),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { fake: { name: 'Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-only' }, models: { fake: { name: 'Fake', limit: { context: 32768, output: 4096 } } } } }, model: 'fake/fake' }),
  };
  await mkdir(env.HOME);
  // Seeded before any consumer reads the settings; the relay route is only known once the host exists.
  Object.assign(fixture.settings.providerConfigs, { opencode: { enabled: true, environmentVariables: Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') } });
  const config: ProviderSessionConfig = { workingDirectory: root, lifecycle: 'persistent', nativePersistence: 'provider-default', interactionPort: { requestApproval: async request => ({ interactionId: request.interactionId, decision: 'allow' }), askUserQuestion: async request => ({ interactionId: request.interactionId, answers: {} }), dismissInteraction() {} } };
  const kernel = new OpencodeHTTPSessionKernel({ host, config, getActiveTurnId: () => 'native-test', sessionInstanceId: 'native-test', onClosed: error => outputs.push(error), onNativeOutput: event => outputs.push(event) }, service, new OpencodeSessionPersistence(config));
  try {
    await kernel.connect({ profile: 'managed', systemPrompt: 'Call the session tool then finish.' });
    const session = await kernel.openSession();
    const target = await resolveOpencodeTarget(host.config, root);
    const environment = await service.targetEnvironment.resolve(target, root, host.environmentText, cli!);
    const control = await service.acquire(cli!, root, environment, undefined, target);
    try {
      expect(await control.request(`/api/session/${session.sessionId}`)).toMatchObject({ data: { location: { directory: root } } });
    } finally { await control.dispose(); }
    await kernel.setModel(session.sessionId, 'fake/fake');
    kernel.setAutoApprove(true);
    await kernel.prompt(session.sessionId, { text: 'List sessions', files: [], userText: null }, { toolPolicy: { kind: 'provider-default' }, signal: AbortSignal.timeout(25_000) });
    expect(callers).toEqual([session.sessionId]);
    expect(requests.flatMap(request => request.tools ?? [])).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'claudian_list_destinations' }) })]));
    expect(requests.flatMap(request => request.messages ?? [])).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', content: expect.stringContaining('verified relay 中文') })]));
    expect(outputs).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_completed', isError: false })]));
  } finally {
    await kernel.dispose();
    await service.dispose();
    route.dispose();
    await fixture.dispose();
    fakeLLM.closeAllConnections();
    await new Promise<void>(resolve => fakeLLM.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
