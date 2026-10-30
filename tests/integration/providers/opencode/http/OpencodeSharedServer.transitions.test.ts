// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';
import { createFixture, isAlive, turn, waitFor } from '@test/helpers/providers/opencode/OpencodeSharedServerFixture';

import { type ProviderExecutionEvent, type ProviderSessionConfig } from '@/core/execution';
import { forkOpencodeSession } from '@/providers/opencode/history/OpencodeSessionFork';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';

it('retains the current server after launch changes while disabled and re-enabling', async () => {
  const f = await createFixture();
  const transition = (mutation: () => void) => f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => mutation());
  try {
    await f.workspace.startRuntime?.();
    await transition(() => { updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=second' }); });
    await transition(() => { updateOpencodeProviderSettings(f.plugin.settings, { enabled: false }); });
    await transition(() => { updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=third' }); });
    await transition(() => { updateOpencodeProviderSettings(f.plugin.settings, { enabled: true }); });
    const starts = f.processes().length;
    const pid = f.processes().at(-1)!.pid;
    await f.workspace.metadataService.loadCatalog();
    await f.workspace.metadataService.discoverCommands();
    expect(f.processes()).toHaveLength(starts);
    expect(isAlive(pid)).toBe(true);
  } finally { await f.dispose(); }
});

it('keeps old native work through a launch transition, drains it, and resumes on the replacement', async () => {
  const f = await createFixture();
  const config: ProviderSessionConfig = { workingDirectory: f.root, lifecycle: 'persistent', nativePersistence: 'provider-default',
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} } };
  await f.workspace.metadataService.loadCatalog();
  const owned = f.plugin.executionLifecycleRegistry.acquire(f.backend, config, 'chat');
  const events: ProviderExecutionEvent[] = [];
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const consume = (async () => { for await (const event of owned.session.execute(turn('hold')).events) { events.push(event); if (event.type === 'text_delta') started(); } })();
  let control;
  try {
    await active;
    control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    const pid = f.processes()[0].pid;
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=replacement' });
    });
    expect(owned.isCurrent()).toBe(true);
    expect(events.some(event => ['cancelled', 'execution_error', 'turn_completed'].includes(event.type))).toBe(false);
    await f.workspace.metadataService.loadCatalog();
    expect(f.processes()).toHaveLength(2);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await control.request('/fixture/event', { method: 'POST', body: { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } } });
    await consume;
    expect(events.at(-1)?.type).toBe('turn_completed');
    await control.dispose();
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(isAlive(pid)).toBe(false);
    const resumed: ProviderExecutionEvent[] = [];
    for await (const event of owned.session.execute(turn('continue')).events) resumed.push(event);
    expect(resumed.at(-1)?.type).toBe('turn_completed');
    expect(f.processes()).toHaveLength(2);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { updateOpencodeProviderSettings(f.plugin.settings, { enabled: false }); });
    expect(owned.isCurrent()).toBe(false);
    expect(f.processes().some(native => isAlive(native.pid))).toBe(false);
  } finally { await control?.dispose(); await owned.release(); await consume; await f.dispose(); }
}, 15000);

it('fences a new turn on a retained idle session until the settings transition commits', async () => {
  const f = await createFixture();
  const config: ProviderSessionConfig = { workingDirectory: f.root, lifecycle: 'persistent', nativePersistence: 'provider-default',
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} } };
  const owned = f.plugin.executionLifecycleRegistry.acquire(f.backend, config, 'chat');
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const mutation = new Promise<void>(resolve => { entered = resolve; });
  let transition: Promise<void> | undefined, second: Promise<void> | undefined;
  const request = turn('stable instructions');
  try {
    await f.workspace.metadataService.loadCatalog();
    for await (const event of owned.session.execute(request).events) { void event; }
    const originalPid = f.processes()[0].pid;
    transition = f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=after commit' });
      entered();
      await hold;
    });
    await mutation;
    const events: ProviderExecutionEvent[] = [];
    second = (async () => { for await (const event of owned.session.execute(request).events) events.push(event); })();
    await Promise.race([second, new Promise(resolve => setTimeout(resolve, 200))]);
    expect(events.filter(event => event.type === 'text_delta' || event.type === 'turn_completed')).toEqual([]);
    release();
    await transition;
    await second;
    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(f.processes()).toHaveLength(2);
    expect(isAlive(originalPid)).toBe(false);
  } finally { release(); await transition; await owned.release(); await second; await f.dispose(); }
});

