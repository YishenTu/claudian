import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

describe('Documentation', () => {
  it('keeps the documented Obsidian requirement synchronized with tooling', () => {
    const manifest = JSON.parse(readFileSync(path.resolve('manifest.json'), 'utf8')) as {
      minAppVersion: string;
    };
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const readme = readFileSync(path.resolve('README.md'), 'utf8');

    expect(packageJson.devDependencies.obsidian).toBe(manifest.minAppVersion);
    expect(readme).toContain(`- Obsidian v${manifest.minAppVersion}+`);
  });

  it('keeps README local file links resolvable', () => {
    const readme = readFileSync(path.resolve('README.md'), 'utf8');
    const markdownTargets = [...readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
      .map(match => match[1]);
    const htmlTargets = [...readme.matchAll(/\bsrc="([^"]+)"/g)]
      .map(match => match[1]);
    const localTargets = [...markdownTargets, ...htmlTargets]
      .filter(target => !/^(?:#|https?:|mailto:)/.test(target));

    for (const target of localTargets) {
      const filePath = target.replace(/^<|>$/g, '').split('#', 1)[0];
      expect(existsSync(path.resolve(filePath))).toBe(true);
    }
  });
});
