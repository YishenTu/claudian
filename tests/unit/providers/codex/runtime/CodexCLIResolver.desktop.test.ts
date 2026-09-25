import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexCLIResolver } from '@/providers/codex/runtime/CodexCLIResolver';

it.each(['removed', 'incomplete', 'retained'])('discovers an updated desktop runtime when the previous runtime is %s', async (previousState) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-update-'));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalLocal = process.env.LOCALAPPDATA;
  const originalInstall = process.env.CODEX_INSTALL_DIR;
  const runtimeRoot = path.join(temp, 'OpenAI', 'Codex', 'bin');
  const createRuntime = (name: string) => {
    const dir = path.join(runtimeRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'codex.exe'), '');
    fs.writeFileSync(path.join(dir, 'codex-code-mode-host.exe'), '');
    return path.join(dir, 'codex.exe');
  };
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.LOCALAPPDATA = temp;
    delete process.env.CODEX_INSTALL_DIR;
    const oldPath = createRuntime('old-hash');
    const resolver = new CodexCLIResolver();
    const settings = { providerConfigs: { codex: {} } };
    const context = { executionTarget: { method: 'native-windows', platformFamily: 'windows', platformOs: 'windows' } };
    expect(await resolver.resolveFromSettings(settings, context)).toBe(oldPath);
    fs.utimesSync(oldPath, new Date('2020-01-01'), new Date('2020-01-01'));
    if (previousState === 'removed') {
      fs.rmSync(path.dirname(oldPath), { recursive: true });
    } else if (previousState === 'incomplete') {
      fs.unlinkSync(path.join(path.dirname(oldPath), 'codex-code-mode-host.exe'));
    }
    const replacementPath = createRuntime('new-hash');
    expect(await resolver.resolveFromSettings(settings, context)).toBe(replacementPath);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocal;
    if (originalInstall === undefined) delete process.env.CODEX_INSTALL_DIR;
    else process.env.CODEX_INSTALL_DIR = originalInstall;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