it('rejects an installed OpenCode v1 CLI for chat, discovery and forks while the retired generation stays owned', async () => {
  const f = await createFixture();
  const cliV1 = path.join(f.root, 'opencode-v1.cjs');
  writeOpencodeNativePeer(cliV1, { scenario: 'workspace', version: '1.2.27' });
  let control, owned;
  try {
    control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await control.request('/api/info');
    await f.workspace.metadataService.loadCatalog();
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      f.plugin.getResolvedProviderCliPath = async () => cliV1;
      updateOpencodeProviderSettings(f.plugin.settings, { cliPath: cliV1 });
    });
    owned = f.plugin.executionLifecycleRegistry.acquire(f.backend, {
      workingDirectory: f.root, lifecycle: 'persistent', nativePersistence: 'provider-default',
      interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
    } satisfies ProviderSessionConfig, 'chat');
    const events: ProviderExecutionEvent[] = [];
    for await (const event of owned.session.execute(turn('v1')).events) events.push(event);
    expect(events.find(event => event.type === 'execution_error'))
      .toMatchObject({ message: expect.stringContaining('OpenCode v1 is no longer supported') });
    expect(events.some(event => event.type === 'turn_completed')).toBe(false);
    await expect(f.workspace.metadataService.discoverModels())
      .resolves.toMatchObject({ changed: false, diagnostics: expect.stringContaining('OpenCode v1 is no longer supported') });
    await expect(forkOpencodeSession({
      cliPath: cliV1, cwd: f.root, environment: f.environment, sourceSessionId: 'source',
      resolveServerService: async () => f.workspace.serverService,
    })).rejects.toThrow('OpenCode v1 is no longer supported');
    // The v1 CLI never launched a server; the retired v2 generation remains owned by its lease.
    expect(f.processes()).toHaveLength(1);
    expect(isAlive(f.processes()[0].pid)).toBe(true);
  } finally { await owned?.release(); await control?.dispose(); await f.dispose(); }
});

