import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { createFixture, createSideFixture, isAlive, turn } from '@test/helpers/providers/opencode/OpencodeSharedServerFixture';

import { type ProviderExecutionEvent, type ProviderSessionConfig } from '@/core/execution';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';

it('runs auxiliary sessions with saved credentials without persisting them or replacing the catalog', async () => {
  const f = await createFixture();
  const session = f.createSession({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' });
  try {
    expect(await f.workspace.metadataService.loadCatalog()).toBe(true);
    const request = turn('title');
    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute({ ...request, toolPolicy: { kind: 'passive' } }).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(getOpencodeProviderSettings(f.plugin.settings).discoveredModels.map(model => model.rawId)).toEqual(['local/chat']);
    expect(f.processes().map(process => process.db)).toEqual([f.environment.OPENCODE_DB]);
    await session.dispose();
    const lease = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await expect(lease.request('/api/session/ses_1')).rejects.toThrow('404');
    await lease.dispose();
  } finally { await session.dispose(); await f.dispose(); }
}, 15000);

it('deletes an auxiliary session whose creation was still pending during disposal', async () => {
  const f = await createFixture();
  const session = f.createSession({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' });
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const sessions = () => control.request<{ data: { ids: string[]; held: number } }>('/fixture/sessions').then(result => result.data);
  try {
    expect(await f.workspace.metadataService.loadCatalog()).toBe(true);
    await control.request('/fixture/hold-sessions', { method: 'POST' });
    const request = turn('title');
    const run = session.execute({ ...request, toolPolicy: { kind: 'passive' } });
    const consume = (async () => { const events: ProviderExecutionEvent[] = []; for await (const event of run.events) events.push(event); })();
    const deadline = Date.now() + 5000;
    while ((await sessions()).held === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await sessions()).held).toBe(1);
    const disposal = session.dispose();
    await new Promise(resolve => setTimeout(resolve, 50));
    await control.request('/fixture/release-sessions', { method: 'POST' });
    await disposal;
    await consume;
    expect((await sessions()).ids).toEqual([]);
  } finally { await control.dispose(); await session.dispose(); await f.dispose(); }
}, 15000);

it('retains a v2 side fork across turns and connection replacement, then deletes only the child on discard', async () => {
  const f = await createSideFixture();
  const prompts = () => readFileSync(path.join(f.root, 'processes.prompts'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { sessionID: string; context: string[]; text: string });
  const promptText = (text: string) => expect.stringContaining(text);
  try {
    // The source's native context exists before the side chat forks it.
    await f.control.request(`/api/session/${f.sourceId}/prompt`, { method: 'POST', body: { text: 'Remember A' } });
    expect(await f.send('first side turn')).toMatchObject({ status: 'completed' });
    const childId = f.side.providerSessionId!;
    expect(childId).not.toBe(f.sourceId);
    expect(prompts().at(-1)).toEqual({ sessionID: childId, text: promptText('first side turn'), context: ['Remember A', 'Reply to Remember A'] });
    // Changed instructions replace the kernel, but must not delete the side session.
    expect(await f.send('second side turn')).toMatchObject({ status: 'completed' });
    expect(f.side.providerSessionId).toBe(childId);
    const firstSide = prompts().at(-2)!.text;
    expect(prompts().at(-1)).toEqual({
      sessionID: childId, text: promptText('second side turn'),
      context: ['Remember A', 'Reply to Remember A', firstSide, `Reply to ${firstSide}`],
    });
    // Side turns never enter the parent's native context.
    await f.control.request(`/api/session/${f.sourceId}/prompt`, { method: 'POST', body: { text: 'Continue main' } });
    expect(prompts().at(-1)).toEqual({ sessionID: f.sourceId, text: 'Continue main', context: ['Remember A', 'Reply to Remember A'] });
    expect(await f.control.request(`/api/session/${childId}`)).toMatchObject({ data: { id: childId } });
    await f.side.dispose();
    await f.side.dispose();
    await expect(f.control.request(`/api/session/${childId}`)).rejects.toThrow('404');
    expect(await f.control.request(`/api/session/${f.sourceId}`)).toMatchObject({ data: { id: f.sourceId } });
    expect(await f.control.request('/fixture/sessions')).toMatchObject({ data: { ids: [f.sourceId], deleted: [childId] } });
  } finally { await f.dispose(); }
});

it('discards a v2 side fork whose native creation finishes after disposal starts', async () => {
  const f = await createSideFixture();
  try {
    await f.control.request('/fixture/hold-sessions', { method: 'POST' });
    const run = f.send('discard during fork');
    const deadline = Date.now() + 5000;
    while ((await f.control.request<{ data: { held: number } }>('/fixture/sessions')).data.held === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await f.control.request('/fixture/sessions')).toMatchObject({ data: { held: 1 } });
    const disposal = f.side.dispose();
    await f.control.request('/fixture/release-sessions', { method: 'POST' });
    await disposal;
    await run;
    expect(await f.control.request('/fixture/sessions')).toMatchObject({ data: { ids: [f.sourceId] } });
  } finally { await f.dispose(); }
});

it.each([false, true])('deletes the side child after a server disconnect (retry: %s)', async retry => {
  const f = await createSideFixture();
  let next: Awaited<ReturnType<typeof f.workspace.serverService.acquire>> | undefined;
  try {
    expect(await f.send('side before disconnect')).toMatchObject({ status: 'completed' });
    const childId = f.side.providerSessionId!;
    let disconnected!: () => void;
    const failed = new Promise<void>(resolve => { disconnected = resolve; });
    await f.control.subscribe(() => undefined, disconnected, () => false);
    await f.control.request('/fixture/disconnect', { method: 'POST' }).catch(() => undefined);
    await failed;
    const retried = retry ? await f.send('side after reconnect') : undefined;
    expect(retried?.status).toBe(retry ? 'completed' : undefined);
    await f.side.dispose();
    next = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    expect(await next.request('/fixture/sessions')).toMatchObject({ data: { ids: [f.sourceId], deleted: [childId] } });
  } finally { await next?.dispose(); await f.dispose(); }
});

it.each([
  ['an environment change', 'Current catalog'],
  ['a default database change that keeps the bound server', 'Chat replacement.db'],
] as const)('does not republish superseded execution metadata after %s', async (_, currentLabel) => {
  const f = await createFixture();
  const session = f.createSession();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  let consume: Promise<void> | undefined;
  try {
    await f.workspace.metadataService.loadCatalog();
    await control.request('/fixture/hold-sessions', { method: 'POST' });
    consume = (async () => { for await (const event of session.execute(turn('late metadata')).events) { void event; } })();
    const deadline = Date.now() + 3000;
    const held = async () => (await control.request<{ data: { held: number } }>('/fixture/sessions')).data.held;
    while (!await held() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await held()).toBe(1);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      const config = getOpencodeProviderSettings(f.plugin.settings);
      config.environmentVariables = currentLabel === 'Current catalog'
        ? `${config.environmentVariables}\nGENERATION=${currentLabel}`
        : config.environmentVariables.replace(f.environment.OPENCODE_DB!, path.join(f.root, 'replacement.db'));
      updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: config.environmentVariables });
    });
    await f.workspace.metadataService.loadCatalog();
    const currentModels = getOpencodeProviderSettings(f.plugin.settings).discoveredModels;
    expect(currentModels[0].label).toContain(currentLabel);
    await control.request('/fixture/release-sessions', { method: 'POST' });
    await consume;
    expect(getOpencodeProviderSettings(f.plugin.settings).discoveredModels).toEqual(currentModels);
  } finally { await control.request('/fixture/release-sessions', { method: 'POST' }).catch(() => undefined); await session.dispose(); await consume; await control.dispose(); await f.dispose(); }
});

