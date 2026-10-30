import { once } from 'node:events';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { PiNativeProcess } from '@test/helpers/providers/pi/PiNativeProcess';
import spawn from 'cross-spawn';

import { PiModelDiscoveryService } from '@/providers/pi/runtime/PiModelDiscoveryService';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

async function createPlugin(enabled = true) {
  return (await createProviderHostFixture({
    overrides: { workingDirectory: '/tmp/vault', getResolvedProviderCliPath: vi.fn(async () => '/usr/local/bin/pi') },
    settings: { providerConfigs: { pi: { enabled } } },
  })).host;
}

let native: PiNativeProcess;
beforeEach(() => {
  native = new PiNativeProcess({}, new Map(), () => new Promise(() => undefined));
  vi.mocked(spawn).mockReturnValue(native.child);
});
afterEach(() => {
  native.child.stdin.destroy();
  native.child.stdout.destroy();
  native.child.stderr.destroy();
  vi.mocked(spawn).mockReset();
  vi.useRealTimers();
});

function respond(id: string, response: Record<string, unknown>): void {
  native.child.stdout.push(JSON.stringify({ type: 'response', id, ...response }) + '\n');
}

function expectReleased(): void {
  expect(native.child.killed).toBe(true);
  expect(native.child.stdout.listenerCount('data')).toBe(0);
  expect(native.child.listenerCount('exit')).toBe(0);
}

it('does not launch Pi when the provider is disabled', async () => {
  const plugin = await createPlugin(false);

  await expect(new PiModelDiscoveryService(plugin.getRuntimeHost('pi')).discoverModels())
    .resolves.toEqual({ kind: 'skipped', reason: 'provider-disabled' });

  expect(plugin.getResolvedProviderCliPath).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(native.requests).toEqual([]);
});

it('discovers normalized models over RPC, cancels extension dialogs, and releases the no-session runtime', async () => {
  const requestWritten = once(native.child.stdin, 'data');
  const discovery = new PiModelDiscoveryService((await createPlugin()).getRuntimeHost('pi')).discoverModels();
  const [chunk] = await requestWritten;
  const request = JSON.parse(chunk.toString());
  expect(request).toEqual({ id: expect.any(String), type: 'get_available_models' });
  expect(spawn).toHaveBeenCalledWith('/usr/local/bin/pi', ['--mode', 'rpc', '--no-session'], expect.objectContaining({ cwd: '/tmp/vault' }));
  expect(spawn).toHaveBeenCalledTimes(1);

  const dialogReply = once(native.child.stdin, 'data');
  native.child.stdout.push('{"type":"extension_ui_request","id":"ui-1"}\n');
  const [reply] = await dialogReply;
  expect(JSON.parse(reply.toString())).toEqual({
    cancelled: true, id: 'ui-1', type: 'extension_ui_response',
  });

  respond(request.id, { success: true, data: { models: [{
    contextWindow: 200000, id: 'gpt-5', input: ['text', 'image'], maxTokens: 8192,
    name: 'GPT-5', provider: 'openai', reasoning: true, thinkingLevelMap: { max: 'max' },
  }] } });

  await expect(discovery).resolves.toEqual({ kind: 'completed', models: [{
    contextWindow: 200000, encodedId: 'pi:openai/gpt-5', id: 'gpt-5', input: ['text', 'image'],
    label: 'GPT-5', maxTokens: 8192, provider: 'openai', reasoning: true,
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'max'],
  }] });
  expectReleased();
});

it('returns native failure diagnostics and releases the runtime', async () => {
  const requestWritten = once(native.child.stdin, 'data');
  const discovery = new PiModelDiscoveryService((await createPlugin()).getRuntimeHost('pi')).discoverModels();
  const [chunk] = await requestWritten;
  native.child.stderr.push('Pi stderr');
  respond(JSON.parse(chunk.toString()).id, { success: false, error: 'not logged in' });

  await expect(discovery).resolves.toEqual({
    diagnostics: 'not logged in\n\nPi stderr', kind: 'completed', models: [],
  });
  expectReleased();
});

it('keeps the discovery pending until its 20 second RPC deadline and then releases the runtime', async () => {
  vi.useFakeTimers();
  const requestWritten = once(native.child.stdin, 'data');
  const discovery = new PiModelDiscoveryService((await createPlugin()).getRuntimeHost('pi')).discoverModels();
  await requestWritten;
  let settled = false;
  void discovery.then(() => { settled = true; });

  await vi.advanceTimersByTimeAsync(19_999);
  expect(settled).toBe(false);
  expect(native.child.killed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  await expect(discovery).resolves.toEqual({
    diagnostics: 'Request timeout: get_available_models (20000ms)', kind: 'completed', models: [],
  });
  expectReleased();
});