it('fences new acquisitions during provider transitions and drains the previous generation', async () => {
  const f = await createFixture();
  try {
    const old = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await old.request('/api/model');
    await f.workspace.serverService.beginTransition();
    await expect(old.request('/api/model')).resolves.toMatchObject({ data: expect.any(Array) });
    const controller = new AbortController();
    const waiting = f.workspace.serverService.acquire(f.cli, f.root, f.environment, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    const nextEnvironment = { ...f.environment, GENERATION: 'next' };
    f.workspace.serverService.reconcileLaunch(f.cli, f.root, nextEnvironment);
    f.workspace.serverService.endTransition();
    const next = await f.workspace.serverService.acquire(f.cli, f.root, nextEnvironment);
    await next.request('/api/model');
    expect(f.processes()).toHaveLength(2);
    await old.dispose(); await next.dispose();
  } finally { await f.dispose(); }
});

it.each(['same instructions', 'changed instructions'])('keeps retired background work owned while the next turn uses the replacement: %s', async instructions => {
  const f = await createFixture();
  await f.workspace.metadataService.loadCatalog();
  const session = f.createSession();
  const background: import('@/core/execution').ProviderSessionEvent[] = [];
  session.onEvent(event => background.push(event));
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const parent = (async () => { for await (const event of session.execute(turn('hold')).events) if (event.type === 'text_delta') started(); })();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const emit = (type: string, data: object) => control.request('/fixture/event', { method: 'POST', body: { type, data } });
  try {
    await active;
    const pid = f.processes()[0].pid;
    const identity = { sessionID: 'ses_1', assistantMessageID: 'parent', id: 'spawn' };
    await emit('session.tool.input.started', { ...identity, name: 'subagent' });
    await emit('session.tool.called', { ...identity, input: { run_in_background: true } });
    await emit('session.tool.progress', { ...identity, metadata: { sessionID: 'child' } });
    await emit('session.execution.succeeded', { sessionID: 'ses_1' });
    await parent;
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=background' });
    });
    expect(session.getStatus()).toBe('executing');
    const nextRequest = turn(instructions === 'same instructions' ? 'hold' : 'replacement');
    const continued = (async () => {
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({ ...nextRequest, input: [{ type: 'text', text: 'next' }] }).events) events.push(event);
      return events;
    })();
    await emit('session.text.ended', { sessionID: 'child', assistantMessageID: 'child-reply', ordinal: 0, text: 'Still working' });
    await emit('session.execution.succeeded', { sessionID: 'child' });
    expect((await continued).at(-1)?.type).toBe('turn_completed');
    expect(f.processes()).toHaveLength(2);
    await control.dispose();
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(background).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'background_turn_completed', reason: 'completed' }),
      expect.objectContaining({ type: 'async_subagent_completed', subagentId: 'child', result: 'Still working' }),
    ]));
    expect(isAlive(pid)).toBe(false);
  } finally { await control.dispose(); await session.dispose(); await parent; await f.dispose(); }
}, 10000);

it('cancelling a turn waiting on retired background work leaves that work draining', async () => {
  const f = await createFixture();
  await f.workspace.metadataService.loadCatalog();
  const session = f.createSession();
  const background: import('@/core/execution').ProviderSessionEvent[] = [];
  session.onEvent(event => background.push(event));
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const parent = (async () => { for await (const event of session.execute(turn('hold')).events) if (event.type === 'text_delta') started(); })();
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  const emit = (type: string, data: object) => control.request('/fixture/event', { method: 'POST', body: { type, data } });
  try {
    await active;
    const pid = f.processes()[0].pid;
    const identity = { sessionID: 'ses_1', assistantMessageID: 'parent', id: 'spawn' };
    await emit('session.tool.input.started', { ...identity, name: 'subagent' });
    await emit('session.tool.called', { ...identity, input: { run_in_background: true } });
    await emit('session.tool.progress', { ...identity, metadata: { sessionID: 'child' } });
    await emit('session.execution.succeeded', { sessionID: 'ses_1' });
    await parent;
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=background' });
    });
    const waiting = session.execute(turn('next'));
    const events: ProviderExecutionEvent[] = [];
    const consumed = (async () => { for await (const event of waiting.events) events.push(event); })();
    await new Promise(resolve => setTimeout(resolve, 50));
    waiting.cancel();
    await consumed;
    expect(events.at(-1)).toMatchObject({ type: 'cancelled', reason: 'cancelled' });
    expect(session.getStatus()).toBe('executing');
    await emit('session.text.ended', { sessionID: 'child', assistantMessageID: 'child-reply', ordinal: 0, text: 'Still working' });
    await emit('session.execution.succeeded', { sessionID: 'child' });
    await control.dispose();
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(background).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'async_subagent_completed', subagentId: 'child', result: 'Still working' }),
    ]));
    expect(background).not.toContainEqual(expect.objectContaining({ type: 'background_turn_completed', reason: 'provider-ended' }));
    expect(session.getStatus()).toBe('idle');
    expect(isAlive(pid)).toBe(false);
    expect(f.processes()).toHaveLength(1);
  } finally { await control.dispose(); await session.dispose(); await parent; await f.dispose(); }
}, 10000);