it('owns a late ephemeral creation response on its original generation across a settings transition', async () => {
  const f = await createFixture();
  const session = f.createSession({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported' });
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const inventory = () => control.request<{ data: { ids: string[]; held: number; deleted: string[] } }>('/fixture/sessions').then(result => result.data);
  let consume: Promise<void> | undefined;
  try {
    await f.workspace.metadataService.loadCatalog();
    await control.request('/fixture/hold-sessions', { method: 'POST' });
    consume = (async () => { for await (const event of session.execute(turn('late')).events) { void event; } })();
    const deadline = Date.now() + 3000;
    while (!(await inventory()).held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await inventory()).held).toBe(1);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=late' }); });
    const disposal = session.dispose();
    await control.request('/fixture/release-sessions', { method: 'POST' });
    await disposal;
    await consume;
    expect(await inventory()).toMatchObject({ ids: [], deleted: ['ses_1'] });
    expect(f.processes()).toHaveLength(1);
    const pid = f.processes()[0].pid;
    await control.dispose();
    expect(isAlive(pid)).toBe(false);
  } finally { await control.dispose(); await session.dispose(); await consume; await f.dispose(); }
}, 10000);

it('disables without deadlocking cleanup for an ephemeral session whose original generation already drained', async () => {
  const f = await createFixture();
  await f.workspace.startRuntime?.();
  await f.workspace.metadataService.loadCatalog();
  const config: ProviderSessionConfig = { workingDirectory: f.root, lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported',
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} } };
  const owned = f.plugin.executionLifecycleRegistry.acquire(f.backend, config, 'chat');
  let disabling: Promise<void> | undefined;
  try {
    for await (const event of owned.session.execute(turn('auxiliary')).events) expect(event.type).not.toBe('execution_error');
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=cleanup' }); });
    const pid = f.processes()[0].pid;
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(isAlive(pid)).toBe(false);
    let disabled = false;
    disabling = f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { updateOpencodeProviderSettings(f.plugin.settings, { enabled: false }); }).then(() => { disabled = true; });
    const disableDeadline = Date.now() + 3000;
    while (!disabled && Date.now() < disableDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(disabled).toBe(true);
    expect(JSON.parse(readFileSync(f.environment.OPENCODE_DB! + '.sessions.json', 'utf8')).deleted).toEqual(['ses_1']);
    expect(f.processes().some(native => isAlive(native.pid))).toBe(false);
  } finally {
    // Release a broken implementation's gate so a failed regression does not leak a process.
    f.workspace.serverService.endTransition();
    await disabling;
    await owned.release();
    await f.dispose();
  }
}, 10000);
