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
      plugin.apply({ effect: fn => fn(), systemPrompt: {
        section: section => { sections.push(section); return () => {}; },
        getSectionOrder: name => name,
      } }, config);
      for (const bad of [{}, { promptFile: 1 }, { promptFile: 'x', allow: ['write'] }]) {
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
