const {
  readFileSync,
  readdirSync,
} = require('node:fs');
const path = require('node:path');
const {
  brotliCompressSync,
  constants: zlibConstants,
} = require('node:zlib');

const verifiedPierreVersion = '1.3.5';
const verifiedShikiImports = Object.freeze([
  'bundledLanguages',
  'codeToHtml',
  'createCssVariablesTheme',
  'createHighlighter',
  'createJavaScriptRegexEngine',
  'createOnigurumaEngine',
  'getTokenStyleObject',
  'stringifyTokenStyle',
]);
const verifiedShikiTransformerImports = Object.freeze([
  'transformerStyleToClass',
]);
const verifiedThemeImports = Object.freeze([
  'createTheme',
  'pierreThemes',
  'shikiThemes',
]);
const disabledWasmNamespace = 'collab-disabled-shiki-wasm';

function compressPierreStaticText(value) {
  return brotliCompressSync(Buffer.from(value), {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    },
  }).toString('base64');
}

function decompressedTextExpression(value) {
  return [
    'brotliDecompressSync(',
    `Buffer.from(${JSON.stringify(compressPierreStaticText(value))}, "base64")`,
    ').toString("utf8")',
  ].join('');
}

function extractPierreStyle(source) {
  const prefix = 'var style_default = ';
  const start = source.indexOf(prefix);
  const end = source.indexOf(';\n//#endregion', start + prefix.length);
  if (start < 0 || end < 0) {
    throw new Error('@pierre/diffs style module contract changed');
  }
  return JSON.parse(source.slice(start + prefix.length, end));
}

function extractPierreSprite(source) {
  const prefix = 'const SVGSpriteSheet = `';
  const start = source.indexOf(prefix);
  const end = source.indexOf('`;\n//#endregion', start + prefix.length);
  if (start < 0 || end < 0) {
    throw new Error('@pierre/diffs sprite module contract changed');
  }
  const sprite = source.slice(start + prefix.length, end);
  if (sprite.includes('${') || sprite.includes('`') || sprite.includes('\\')) {
    throw new Error('@pierre/diffs sprite module is no longer static text');
  }
  return sprite;
}

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files;
}

function inspectPierreShikiContract({ root = process.cwd() } = {}) {
  const packageRoot = path.join(root, 'node_modules', '@pierre', 'diffs');
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const imports = new Set();
  const transformerImports = new Set();
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']shiki["']/g;
  const transformerImportPattern = /import\s*\{([^}]+)\}\s*from\s*["']@shikijs\/transformers["']/g;

  for (const filePath of collectJavaScriptFiles(path.join(packageRoot, 'dist'))) {
    const contents = readFileSync(filePath, 'utf8');
    let match;
    while ((match = importPattern.exec(contents)) !== null) {
      for (const specifier of match[1].split(',')) {
        const importedName = specifier.trim().split(/\s+as\s+/)[0];
        if (importedName) imports.add(importedName);
      }
    }
    while ((match = transformerImportPattern.exec(contents)) !== null) {
      for (const specifier of match[1].split(',')) {
        const importedName = specifier.trim().split(/\s+as\s+/)[0];
        if (importedName) transformerImports.add(importedName);
      }
    }
  }

  return {
    imports: [...imports].sort(),
    transformerImports: [...transformerImports].sort(),
    version: packageJson.version,
  };
}

function inspectPierreThemeContract({ root = process.cwd() } = {}) {
  const packageRoot = path.join(root, 'node_modules', '@pierre', 'diffs');
  const imports = new Set();
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']@pierre\/theming\/themes["']/g;

  for (const filePath of collectJavaScriptFiles(path.join(packageRoot, 'dist'))) {
    const contents = readFileSync(filePath, 'utf8');
    let match;
    while ((match = importPattern.exec(contents)) !== null) {
      for (const specifier of match[1].split(',')) {
        const importedName = specifier.trim().split(/\s+as\s+/)[0];
        if (importedName) imports.add(importedName);
      }
    }
  }

  return [...imports].sort();
}

