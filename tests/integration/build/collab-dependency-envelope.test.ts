import { spawnSync } from 'node:child_process';
import {
mkdtempSync,
readdirSync,
readFileSync,
rmSync,
writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build,stop } from 'esbuild';

import * as compressedStaticAssetsHelpers from '../../../scripts/compressedStaticAssets.js';
import * as desktopRuntimeAliasHelpers from '../../../scripts/desktopRuntimeAliases.js';
import * as terserProductionBundleHelpers from '../../../scripts/terserProductionBundle.js';

const { createDesktopRuntimeAliases } = desktopRuntimeAliasHelpers;
const { createCompressedStaticAssetsPlugin } = compressedStaticAssetsHelpers;
const { minifyProductionBundle } = terserProductionBundleHelpers;


const root = path.resolve(__dirname, '../../..');
const esbuildConfigPath = path.join(root, 'esbuild.config.mjs');

describe('Collab dependency envelope', () => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'claudian-collab-build-'));
  const bundlePath = path.join(tempDirectory, 'dependency-envelope.cjs');
  let bundleContributors: string[] = [];
  let bundleInputs: string[] = [];

  beforeAll(async () => {
    const result = await build({
      absWorkingDir: root,
      alias: {
        ...createDesktopRuntimeAliases(),
      },
      bundle: true,
      external: [
        '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands',
        '@lezer/common', '@lezer/highlight',
        ...builtinModules,
        ...builtinModules.map(moduleName => `node:${moduleName}`),
      ],
      format: 'cjs',
      loader: { '.wasm': 'binary' },
      logLevel: 'silent',
      metafile: true,
      minify: true,
      outfile: bundlePath,
      platform: 'browser',
      plugins: [
        createCompressedStaticAssetsPlugin(),
      ],
      stdin: {
        contents: `
          import { WebSocket, WebSocketServer } from 'ws';
          import { parser as markdownParser } from '@lezer/markdown';
          import { scanCollabTicketReferences } from '@claudian-collab/protocol';
          import * as english from './src/i18n/locales/en.json';
          import * as german from './src/i18n/locales/de.json';
          import { LanTlsIdentity } from './src/app/collab/lan/LanTlsIdentity';
          import {
            CollabDiffRenderer,
            preloadCollabDiffRenderer,
          } from './src/features/collab/detail/review/CollabDiffRenderer';

          export function probeWebSocket() {
            return [typeof WebSocket, typeof WebSocketServer];
          }

          export async function probeSql() {
            const [sqlJsModule, wasmModule] = await Promise.all([
              import('sql.js'),
              import('sql.js/dist/sql-wasm.wasm'),
            ]);
            const SQL = await sqlJsModule.default({
              wasmBinary: Uint8Array.from(wasmModule.default).buffer,
            });
            const database = new SQL.Database();
            const result = database.exec('SELECT 1 AS value');
            database.close();
            return result[0].values[0][0];
          }

          export async function probeDiffs() {
            const diffs = await preloadCollabDiffRenderer();
            return typeof diffs.createDiffView;
          }

          export function probeLocale() {
            return [
              english.collab.commands.createProject,
              german.common.save,
            ];
          }

          export function probeMarkdownDependencies() {
            return [
              markdownParser.parse('# heading').length,
              scanCollabTicketReferences('References #12').length,
            ];
          }

          export function probeTlsIdentity() {
            return typeof LanTlsIdentity;
          }
          export async function renderCollabTextDiff(container) {
            const renderer = new CollabDiffRenderer({
              themeSource: {
                current: () => 'dark',
                subscribe: () => () => undefined,
              },
            });
            await renderer.render({
              container,
              newText: '# Collab heading after\\n\\n',
              oldText: '# Collab heading before\\n\\n',
              path: 'note.md',
            });
            return renderer;
          }
        `,
        loader: 'ts',
        resolveDir: root,
        sourcefile: 'collab-dependency-envelope.ts',
      },
      target: 'es2022',
      treeShaking: true,
    });
    bundleInputs = Object.keys(result.metafile.inputs);
    bundleContributors = Object.entries(Object.values(result.metafile.outputs)[0].inputs)
      .filter(([, contribution]) => contribution.bytesInOutput > 0)
      .map(([input]) => input);
    const productionBundle = await minifyProductionBundle(readFileSync(bundlePath, 'utf8'));
    writeFileSync(bundlePath, `${productionBundle}\n`, 'utf8');
  }, 60_000);

  afterAll(() => {
    stop();
    rmSync(tempDirectory, { force: true, recursive: true });
  });

  it('keeps the Collab draft editor inside the strict CommonMark language envelope', async () => {
    const result = await build({
      absWorkingDir: root,
      bundle: true,
      entryPoints: [
        path.join(root, 'src/features/collab/shared/markdown/MarkdownDraftEditor.ts'),
      ],
      external: [
        'obsidian',
        ...builtinModules,
        ...builtinModules.map(moduleName => `node:${moduleName}`),
      ],
      logLevel: 'silent',
      metafile: true,
      platform: 'browser',
      target: 'es2022',
      treeShaking: true,
      write: false,
    });
    const forbiddenInputs = Object.entries(Object.values(result.metafile.outputs)[0].inputs)
      .filter(([, contribution]) => contribution.bytesInOutput > 0)
      .map(([input]) => input)
      .map(input => input.replaceAll('\\\\', '/'))
      .filter(input => [
        '/@codemirror/lang-css/',
        '/@codemirror/lang-html/',
        '/@codemirror/lang-javascript/',
        '/@lezer/css/',
        '/@lezer/html/',
        '/@lezer/javascript/',
      ].some(fragment => input.includes(fragment)));

    expect(forbiddenInputs).toEqual([]);
  });

  it('bundles one shared Markdown parser implementation', () => {
    const markdownParserContributors = bundleContributors
      .map(input => input.replaceAll('\\\\', '/'))
      .filter(input => input.includes('/@lezer/markdown/dist/'));

    expect(markdownParserContributors).toHaveLength(1);
    expect(markdownParserContributors[0]).toMatch(
      /(?:^|\/)node_modules\/@lezer\/markdown\/dist\/index\.js$/,
    );
  });

  it('excludes unused Forge PKCS and password-encryption modules', () => {
    const normalizedContributors = bundleContributors.map(input => (
      input.replaceAll('\\\\', '/')
    ));
    const unusedForgeInputs = normalizedContributors.filter(input => (
      input.endsWith('/node-forge/lib/pbe.js')
      || input.endsWith('/node-forge/lib/pbkdf2.js')
      || input.endsWith('/node-forge/lib/pkcs12.js')
      || input.endsWith('/node-forge/lib/pkcs7asn1.js')
      || input.endsWith('/node-forge/lib/rc2.js')
    ));

    expect(unusedForgeInputs).toEqual([]);
  });

  it('forces Node WebSocket and bundles the installed registry protocol ESM entry', () => {
    const config = readFileSync(esbuildConfigPath, 'utf8');
    const aliases = {
      ...createDesktopRuntimeAliases(),
    };
    const normalizedInputs = bundleInputs.map(input => input.replaceAll('\\\\', '/'));
    const protocolInputs = normalizedInputs.filter(input => (
      input.endsWith('/node_modules/@claudian-collab/protocol/dist/esm/index.mjs')
      || input === 'node_modules/@claudian-collab/protocol/dist/esm/index.mjs'
    ));
    const bundle = readFileSync(bundlePath, 'utf8');

    expect(path.basename(aliases.ws)).toBe('index.js');
    expect(protocolInputs).toHaveLength(1);
    expect(config).toContain('...createDesktopRuntimeAliases()');
    expect(bundle).not.toContain('@claudian-collab/protocol');
    expect(bundle).not.toContain('ws does not work in the browser');
    expect(runBundle(`
      const dependencyEnvelope = require(process.argv[1]);
      process.stdout.write(JSON.stringify(dependencyEnvelope.probeWebSocket()));
    `)).toBe('["function","function"]');
  });

  it('produces one self-contained artifact without eager SQL initialization', () => {
    expect(readdirSync(tempDirectory)).toEqual(['dependency-envelope.cjs']);

    const result = runBundle(`
      let wasmInitializations = 0;
      const instantiate = WebAssembly.instantiate;
      WebAssembly.instantiate = (...args) => {
        wasmInitializations += 1;
        return instantiate(...args);
      };
      const dependencyEnvelope = require(process.argv[1]);
      process.stdout.write(JSON.stringify({
        exports: Object.keys(dependencyEnvelope).sort(),
        wasmInitializations,
      }));
    `);

    expect(JSON.parse(result)).toEqual({
      exports: [
        'probeDiffs',
        'probeLocale',
        'probeMarkdownDependencies',
        'probeSql',
        'probeTlsIdentity',
        'probeWebSocket',
        'renderCollabTextDiff',
      ],
      wasmInitializations: 0,
    });
  });

  it('Brotli-compresses static SQL and locale payloads without changing them', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    const localeResult = runBundle(`
      const dependencyEnvelope = require(process.argv[1]);
      process.stdout.write(JSON.stringify(dependencyEnvelope.probeLocale()));
    `);

    expect(bundle).toContain('brotliDecompressSync');
    expect(bundle).not.toContain('Create Collab project');
    expect(JSON.parse(localeResult)).toEqual([
      'Create Collab project',
      'Speichern',
    ]);
  });

  it('shares one compressed catalog across all locales', () => {
    const compressedCatalogContributors = bundleContributors.filter(input => (
      input.includes('compressed-locale-catalog')
    ));

    expect(compressedCatalogContributors).toEqual([
      'compressed-locale-catalog:all',
    ]);
  });

  it('round-trips every complete locale through the production bundle', async () => {
    const localeDirectory = path.join(root, 'src/i18n/locales');
    const localeFiles = readdirSync(localeDirectory)
      .filter(fileName => fileName.endsWith('.json'))
      .sort();
    const result = await build({
      absWorkingDir: root,
      bundle: true,
      charset: 'utf8',
      external: ['node:zlib'],
      format: 'cjs',
      minify: true,
      plugins: [createCompressedStaticAssetsPlugin()],
      stdin: {
        contents: [
          ...localeFiles.map((fileName, index) => (
            `import locale${index} from './src/i18n/locales/${fileName}';`
          )),
          `module.exports = [${localeFiles.map((_, index) => `locale${index}`).join(',')}];`,
        ].join('\n'),
        resolveDir: root,
      },
      target: 'es2022',
      write: false,
    });
    expect(result.outputFiles).toHaveLength(1);
    const output = await minifyProductionBundle(result.outputFiles[0].text);
    const module = { exports: [] as unknown[] };
    Function('module', 'exports', 'require', output)(module, module.exports, require);

    expect(module.exports).toEqual(localeFiles.map(fileName => (
      JSON.parse(readFileSync(path.join(localeDirectory, fileName), 'utf8'))
    )));
  });

  it('renders a production-minified diff using external host editor modules', () => {
    const result = JSON.parse(runBundle(`
      const { JSDOM } = require('jsdom');
      const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
      for (const key of ['document', 'Element', 'HTMLElement', 'MutationObserver', 'Node', 'window']) {
        Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
      }
      for (const [method, tag] of [['createDiv', 'div'], ['createSpan', 'span'], ['createEl', null]]) {
        dom.window.HTMLElement.prototype[method] = function(value) {
          const element = this.ownerDocument.createElement(tag || value);
          if (value && value.cls) element.className = value.cls;
          this.appendChild(element);
          return element;
        };
      }
      Object.defineProperty(globalThis, 'getComputedStyle', {
        configurable: true, value: dom.window.getComputedStyle.bind(dom.window),
      });
      const dependencyEnvelope = require(process.argv[1]);
      const wrapper = document.createElement('div');
      document.body.appendChild(wrapper);
      dependencyEnvelope.renderCollabTextDiff(wrapper).then(renderer => {
        const { EditorView } = require('@codemirror/view');
        const content = wrapper.querySelector('[role="textbox"]');
        const editor = EditorView.findFromDOM(content);
        const output = {
          dark: editor.state.facet(EditorView.darkTheme),
          readOnly: content.getAttribute('contenteditable'),
          text: editor.state.doc.toString(),
          deletion: wrapper.querySelector('del').textContent,
        };
        renderer.destroy();
        output.cleaned = wrapper.childElementCount === 0;
        dom.window.close();
        process.stdout.write(JSON.stringify(output));
      }).catch(error => {
        process.stderr.write(String(error && error.stack || error));
        process.exitCode = 1;
      });
    `));
    expect(result).toEqual({
      cleaned: true,
      dark: true,
      deletion: '# Collab heading before',
      readOnly: 'false',
      text: '# Collab heading after\n\n',
    });
  });

  it('loads SQL from the inlined Wasm and Diffs through its public API on demand', () => {
    const sqlResult = runBundle(`
      const dependencyEnvelope = require(process.argv[1]);
      dependencyEnvelope.probeSql()
        .then(value => process.stdout.write(String(value)))
        .catch(error => {
          process.stderr.write(String(error && error.stack || error));
          process.exitCode = 1;
        });
    `);
    const diffsResult = runBundle(`
      const dependencyEnvelope = require(process.argv[1]);
      dependencyEnvelope.probeDiffs()
        .then(value => process.stdout.write(value))
        .catch(error => {
          process.stderr.write(String(error && error.stack || error));
          process.exitCode = 1;
        });
    `);

    expect(sqlResult).toBe('1');
    expect(diffsResult).toBe('function');
  });

  function runBundle(script: string): string {
    const result = spawnSync(process.execPath, ['-e', script, bundlePath, root], {
      cwd: tempDirectory,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return result.stdout.trim();
  }
});
