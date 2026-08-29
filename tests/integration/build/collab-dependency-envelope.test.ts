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

import { build, stop } from 'esbuild';

import * as compressedStaticAssetsHelpers from '../../../scripts/compressedStaticAssets.js';
import * as desktopRuntimeAliasHelpers from '../../../scripts/desktopRuntimeAliases.js';
import * as pierreShikiBundleHelpers from '../../../scripts/pierreShikiBundle.js';
import * as terserProductionBundleHelpers from '../../../scripts/terserProductionBundle.js';

const { createDesktopRuntimeAliases } = desktopRuntimeAliasHelpers;
const { createCompressedStaticAssetsPlugin } = compressedStaticAssetsHelpers;
const { minifyProductionBundle } = terserProductionBundleHelpers;
const {
  createPierreShikiBundlePlugin,
  inspectPierreThemeContract,
  inspectPierreShikiContract,
} = pierreShikiBundleHelpers;

const root = path.resolve(__dirname, '../../..');
const esbuildConfigPath = path.join(root, 'esbuild.config.mjs');
const packageJsonPath = path.join(root, 'package.json');
const performanceScriptPath = path.join(root, 'scripts/check-startup-performance.mjs');

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
        createPierreShikiBundlePlugin({ root }),
      ],
      stdin: {
        contents: `
          import { WebSocket, WebSocketServer } from 'ws';
          import { parser as markdownParser } from '@lezer/markdown';
          import { scanCollabTicketReferences } from '@claudian-collab/protocol';
          import * as english from './src/i18n/locales/en.json';
          import * as german from './src/i18n/locales/de.json';
          import { pierreThemes, shikiThemes } from '@pierre/theming/themes';
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
            return typeof diffs.FileDiff;
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

          export function probeThemes() {
            return [pierreThemes.getThemeNames(), shikiThemes.getThemeNames()];
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
      transformerImports: ['transformerStyleToClass'],
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

  it('uses Pierre without bundling a syntax-highlighting runtime', () => {
    const normalizedContributors = bundleContributors.map(input => input.replaceAll('\\\\', '/'));
    const syntaxRuntimeInputs = normalizedContributors.filter(input => (
      input.includes('/@shikijs/')
      || input.includes('/oniguruma-parser/')
      || input.includes('/oniguruma-to-es/')
    ));

    expect(syntaxRuntimeInputs).toEqual([]);
  });

  it('does not bundle Pierre filename language detection for text-only diffs', () => {
    const bundle = readFileSync(bundlePath, 'utf8');

    expect(bundle).not.toContain('actionscript-3');
    expect(bundle).not.toContain('fortran-fixed-form');
  });

  it('does not declare or bundle the unsupported Oniguruma engine', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const normalizedInputs = bundleInputs.map(input => input.replaceAll('\\\\', '/'));

    expect(packageJson.dependencies?.['@shikijs/engine-oniguruma']).toBeUndefined();
    expect(normalizedInputs.filter(input => (
      input.includes('/@shikijs/engine-oniguruma/dist/')
    ))).toEqual([]);
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

  it('retains only the Pierre component surface used by Collab', () => {
    const normalizedInputs = bundleContributors.map(input => input.replaceAll('\\\\', '/'));
    const unusedComponentInputs = normalizedInputs.filter(input => (
      input.endsWith('/@pierre/diffs/dist/components/CodeView.js')
      || input.endsWith('/@pierre/diffs/dist/components/FileStream.js')
      || input.endsWith('/@pierre/diffs/dist/components/UnresolvedFile.js')
    ));

    expect(unusedComponentInputs).toEqual([]);
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

  it('forces Node WebSocket and bundles the installed registry protocol', () => {
    const config = readFileSync(esbuildConfigPath, 'utf8');
    const aliases = {
      ...createDesktopRuntimeAliases(),
    };
    const normalizedInputs = bundleInputs.map(input => input.replaceAll('\\\\', '/'));
    const protocolInputs = normalizedInputs.filter(input => (
      input.endsWith('/node_modules/@claudian-collab/protocol/dist/index.js')
      || input === 'node_modules/@claudian-collab/protocol/dist/index.js'
    ));
    const bundle = readFileSync(bundlePath, 'utf8');

    expect(path.basename(aliases.ws)).toBe('index.js');
    expect(protocolInputs).toHaveLength(1);
    expect(config).toContain('...createDesktopRuntimeAliases()');
    expect(config).not.toContain('sourcePackageAliases');
    expect(bundle).not.toContain('@claudian-collab/protocol');
    expect(bundle).not.toContain('ws does not work in the browser');
    expect(runBundle(`
      const dependencyEnvelope = require(process.argv[1]);
      process.stdout.write(JSON.stringify(dependencyEnvelope.probeWebSocket()));
    `)).toBe('["function","function"]');
  });

  it('enforces the hard bundle budget and reports the pre-Step-11 health baseline', () => {
    const script = readFileSync(performanceScriptPath, 'utf8');

    expect(script).toContain('preCollabReferenceMainBytes = 3_739_584');
    expect(script).toContain('preStep11BundleHealthBaselineBytes = 4_896_000');
    expect(script).toContain('mainBudgetBytes = 5_000_000');
    expect(script).toContain('evaluationReviewThresholdMs = 150');
    expect(script).toContain('pre-Collab reference delta');
    expect(script).toContain('pre-Step-11 health baseline delta');
    expect(script).toContain('artifact.budgetExceeded');
    expect(script).not.toContain('historicalMainWarningBytes');
    expect(script).not.toContain('mainReviewThresholdBytes');
  });

  it('guards ordinary evaluation from deferred runtime initialization', () => {
    const script = readFileSync(performanceScriptPath, 'utf8');

    expect(script).toContain('Module evaluation failed:');
    expect(script).toContain("path.join(root, 'node_modules', '.bun', 'node_modules')");
    expect(script).toContain('NODE_PATH: childNodePath');
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
        'probeMarkdownDependencies',
        'probeSql',
        'probeThemes',
        'probeTlsIdentity',
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
      process.stdout.write(JSON.stringify(dependencyEnvelope.probeLocale()));
    `);

    expect(bundle).toContain('brotliDecompressSync');
    expect(bundle).not.toContain('Create Collab project');
    expect(JSON.parse(localeResult)).toEqual([
      'Create Collab project',
      'Speichern',
    ]);
  });

  it('Brotli-compresses Pierre static CSS and SVG payloads', () => {
    const bundle = readFileSync(bundlePath, 'utf8');

    expect(bundle).not.toContain('--diffs-font-fallback');
    expect(bundle).not.toContain('diffs-icon-brand-github');
  });

  it('shares one compressed catalog across non-English locales', () => {
    const compressedCatalogContributors = bundleContributors.filter(input => (
      input.includes('compressed-locale-catalog')
    ));

    expect(compressedCatalogContributors).toEqual([
      'compressed-locale-catalog:non-english',
    ]);
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
            .find(line => line.textContent.includes('Collab heading after'));
          const output = {
            blankLine: Boolean(root && Array.from(root.querySelectorAll('[data-line]'))
              .find(line => line.textContent.trim() === '')),
            coreCss: Boolean(coreSheet && coreSheet.text.includes('[data-line]')),
            customElement: container && container.tagName,
            diffSpan: Boolean(root && root.querySelector('[data-diff-span]')),
            lineText: heading && heading.textContent.trim(),
            sprite: Boolean(root && root.querySelector('#diffs-icon-file-code')),
            unified: Boolean(root && root.querySelector('[data-unified]')),
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
      blankLine: true,
      coreCss: true,
      customElement: 'DIFFS-CONTAINER',
      diffSpan: true,
      lineText: '# Collab heading after',
      sprite: true,
      unified: true,
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
