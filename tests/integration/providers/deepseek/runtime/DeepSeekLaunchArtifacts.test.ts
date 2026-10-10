import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { prepareDeepSeekLaunchArtifacts } from '@/providers/deepseek/runtime/DeepSeekLaunchArtifacts';

it('gives every preset a live prompt file and its tool policy while keeping prompt text out of code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek packaged 文档 '));
  const artifacts = await prepareDeepSeekLaunchArtifacts(root);
  try {
    const patch = JSON.parse(await readFile(artifacts.patchPath, 'utf8'));
    const inserted = patch.find((entry: { insert?: unknown }) => entry.insert).insert;
    expect(inserted[0]).toMatchObject({ id: 'claudian-lifecycle' });
    const presets = Object.fromEntries(inserted.slice(1).map((entry: any) => [entry.config.id, entry.config.plugins.find((plugin: any) => plugin.id === 'claudian-compatibility')]));
    expect(Object.keys(presets)).toEqual(['claudian', 'claudian-code', 'claudian-passive', 'claudian-read-only']);
    expect(new Set(Object.values(presets).map((plugin: any) => plugin.config.promptFile)).size).toBe(4);
    expect(presets['claudian-passive'].config.allow).toEqual([]);
    expect(presets['claudian-read-only'].config.allow).toEqual(['read', 'read_image', 'glob', 'grep']);
    expect(presets.claudian.config.allow).toBeUndefined();
    // One chat preset: the legacy code-mode id stays declared for saved conversations with identical content, and code
    // mode is a live per-agent presentation rather than a preset row. Auxiliary presets keep their fixed native policy.
    const plugins = Object.fromEntries(inserted.slice(1).map((entry: any) => [entry.config.id, entry.config.plugins]));
    const withoutPrompt = (rows: any[]) => rows.map(row => row.id === 'claudian-compatibility' ? { ...row, config: { ...row.config, promptFile: undefined } } : row);
    expect(withoutPrompt(plugins['claudian-code'])).toEqual(withoutPrompt(plugins.claudian));
    expect(plugins.claudian.some((row: any) => row.id === 'agent-tool-presentation')).toBe(false);
    expect(presets.claudian.config.codeModeFile).toEqual(expect.any(String));
    expect(presets['claudian-code'].config.codeModeFile).toBe(presets.claudian.config.codeModeFile);
    for (const auxiliary of ['claudian-passive', 'claudian-read-only']) {
      expect(presets[auxiliary].config.codeModeFile).toBeUndefined();
      expect(plugins[auxiliary].find((row: any) => row.id === 'agent-tool-presentation').config).toEqual({ mode: 'native' });
    }

    const first = 'Literal {{title}} ${process.exit(99)} `quotes`\\n Unicode 笔记';
    const edited = 'Edited prompt';
    await artifacts.writePrompt('claudian', first);
    const pluginPath = presets.claudian.name;
    expect(await readFile(pluginPath, 'utf8')).not.toContain(first);
    // Load the bundled plugin as native does; its prompt section must read the file at each assembly.
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url';
      import { writeFileSync } from 'node:fs';
      const plugin = await import(pathToFileURL(process.argv[1]).href);
      const config = JSON.parse(process.argv[2]);
      const sections = [];
      plugin.apply({ effect: fn => fn(), on: () => () => {}, systemPrompt: {
        section: section => { sections.push(section); return () => {}; },
        getSectionOrder: name => name,
      } }, config);
      for (const bad of [{}, { promptFile: 1 }, { promptFile: 'x', allow: ['write'] }, { promptFile: 'x', codeModeFile: 1 }, { promptFile: 'x', allow: [], codeModeFile: 'mode' }]) {
        let rejected = false;
        try { plugin.apply({}, bad); } catch { rejected = true; }
        if (!rejected) throw new Error('Unsafe bridge configuration accepted');
      }
      const persona = sections[0];
      const before = persona.text();
      writeFileSync(config.promptFile, process.argv[3]);
      process.stdout.write(JSON.stringify({ persona, before, after: persona.text(), webSurface: sections.find(section => section.name === 'app:web-surface').text }));
    `, pluginPath, JSON.stringify(presets.claudian.config), edited], { cwd: root });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ persona: { interpolate: false, complete: false }, before: first, after: edited, webSurface: '' });

    const modes = await Promise.all([artifacts.patchPath, pluginPath, inserted[0].name, presets.claudian.config.promptFile].map(path => stat(path)));
    expect(process.platform === 'win32' || modes.every(mode => (mode.mode & 0o777) === 0o600)).toBe(true);
    await artifacts.dispose();
    await expect(access(artifacts.patchPath)).rejects.toThrow();
  } finally {
    await artifacts.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('applies concurrent prompt edits in call order and leaves an unchanged prompt file in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek prompts '));
  const artifacts = await prepareDeepSeekLaunchArtifacts(root);
  try {
    const patch = JSON.parse(await readFile(artifacts.patchPath, 'utf8'));
    const promptFile = patch.find((entry: { insert?: unknown }) => entry.insert).insert
      .find((entry: any) => entry.config?.id === 'claudian').config.plugins[0].config.promptFile;
    const edits = Array.from({ length: 12 }, (_, index) => `edit ${index}`);
    await Promise.all(edits.map(text => artifacts.writePrompt('claudian', text)));
    expect(await readFile(promptFile, 'utf8')).toBe(edits.at(-1));
    const written = await stat(promptFile);
    // Native re-reads the file at each assembly; an identical edit must not replace it.
    await artifacts.writePrompt('claudian', edits.at(-1)!);
    expect((await stat(promptFile)).ino).toBe(written.ino);
    await artifacts.writePrompt('claudian', 'changed');
    expect((await stat(promptFile)).ino).not.toBe(written.ino);
    expect(await readFile(promptFile, 'utf8')).toBe('changed');
  } finally {
    await artifacts.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('switches each chat agent between direct tools and code mode at its next turn, never mid-turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek code mode '));
  const artifacts = await prepareDeepSeekLaunchArtifacts(root);
  try {
    const patch = JSON.parse(await readFile(artifacts.patchPath, 'utf8'));
    const compatibility = patch.find((entry: { insert?: unknown }) => entry.insert).insert
      .find((entry: any) => entry.config?.id === 'claudian').config.plugins.find((row: any) => row.id === 'claudian-compatibility');
    // Drive the bundled plugin as native does: agent creation, then turn status changes, with code mode edited in between.
    const script = `
      import { pathToFileURL } from 'node:url';
      import { writeFileSync } from 'node:fs';
      const plugin = await import(pathToFileURL(process.argv[1]).href);
      const config = JSON.parse(process.argv[2]);
      const listeners = {};
      const log = [];
      plugin.apply({ effect: fn => fn(), systemPrompt: { section: () => () => {}, getSectionOrder: name => name },
        on: (name, listener) => { (listeners[name] ??= []).push(listener); return () => {}; } }, config);
      const agent = id => ({ id, ctx: { tools: { presentAs: mode => { log.push(id + ' present ' + mode); return () => log.push(id + ' dispose ' + mode); } } } });
      const emit = (name, payload) => { for (const listener of listeners[name] ?? []) listener(payload); };
      const [first, second] = [agent('first'), agent('second')];
      for (const step of JSON.parse(process.argv[3])) {
        if (step.write !== undefined) writeFileSync(config.codeModeFile, step.write);
        else if (step.created) emit('agent/created', { agent: step.created === 'first' ? first : second });
        else emit('agent/status', { agent: step.agent === 'first' ? first : second, status: step.status });
      }
      process.stdout.write(JSON.stringify(log));
    `;
    const run = async (steps: unknown[]): Promise<string[]> => JSON.parse((await promisify(execFile)(process.execPath,
      ['--input-type=module', '-e', script, compatibility.name, JSON.stringify(compatibility.config), JSON.stringify(steps)], { cwd: root })).stdout);

    // A fresh Host starts in direct-tool mode until Claudian writes the preference.
    expect(await run([{ created: 'first' }])).toEqual(['first present native']);
    await artifacts.writeCodeMode(true);
    expect(await run([
      { created: 'first' },
      { agent: 'first', status: 'running' },
      // Edits during a turn wait for the next one; idle transitions and unchanged turns redeclare nothing.
      { write: 'native' }, { agent: 'first', status: 'idle' },
      { write: 'both' }, { agent: 'first', status: 'running' },
      { created: 'second' },
    ])).toEqual(['first present both', 'second present both']);
    expect(await run([
      { created: 'first' }, { created: 'second' },
      { write: 'native' }, { agent: 'first', status: 'running' },
    ])).toEqual(['first present both', 'second present both', 'first dispose both', 'first present native']);

    await artifacts.writeCodeMode(false);
    expect(await readFile(compatibility.config.codeModeFile, 'utf8')).toBe('native');
    expect(process.platform === 'win32' || ((await stat(compatibility.config.codeModeFile)).mode & 0o777) === 0o600).toBe(true);
  } finally {
    await artifacts.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('reports ready only once every durable store an ephemeral session could reach is guarded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek ephemeral readiness '));
  const artifacts = await prepareDeepSeekLaunchArtifacts(root);
  try {
    const patch = JSON.parse(await readFile(artifacts.patchPath, 'utf8'));
    const row = patch.flatMap((entry: { insert?: any[] }) => entry.insert ?? []).find((entry: any) => entry.id === 'claudian-ephemeral');
    // Native without workspaces open: persistence, projections and spill are guarded, workspace membership is not.
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url';
      const plugin = await import(pathToFileURL(process.argv[1]).href);
      const backend = { create: async () => ({}), open: async () => ({}), stat: async () => undefined };
      const domains = { session_projcache: { table: () => ({ put: async () => {} }) } };
      const ctx = {
        get: () => backend, on: () => () => {}, effect: () => {}, logger: { warn() {} },
        inject: (deps, apply) => apply({ storageDomain: { get: name => domains[name] }, get: () => ({ saveText: async () => ({}) }), logger: { warn() {} }, effect: () => {} }),
      };
      plugin.apply(ctx, JSON.parse(process.argv[2]));
    `, row.name, JSON.stringify(row.config)], { cwd: root });
    expect(JSON.parse(await readFile(row.config.readyFile, 'utf8'))).toMatchObject({ persistence: true, projectionGuard: true, spillGuard: true, workspaceGuard: false });
    expect(await artifacts.readEphemeralReady()).toBe(false);
  } finally {
    await artifacts.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('never republishes a fork token whose publication failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek fork tokens '));
  const artifacts = await prepareDeepSeekLaunchArtifacts(root);
  try {
    const patch = JSON.parse(await readFile(artifacts.patchPath, 'utf8'));
    const { stateFile } = patch.flatMap((entry: { insert?: any[] }) => entry.insert ?? []).find((entry: any) => entry.id === 'claudian-ephemeral').config;
    // A non-empty directory cannot be replaced on any platform, so the offer fails and its caller never receives a withdrawal.
    await rm(stateFile, { force: true });
    await mkdir(join(stateFile, 'blocker'), { recursive: true });
    await expect(artifacts.offerEphemeralFork('saved', 4)).rejects.toThrow();
    await rm(stateFile, { recursive: true, force: true });
    const withdraw = await artifacts.offerEphemeralFork('other', 2);
    expect(JSON.parse(await readFile(stateFile, 'utf8')).forks.map((fork: any) => fork.parent)).toEqual(['other']);
    await withdraw();
    // A later durable fork of `saved` at that checkpoint must find nothing to claim.
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ forks: [] });
  } finally {
    await artifacts.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('appends user plugin rows to the chat presets after Claudian\'s own rows, never to auxiliary presets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek extra plugins '));
  const extra = [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }, { id: 'my-plugin', name: 'my-dsh-plugin', disabled: false }];
  const own = await prepareDeepSeekLaunchArtifacts(root);
  const extended = await prepareDeepSeekLaunchArtifacts(root, extra);
  try {
    const presetRows = async (patchPath: string): Promise<Record<string, any[]>> => Object.fromEntries(JSON.parse(await readFile(patchPath, 'utf8'))
      .find((entry: { insert?: unknown }) => entry.insert).insert.slice(1).map((entry: any) => [entry.config.id, entry.config.plugins]));
    const [ownRows, extendedRows] = await Promise.all([presetRows(own.patchPath), presetRows(extended.patchPath)]);
    const ids = (rows: any[]) => rows.map(row => row.id);
    for (const chat of ['claudian', 'claudian-code']) {
      expect(extendedRows[chat].slice(-2)).toEqual(extra);
      expect(ids(extendedRows[chat].slice(0, -2))).toEqual(ids(ownRows[chat]));
    }
    for (const auxiliary of ['claudian-passive', 'claudian-read-only']) expect(ids(extendedRows[auxiliary])).toEqual(ids(ownRows[auxiliary]));
  } finally {
    await Promise.all([own.dispose(), extended.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps ephemeral sessions in process memory and out of every durable dsh store, leaving other sessions to native', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek ephemeral '));
  const artifacts = await prepareDeepSeekLaunchArtifacts(root);
  try {
    const patch = JSON.parse(await readFile(artifacts.patchPath, 'utf8'));
    const row = patch.flatMap((entry: { insert?: any[] }) => entry.insert ?? []).find((entry: any) => entry.id === 'claudian-ephemeral');
    expect(row).toMatchObject({ config: { stateFile: expect.any(String), readyFile: expect.any(String), spillRoot: expect.any(String) } });
    // Native's own JSONL backend stays mounted; the plugin only decorates it.
    expect(patch.some((entry: any) => entry.id === 'session-persistence-jsonl')).toBe(false);
    expect(process.platform === 'win32' || ((await stat(row.config.stateFile)).mode & 0o777) === 0o600).toBe(true);
    expect(await artifacts.readEphemeralReady()).toBe(false);

    // Drive the bundled plugin as native does, against a stand-in persistence backend and storage domains.
    const script = `
      import { pathToFileURL } from 'node:url';
      const plugin = await import(pathToFileURL(process.argv[1]).href);
      const config = JSON.parse(process.argv[2]);
      const out = { backend: [], projcache: [], workspaces: [], global: [], spilled: [], errors: {} };
      const backend = {
        name: 'session-persistence-jsonl',
        create: async (header, options) => { out.backend.push('create ' + header.id + (options?.inheritedEventCount ? '@' + options.inheritedEventCount : '')); return { id: header.id, native: true }; },
        open: async (id, access) => { out.backend.push('open ' + id + ' ' + access); return { id, native: true }; },
        stat: async id => { out.backend.push('stat ' + id); return undefined; },
        list: async () => [],
      };
      const original = { create: backend.create, open: backend.open, stat: backend.stat };
      const listeners = {}; const disposers = [];
      const projcacheTable = { put: async key => { out.projcache.push(key); } };
      const workspaceTable = {
        put: async (key, value) => { out.workspaces.push(value.sessionIds); },
        update: async (key, fn) => { const next = fn({ path: '/vault', sessionIds: ['p'] }); out.workspaces.push(next.sessionIds); return next; },
      };
      const globalHandle = { set: async value => { out.global.push(value); } };
      const domains = { session_projcache: { table: () => projcacheTable }, workspace: { table: () => workspaceTable, global: globalHandle } };
      const spillStore = { saveText: async input => { out.spilled.push(input.owner.sessionId); return { locator: '/native/' + input.owner.sessionId, bytes: 1 }; } };
      const ctx = {
        get: name => name === 'sessionPersistence' ? backend : undefined,
        on: (name, listener) => { (listeners[name] ??= []).push(listener); return () => {}; },
        effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose); },
        inject: (deps, apply) => apply({ storageDomain: { get: name => domains[name] }, get: name => name === 'spillStore' ? spillStore : undefined, logger: { warn() {} }, effect: ctx.effect }),
        logger: { warn() {} },
      };
      for (const bad of [{}, { stateFile: 'x' }, { stateFile: 1, readyFile: 'y' }]) {
        let rejected = false;
        try { plugin.apply(ctx, bad); } catch { rejected = true; }
        if (!rejected) throw new Error('Unsafe ephemeral configuration accepted');
      }
      plugin.apply(ctx, config);
      const event = seq => ({ type: 'x', seq, time: 0, data: {} });
      const emit = (name, ...args) => { for (const listener of listeners[name] ?? []) listener(...args); };
      const header = (id, extra = {}) => ({ version: 4, id, createdAt: 0, isSeeded: false, ...extra });
      const attempt = async (name, run) => { try { await run(); out.errors[name] = false; } catch { out.errors[name] = true; } };

      // An ephemeral root: handle appends and live events overlap, the log stays contiguous by seq.
      const aux = await backend.create(header('claudian-ephemeral-aux'));
      await aux.append([event(0), event(1)]);
      emit('session/event', { id: 'claudian-ephemeral-aux' }, event(1));
      emit('session/event', { id: 'claudian-ephemeral-aux' }, event(2));
      await attempt('gap', () => aux.append([event(5)]));
      await attempt('second writer', () => backend.open('claudian-ephemeral-aux', 'write'));
      out.auxRead = (await (await backend.open('claudian-ephemeral-aux', 'read')).read()).events.map(e => e.seq);
      out.auxStat = await backend.stat('claudian-ephemeral-aux');
      await aux.close();
      // A closed handle releases ownership but not the log: dsh may reopen it within this process.
      out.auxReopened = (await (await backend.open('claudian-ephemeral-aux', 'write')).read(1, 1)).events.map(e => e.seq);

      // Ordinary sessions, forks and subagents stay with the mounted backend.
      await backend.create(header('saved'));
      await backend.open('saved', 'write');
      await backend.stat('saved');
      // Children of an ephemeral session (subagents, forks) are ephemeral too.
      const child = await backend.create(header('child', { parentSession: 'claudian-ephemeral-aux', origin: 'subagent' }));
      out.childNative = !!child.native;
      // Claudian's fork token makes exactly one fork of its parent at its checkpoint ephemeral.
      const forks = {};
      for (const [id, parent, inheritedEventCount] of JSON.parse(process.argv[3])) {
        const handle = forks[id] = await backend.create(header(id, { parentSession: parent, isSeeded: true }), { inheritedEventCount });
        out[id] = handle.native ? 'native' : 'memory';
      }
      // Native stores a fork's inherited seed as the start of its own log, from seq 0, then its live suffix.
      await forks.side.append([0, 1, 2, 3, 4].map(event));
      emit('session/event', { id: 'side' }, event(5));
      await forks.side.close();
      const reopened = await backend.open('side', 'write');
      out.sideLog = { seqs: (await reopened.read()).events.map(e => e.seq), inherited: reopened.inheritedEventCount, stat: (await backend.stat('side')).eventCount };
      await reopened.append([event(6)]);
      out.sideLog.appended = (await reopened.read(6)).events.map(e => e.seq);
      const subagentOfSaved = await backend.create(header('saved-subagent', { parentSession: 'saved', origin: 'subagent' }), { inheritedEventCount: 5 });
      out['saved-subagent'] = subagentOfSaved.native ? 'native' : 'memory';

      // Oversized tool output of an ephemeral session stays in Claudian's launch directory, removed with the Host.
      const spill = name => ({ owner: { sessionId: name }, source: { kind: 'tool', toolName: 'bash' }, suggestedName: '../bash out.txt', content: 'big output ' + name });
      out.auxSpill = await spillStore.saveText(spill('claudian-ephemeral-aux'));
      out.savedSpill = await spillStore.saveText(spill('saved'));
      // Durable dsh stores never record an ephemeral session.
      await projcacheTable.put('claudian-ephemeral-aux', {}); await projcacheTable.put('side', {}); await projcacheTable.put('saved', {});
      await workspaceTable.update('ws', record => ({ ...record, sessionIds: ['side', ...record.sessionIds, 'claudian-ephemeral-aux'] }));
      await workspaceTable.put('ws', { path: '/vault', sessionIds: ['child', 'saved'] });
      await globalHandle.set({ archivedSessionIds: ['side', 'saved'], pinnedSessionIds: ['claudian-ephemeral-aux'], workspaceIds: ['ws'] });

      for (const dispose of disposers.reverse()) await dispose();
      out.restored = backend.create === original.create && backend.open === original.open && backend.stat === original.stat;
      process.stdout.write(JSON.stringify(out));
    `;
    // Two forks of `saved` at checkpoint 4 race for one token; a fork at another checkpoint never takes it.
    const withdraw = await artifacts.offerEphemeralFork('saved', 4);
    const result = JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, row.name, JSON.stringify(row.config),
      JSON.stringify([['other-cut', 'saved', 3], ['side', 'saved', 5], ['second', 'saved', 5]])], { cwd: root })).stdout);
    await withdraw();
    expect(JSON.parse(await readFile(row.config.stateFile, 'utf8'))).toEqual({ forks: [] });

    expect(result.auxRead).toEqual([0, 1, 2]);
    expect(result.auxStat).toMatchObject({ header: { id: 'claudian-ephemeral-aux' }, eventCount: 3 });
    expect(result.auxReopened).toEqual([1]);
    expect(result.errors).toEqual({ gap: true, 'second writer': true });
    expect(result.childNative).toBe(false);
    expect([result['other-cut'], result.side, result.second, result['saved-subagent']]).toEqual(['native', 'memory', 'native', 'native']);
    expect(result.sideLog).toEqual({ seqs: [0, 1, 2, 3, 4, 5], inherited: 5, stat: 6, appended: [6] });
    expect(result.backend).toEqual(['create saved', 'open saved write', 'stat saved', 'create other-cut@3', 'create second@5', 'create saved-subagent@5']);
    expect(result.projcache).toEqual(['saved']);
    expect(result.workspaces).toEqual([['p'], ['saved']]);
    expect(result.global).toEqual([{ archivedSessionIds: ['saved'], pinnedSessionIds: [], workspaceIds: ['ws'] }]);
    expect(result.restored).toBe(true);
    expect(result.spilled).toEqual(['saved']);
    expect(result.savedSpill.locator).toBe('/native/saved');
    expect(dirname(result.auxSpill.locator)).toBe(row.config.spillRoot);
    expect(await readFile(result.auxSpill.locator, 'utf8')).toBe('big output claudian-ephemeral-aux');
    expect(result.auxSpill).toMatchObject({ bytes: Buffer.byteLength('big output claudian-ephemeral-aux'), retrievalHint: expect.any(String) });
    expect(process.platform === 'win32' || ((await stat(result.auxSpill.locator)).mode & 0o777) === 0o600).toBe(true);
    // Every guard reported ready, so Claudian may rely on it.
    expect(await artifacts.readEphemeralReady()).toBe(true);
  } finally {
    await artifacts.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

// DeepSeek refuses to start on Windows, where a self-signalled child also reports an exit code instead of SIGTERM.
(process.platform === 'win32' ? describe.skip : describe)('owner lifecycle tether', () => {
  it('ends the native process once its owner\'s end of stdin closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek lifecycle '));
    const artifacts = await prepareDeepSeekLaunchArtifacts(root);
    try {
      const patch = JSON.parse(await readFile(artifacts.patchPath, 'utf8'));
      const lifecyclePath = patch.find((entry: { insert?: unknown }) => entry.insert).insert[0].name;
      // A stand-in Host that would otherwise run indefinitely, like dsh web.
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const plugin = await import(pathToFileURL(process.argv[1]).href);
        plugin.apply();
        setInterval(() => {}, 1000);
        process.stdout.write('ready');
      `, lifecyclePath], { stdio: ['pipe', 'pipe', 'inherit'] });
      await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.stdin.end();
      expect(await exited).toEqual({ code: null, signal: 'SIGTERM' });
    } finally {
      await artifacts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
