import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
