const {
  readFileSync,
  readdirSync,
} = require('node:fs');
const path = require('node:path');

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
const verifiedThemeImports = Object.freeze([
  'createTheme',
  'pierreThemes',
  'shikiThemes',
]);
const disabledWasmNamespace = 'collab-disabled-shiki-wasm';

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
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']shiki["']/g;

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

  return {
    imports: [...imports].sort(),
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
      build.onResolve({ filter: /^shiki$/ }, () => ({ path: adapterPath }));
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