it('drains a server launched for execution before a transition even when version detection finishes afterward', async () => {
  const f = await createFixture();
  f.plugin.getResolvedProviderCliPath = async () => getOpencodeProviderSettings(f.plugin.settings).cliPath;
  const replacementCLI = path.join(f.root, 'replacement.cjs');
  writeOpencodeNativePeer(replacementCLI, { scenario: 'workspace' });
  const session = f.createSession();
  let run: Promise<ProviderExecutionEvent[]> | undefined;
  try {
    // No server exists yet, so the execution's lease launches one and verifies its version.
    updateOpencodeProviderSettings(f.plugin.settings, { discoveredModels: [{ rawId: 'local/chat', label: 'Chat' }] });
    writeFileSync(f.log + '.version-hold', '');
    run = (async () => { const events: ProviderExecutionEvent[] = []; for await (const event of session.execute(turn('late launch')).events) events.push(event); return events; })();
    const deadline = Date.now() + 3000;
    while (!existsSync(f.log + '.version-started') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(f.log + '.version-started')).toBe(true);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => { updateOpencodeProviderSettings(f.plugin.settings, { cliPath: replacementCLI }); });
    rmSync(f.log + '.version-hold');
    expect((await run).at(-1)?.type).toBe('turn_completed');
    const pid = f.processes().at(-1)!.pid;
    const drained = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < drained) await new Promise(resolve => setTimeout(resolve, 10));
    expect(isAlive(pid)).toBe(false);
  } finally { rmSync(f.log + '.version-hold', { force: true }); await session.dispose(); await run; await f.dispose(); }
}, 10000);

it.each(['replace', 'disable'])('starts tab presence requested during a %s transition from the committed settings', async mode => {
  const f = await createFixture();
  const hold = f.log + '.version-hold';
  let startup: Promise<void> | undefined;
  const live = () => f.processes().filter(native => isAlive(native.pid)).map(native => native.generation ?? 'initial');
  try {
    await f.workspace.startRuntime?.();
    writeFileSync(hold, '');
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      startup = f.workspace.startRuntime?.();
      // A startup that read settings before the transition committed would launch, and reach version detection, here.
      await waitFor(() => existsSync(f.log + '.version-started'), 300);
      if (mode === 'disable') updateOpencodeProviderSettings(f.plugin.settings, { enabled: false });
      else updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: getOpencodeProviderSettings(f.plugin.settings).environmentVariables + '\nGENERATION=replacement' });
      rmSync(hold);
    });
    await startup;
    const expected = mode === 'disable' ? [] : ['replacement'];
    await waitFor(() => JSON.stringify(live()) === JSON.stringify(expected));
    expect(live()).toEqual(expected);
  } finally { rmSync(hold, { force: true }); await startup?.catch(() => undefined); await f.dispose(); }
}, 10000);

it('keeps a bound database server and the new default prewarm when only the default database changes', async () => {
  const f = await createFixture();
  const oldDatabase = f.environment.OPENCODE_DB!;
  const nextDatabase = path.join(f.root, 'replacement.db');
  const live = (database: string) => f.processes().filter(native => native.db === database && isAlive(native.pid));
  let bound, resumed;
  try {
    await f.workspace.startRuntime?.();
    bound = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await f.plugin.executionLifecycleRegistry.runTransition(['opencode'], async () => {
      const config = getOpencodeProviderSettings(f.plugin.settings);
      config.environmentVariables = config.environmentVariables.replace(oldDatabase, nextDatabase);
      updateOpencodeProviderSettings(f.plugin.settings, { environmentVariables: config.environmentVariables });
    });
    expect(live(nextDatabase)).toHaveLength(1);
    resumed = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
    await resumed.request('/api/info');
    expect({ old: live(oldDatabase).length, next: live(nextDatabase).length }).toEqual({ old: 1, next: 1 });
    await resumed.dispose();
    await bound.dispose();
    await waitFor(() => live(oldDatabase).length === 0);
    expect({ old: live(oldDatabase).length, next: live(nextDatabase).length }).toEqual({ old: 0, next: 1 });
  } finally { await resumed?.dispose(); await bound?.dispose(); await f.dispose(); }
});
