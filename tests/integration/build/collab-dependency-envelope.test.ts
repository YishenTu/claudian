import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build, stop } from 'esbuild';

import * as compressedStaticAssetsHelpers from '../../../scripts/compressedStaticAssets.js';
import * as desktopRuntimeAliasHelpers from '../../../scripts/desktopRuntimeAliases.js';
import * as pierreShikiBundleHelpers from '../../../scripts/pierreShikiBundle.js';

const { createDesktopRuntimeAliases } = desktopRuntimeAliasHelpers;
const { createCompressedStaticAssetsPlugin } = compressedStaticAssetsHelpers;
const {
  createPierreShikiBundlePlugin,
  inspectPierreThemeContract,
  inspectPierreShikiContract,
} = pierreShikiBundleHelpers;

const root = path.resolve(__dirname, '../../..');
const esbuildConfigPath = path.join(root, 'esbuild.config.mjs');
const performanceScriptPath = path.join(root, 'scripts/check-startup-performance.mjs');

describe('Collab dependency envelope', () => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'claudian-collab-build-'));
  const bundlePath = path.join(tempDirectory, 'dependency-envelope.cjs');
  let bundleInputs: string[] = [];

  beforeAll(async () => {
    const result = await build({
      absWorkingDir: root,
      alias: createDesktopRuntimeAliases(),
      bundle: true,
      external: [
        ...builtinModules,
        ...builtinModules.map(moduleName => `node:${moduleName}`),
      ],
      format: 'cjs',
      loader: { '.wasm': 'binary' },
      logLevel: 'silent',
      metafile: true,
      outfile: bundlePath,
      platform: 'browser',
      plugins: [
        createCompressedStaticAssetsPlugin(),
        createPierreShikiBundlePlugin({ root }),
      ],
      stdin: {
        contents: `
          import { WebSocket, WebSocketServer } from 'ws';
          import initSqlJs from 'sql.js';
          import sqlWasmBinary from 'sql.js/dist/sql-wasm.wasm';
          import * as english from './src/i18n/locales/en.json';
          import { pierreThemes, shikiThemes } from '@pierre/theming/themes';
          import { CollabDiffRenderer } from './src/features/collab/detail/review/CollabDiffRenderer';

          export function probeWebSocket() {
            return [typeof WebSocket, typeof WebSocketServer];
          }

          export async function probeSql() {
            const SQL = await initSqlJs({ wasmBinary: sqlWasmBinary });
            const database = new SQL.Database();
            const result = database.exec('SELECT 1 AS value');
            database.close();
            return result[0].values[0][0];
          }

          export async function probeDiffs() {
            const diffs = await import('@pierre/diffs');
            return typeof diffs.FileDiff;
          }

          export function probeLocale() {
            return english.collab.commands.createProject;
          }

          export function probeThemes() {
            return [pierreThemes.getThemeNames(), shikiThemes.getThemeNames()];
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
              newText: '# Collab heading\\n',
              oldText: null,
              path: 'note.md',
            });
            return renderer;
          }
        `,
        loader: 'ts',
        resolveDir: root,
        sourcefile: 'collab-dependency-envelope.ts',
      },
      target: 'node24',
    });
    bundleInputs = Object.keys(result.metafile.inputs);
  }, 60_000);

  afterAll(() => {
    stop();
    rmSync(tempDirectory, { force: true, recursive: true });
  });

  it('configures the production build to inline WebAssembly assets', () => {
    const config = readFileSync(esbuildConfigPath, 'utf8');

    expect(config).toContain("'.wasm': 'binary'");
    expect(config).toContain('createCompressedStaticAssetsPlugin()');
    expect(config).toContain("target: 'es2022'");
    expect(config).toContain("charset: 'utf8'");
  });

  it('pins Pierre to its verified fine-grained Shiki import contract', () => {
    const config = readFileSync(esbuildConfigPath, 'utf8');

    expect(inspectPierreShikiContract({ root })).toEqual({
      imports: [
        'bundledLanguages',
        'codeToHtml',
        'createCssVariablesTheme',
        'createHighlighter',
        'createJavaScriptRegexEngine',
        'createOnigurumaEngine',
        'getTokenStyleObject',
        'stringifyTokenStyle',
      ],
      version: '1.3.5',
    });
    expect(inspectPierreThemeContract({ root })).toEqual([
      'createTheme',
      'pierreThemes',
      'shikiThemes',
    ]);
    expect(config).toContain('createPierreShikiBundlePlugin()');
  });

  it('excludes syntax grammars, theme catalogs, and Oniguruma Wasm', () => {
    const normalizedInputs = bundleInputs.map(input => input.replaceAll('\\\\', '/'));
    const languageInputs = normalizedInputs.filter(input => (
      input.includes('/@shikijs/langs/dist/') && input.endsWith('.mjs')
    ));
    const themeCatalogInputs = normalizedInputs.filter(input => (
      input.includes('/@shikijs/themes/dist/')
      || input.includes('/@pierre/theme/dist/pierre-')
    ));
    const inlinedOnigurumaInputs = normalizedInputs.filter(input => (
      input.includes('/@shikijs/engine-oniguruma/dist/wasm-inlined')
      || input.includes('/shiki/dist/wasm')
    ));

    expect(languageInputs).toEqual([]);
    expect(themeCatalogInputs).toEqual([]);
    expect(inlinedOnigurumaInputs).toEqual([]);
  });

  it('forces the Node WebSocket implementation inside the browser-oriented bundle', () => {
    const config = readFileSync(esbuildConfigPath, 'utf8');
    const aliases = createDesktopRuntimeAliases();

    expect(path.basename(aliases.ws)).toBe('index.js');
    expect(config).toContain('alias: createDesktopRuntimeAliases()');
    expect(readFileSync(bundlePath, 'utf8')).not.toContain('ws does not work in the browser');
    expect(runBundle(`
      const dependencyEnvelope = require(process.argv[1]);
      process.stdout.write(JSON.stringify(dependencyEnvelope.probeWebSocket()));
    `)).toBe('["function","function"]');
  });

  it('treats 5 MB as historical guidance and 20 MB as the review gate', () => {
    const script = readFileSync(performanceScriptPath, 'utf8');

    expect(script).toContain('preCollabReferenceMainBytes = 3_739_584');
    expect(script).toContain('historicalMainWarningBytes = 5_000_000');
    expect(script).toContain('mainReviewThresholdBytes = 20_000_000');
    expect(script).toContain('evaluationReviewThresholdMs = 150');
    expect(script).toContain('pre-Collab reference delta');
    expect(script).not.toContain('mainBudgetBytes');
  });

  it('guards ordinary evaluation from deferred runtime initialization', () => {
    const script = readFileSync(performanceScriptPath, 'utf8');

    expect(script).toContain('childProcessStarts !== 0');
    expect(script).toContain('networkListens !== 0');
    expect(script).toContain('wasmInitializations !== 0');
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
        'probeSql',
        'probeThemes',
        'probeWebSocket',
        'renderCollabTextDiff',
      ],
      wasmInitializations: 0,
    });
  });

  it('registers exactly the local dark and light Pierre themes', () => {
    const result = runBundle(`
      const dependencyEnvelope = require(process.argv[1]);
      process.stdout.write(JSON.stringify(dependencyEnvelope.probeThemes()));
    `);

    expect(JSON.parse(result)).toEqual([
      ['pierre-dark', 'pierre-light'],
      [],
    ]);
  });

  it('Brotli-compresses static SQL and locale payloads without changing them', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    const localeResult = runBundle(`
      const dependencyEnvelope = require(process.argv[1]);
      process.stdout.write(dependencyEnvelope.probeLocale());
    `);

    expect(bundle).toContain('brotliDecompressSync');
    expect(bundle).not.toContain('Create Collab project');
    expect(localeResult).toBe('Create Collab project');
  });

  it('mounts Collab review through the styled Pierre custom element', () => {
    const result = JSON.parse(runBundle(`
      const { JSDOM } = require(require.resolve('jsdom', { paths: [process.argv[2]] }));
      const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
      const sheets = new WeakMap();
      class TestStyleSheet {
        replaceSync(value) { this.text = value; }
      }
      class TestResizeObserver {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
      Object.defineProperty(dom.window.ShadowRoot.prototype, 'adoptedStyleSheets', {
        configurable: true,
        get() { return sheets.get(this) || []; },
        set(value) { sheets.set(this, value); },
      });
      for (const key of [
        'customElements',
        'document',
        'Element',
        'HTMLElement',
        'MutationObserver',
        'Node',
        'ShadowRoot',
        'SVGElement',
        'window',
      ]) {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          value: dom.window[key],
        });
      }
      Object.defineProperties(globalThis, {
        CSSStyleSheet: { configurable: true, value: TestStyleSheet },
        ResizeObserver: { configurable: true, value: TestResizeObserver },
        cancelAnimationFrame: {
          configurable: true,
          value: dom.window.cancelAnimationFrame.bind(dom.window),
        },
        getComputedStyle: {
          configurable: true,
          value: dom.window.getComputedStyle.bind(dom.window),
        },
        navigator: { configurable: true, value: dom.window.navigator },
        requestAnimationFrame: {
          configurable: true,
          value: dom.window.requestAnimationFrame.bind(dom.window),
        },
      });
      const dependencyEnvelope = require(process.argv[1]);
      const wrapper = document.createElement('div');
      document.body.appendChild(wrapper);
      dependencyEnvelope.renderCollabTextDiff(wrapper)
        .then(renderer => setTimeout(() => {
          const container = wrapper.querySelector('diffs-container');
          const root = container && container.shadowRoot;
          const coreSheet = root && root.adoptedStyleSheets[0];
          const heading = root && Array.from(root.querySelectorAll('[data-line]'))
            .find(line => line.textContent.includes('Collab heading'));
          const output = {
            coreCss: Boolean(coreSheet && coreSheet.text.includes('[data-line]')),
            customElement: container && container.tagName,
            lineText: heading && heading.textContent.trim(),
          };
          renderer.destroy();
          process.stdout.write(JSON.stringify(output));
        }, 250))
        .catch(error => {
          process.stderr.write(String(error && error.stack || error));
          process.exitCode = 1;
        });
    `));

    expect(result).toEqual({
      coreCss: true,
      customElement: 'DIFFS-CONTAINER',
      lineText: '# Collab heading',
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
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return result.stdout.trim();
  }
});
