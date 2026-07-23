import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import path from 'path';
import process from 'process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
} from 'fs';
import rendererSafeUnrefHelpers from './scripts/rendererSafeUnref.js';

const {
  findUnsafeTimerUnrefSites,
  patchRendererUnsafeUnrefSites,
} = rendererSafeUnrefHelpers;

// Load .env.local if it exists
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^=]+)=["']?(.+?)["']?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const prod = process.argv[2] === 'production';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNamedImportAliases(contents, exportName, moduleNames) {
  const aliases = new Set([exportName]);
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let match;

  while ((match = importPattern.exec(contents)) !== null) {
    const [, specifiers, moduleName] = match;
    if (!moduleNames.includes(moduleName)) continue;

    for (const specifier of specifiers.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts[0] === exportName) {
        aliases.add(parts[1] ?? exportName);
      }
    }
  }

  return [...aliases];
}

function patchSdkImportMetaUrl(contents) {
  let patched = contents.replace(
    'createRequire(import.meta.url)',
    'createRequire(__filename)',
  );

  for (const alias of getNamedImportAliases(patched, 'createRequire', ['module', 'node:module'])) {
    patched = patched.replace(
      new RegExp(`\\b${escapeRegExp(alias)}\\(import\\.meta\\.url\\)`, 'g'),
      `${alias}(__filename)`,
    );
  }

  for (const alias of getNamedImportAliases(patched, 'fileURLToPath', ['url', 'node:url'])) {
    patched = patched.replace(
      new RegExp(`\\b${escapeRegExp(alias)}\\(import\\.meta\\.url\\)`, 'g'),
      '__filename',
    );
  }

  return patched;
}

const patchSdkImportMeta = {
  name: 'patch-sdk-import-meta',
  setup(build) {
    build.onLoad(
      {
        filter: /[\\/]node_modules[\\/](?:@openai[\\/]codex-sdk[\\/]dist[\\/]index\.js|@anthropic-ai[\\/]claude-agent-sdk[\\/]sdk\.mjs|@qoder-ai[\\/]qoder-agent-sdk[\\/]dist[\\/].*\.js)$/,
      },
      async (args) => {
        const contents = await fsPromises.readFile(args.path, 'utf8');
        return {
          contents: patchSdkImportMetaUrl(contents),
          loader: 'js',
        };
      },
    );
  },
};

function createPatchRendererUnsafeUnref(outputPaths) {
  return {
    name: 'patch-renderer-unsafe-unref',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length > 0) return;

        for (const outputPath of outputPaths) {
          if (!existsSync(outputPath)) continue;
          const bundlePath = path.join(process.cwd(), outputPath);
          const originalContents = await fsPromises.readFile(bundlePath, 'utf8');
          const patchedBundle = patchRendererUnsafeUnrefSites(originalContents);

          if (patchedBundle.contents !== originalContents) {
            await fsPromises.writeFile(bundlePath, patchedBundle.contents, 'utf8');
          }

          const unsafeMatches = findUnsafeTimerUnrefSites(patchedBundle.contents);
          if (unsafeMatches.length > 0) {
            const details = unsafeMatches
              .slice(0, 5)
              .map((match) => `line ${match.line}: ${match.snippet}`)
              .join('\n');

            throw new Error(
              `Renderer-unsafe timer .unref() calls remain in ${outputPath}:\n${details}`,
            );
          }
        }
      });
    },
  };
}

// Obsidian plugin folder path (set via OBSIDIAN_VAULT env var or .env.local)
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT;
const OBSIDIAN_PLUGIN_PATH = OBSIDIAN_VAULT && existsSync(OBSIDIAN_VAULT)
  ? path.join(OBSIDIAN_VAULT, '.obsidian', 'plugins', 'claudian')
  : null;

// Plugin to copy built files to Obsidian plugin folder
const copyToObsidian = {
  name: 'copy-to-obsidian',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      rmSync(path.join(process.cwd(), '.codex-vendor'), { recursive: true, force: true });

      if (!OBSIDIAN_PLUGIN_PATH) return;

      if (!existsSync(OBSIDIAN_PLUGIN_PATH)) {
        mkdirSync(OBSIDIAN_PLUGIN_PATH, { recursive: true });
      }

      const files = ['main.js', 'manifest.json', 'styles.css'];
      for (const file of files) {
        if (existsSync(file)) {
          copyFileSync(file, path.join(OBSIDIAN_PLUGIN_PATH, file));
          console.log(`Copied ${file} to Obsidian plugin folder`);
        }
      }

      const pluginVendorRoot = path.join(OBSIDIAN_PLUGIN_PATH, '.codex-vendor');
      rmSync(pluginVendorRoot, { recursive: true, force: true });
    });
  }
};

const external = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
];

const mainContext = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [
    patchSdkImportMeta,
    createPatchRendererUnsafeUnref(['main.js']),
    copyToObsidian,
  ],
  external,
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  minify: prod,
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (prod) {
  await mainContext.rebuild();
  process.exit(0);
} else {
  await mainContext.watch();
}
