import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { build, stop } from 'esbuild';

import * as compressedStaticAssetsHelpers from '../../../scripts/compressedStaticAssets.js';
import * as desktopRuntimeAliasHelpers from '../../../scripts/desktopRuntimeAliases.js';

const { createCompressedStaticAssetsPlugin } = compressedStaticAssetsHelpers;
const { createDesktopRuntimeAliases } = desktopRuntimeAliasHelpers;

describe('Desktop dependency envelope', () => {
  afterAll(() => stop());

  it('round-trips every locale through one compressed production catalog', async () => {
    const root = path.resolve(__dirname, '../../..');
    const localeDirectory = path.join(root, 'src/i18n/locales');
    const localeFiles = readdirSync(localeDirectory).filter(file => file.endsWith('.json')).sort();
    const result = await build({
      absWorkingDir: root,
      bundle: true,
      charset: 'utf8',
      external: ['node:zlib'],
      format: 'cjs',
      metafile: true,
      minify: true,
      plugins: [createCompressedStaticAssetsPlugin()],
      stdin: {
        contents: [
          ...localeFiles.map((file, index) => `import locale${index} from './src/i18n/locales/${file}';`),
          `module.exports = [${localeFiles.map((_, index) => `locale${index}`).join(',')}];`,
        ].join('\n'),
        resolveDir: root,
      },
      target: 'es2022',
      write: false,
    });
    expect(result.outputFiles).toHaveLength(1);
    expect(Object.keys(result.metafile.inputs).filter(input => input.includes('compressed-locale-catalog')))
      .toEqual(['compressed-locale-catalog:all']);
    const output = result.outputFiles[0].text;
    const module = { exports: [] as unknown[] };
    Function('module', 'exports', 'require', output)(module, module.exports, require);
    expect(module.exports).toEqual(localeFiles.map(file => JSON.parse(readFileSync(path.join(localeDirectory, file), 'utf8'))));
  });

  it('resolves desktop WebSocket and a single Markdown parser entry', () => {
    const aliases = createDesktopRuntimeAliases();
    expect(aliases.ws).toBe(require.resolve('ws'));
    expect(aliases['@lezer/markdown']).toBe(path.join(path.dirname(require.resolve('@lezer/markdown')), 'index.js'));
  });
});