function assertVerifiedPierreShikiContract(options) {
  const contract = inspectPierreShikiContract(options);
  const expected = {
    imports: [...verifiedShikiImports],
    transformerImports: [...verifiedShikiTransformerImports],
    version: verifiedPierreVersion,
  };
  if (
    contract.version !== expected.version
    || JSON.stringify(contract.imports) !== JSON.stringify(expected.imports)
    || JSON.stringify(inspectPierreThemeContract(options))
      !== JSON.stringify(verifiedThemeImports)
  ) {
    throw new Error(
      `@pierre/diffs dependency contract changed: expected ${JSON.stringify({
        ...expected,
        themeImports: verifiedThemeImports,
      })}, received ${JSON.stringify({
        ...contract,
        themeImports: inspectPierreThemeContract(options),
      })}`,
    );
  }
}

function createPierreShikiBundlePlugin({ root = process.cwd() } = {}) {
  const adapterPath = path.join(
    root,
    'src',
    'features',
    'collab',
    'detail',
    'review',
    'CollabShikiAdapter.ts',
  );
  const themesPath = path.join(
    root,
    'src',
    'features',
    'collab',
    'detail',
    'review',
    'CollabPierreThemes.ts',
  );

  return {
    name: 'collab-minimal-pierre-dependencies',
    setup(build) {
      build.onStart(() => {
        assertVerifiedPierreShikiContract({ root });
      });
      build.onLoad(
        { filter: /[\\/]node_modules[\\/]@pierre[\\/]diffs[\\/]dist[\\/]style\.js$/ },
        (args) => ({
          contents: [
            'import { brotliDecompressSync } from "node:zlib";',
            `export default ${decompressedTextExpression(extractPierreStyle(readFileSync(args.path, 'utf8')))};`,
          ].join('\n'),
          loader: 'js',
        }),
      );
      build.onLoad(
        { filter: /[\\/]node_modules[\\/]@pierre[\\/]diffs[\\/]dist[\\/]sprite\.js$/ },
        (args) => ({
          contents: [
            'import { brotliDecompressSync } from "node:zlib";',
            `export const SVGSpriteSheet = ${decompressedTextExpression(extractPierreSprite(readFileSync(args.path, 'utf8')))};`,
          ].join('\n'),
          loader: 'js',
        }),
      );
      build.onLoad(
        {
          filter: /[\\/]node_modules[\\/]@pierre[\\/]diffs[\\/]dist[\\/]utils[\\/]getFiletypeFromFileName\.js$/,
        },
        () => ({
          contents: [
            'export const EXTENSION_TO_FILE_FORMAT = Object.freeze({});',
            'const customExtensions = new Map();',
            'let customExtensionsVersion = 0;',
            'export function getFiletypeFromFileName() { return "text"; }',
            'export function getCustomExtensionsMap() { return new Map(customExtensions); }',
            'export function getCustomExtensionsVersion() { return customExtensionsVersion; }',
            'export function replaceCustomExtensions(version, values) {',
            '  customExtensions.clear();',
            '  for (const [key, value] of values) customExtensions.set(key, value);',
            '  customExtensionsVersion = version;',
            '}',
            'export function setCustomExtension(key, value) {',
            '  customExtensions.set(key, value);',
            '  customExtensionsVersion += 1;',
            '}',
          ].join('\n'),
          loader: 'js',
        }),
      );
      build.onResolve({ filter: /^shiki$/ }, () => ({ path: adapterPath }));
      build.onResolve({ filter: /^@shikijs\/transformers$/ }, () => ({ path: adapterPath }));
      build.onResolve({ filter: /^@pierre\/theming\/themes$/ }, () => ({
        path: themesPath,
      }));
      build.onResolve({ filter: /^shiki\/wasm$/ }, () => ({
        namespace: disabledWasmNamespace,
        path: 'shiki/wasm',
      }));
      build.onLoad({ filter: /.*/, namespace: disabledWasmNamespace }, () => ({
        contents: [
          'throw new Error("The Collab text diff renderer does not support Shiki Wasm.");',
          'export default undefined;',
        ].join('\n'),
        loader: 'js',
      }));
    },
  };
}

module.exports = {
  createPierreShikiBundlePlugin,
  inspectPierreThemeContract,
  inspectPierreShikiContract,
};
