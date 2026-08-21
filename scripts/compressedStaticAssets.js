const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const {
  brotliCompressSync,
  constants: zlibConstants,
} = require('node:zlib');

const localeFilter = /[\\/]src[\\/]i18n[\\/]locales[\\/][^\\/]+\.json$/;
const sqlWasmFilter = /[\\/]node_modules[\\/]sql\.js[\\/]dist[\\/]sql-wasm\.wasm$/;
const localeCatalogSpecifier = 'claudian:compressed-locale-catalog';
const localeCatalogNamespace = 'compressed-locale-catalog';

function compress(contents, mode) {
  return brotliCompressSync(contents, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: mode,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    },
  }).toString('base64');
}

function decodeExpression(base64) {
  return `brotliDecompressSync(Buffer.from(${JSON.stringify(base64)}, "base64"))`;
}

function createCompressedStaticAssetsPlugin({ root = process.cwd() } = {}) {
  const localeDirectory = path.join(root, 'src', 'i18n', 'locales');

  return {
    name: 'compressed-static-assets',
    setup(build) {
      build.onResolve({ filter: /^claudian:compressed-locale-catalog$/ }, () => ({
        namespace: localeCatalogNamespace,
        path: 'non-english',
      }));

      build.onLoad({ filter: /.*/, namespace: localeCatalogNamespace }, () => {
        const catalog = Object.fromEntries(
          readdirSync(localeDirectory)
            .filter(fileName => fileName.endsWith('.json') && fileName !== 'en.json')
            .sort()
            .map(fileName => [
              path.basename(fileName, '.json'),
              JSON.parse(readFileSync(path.join(localeDirectory, fileName), 'utf8')),
            ]),
        );
        const base64 = compress(
          Buffer.from(JSON.stringify(catalog)),
          zlibConstants.BROTLI_MODE_TEXT,
        );
        return {
          contents: [
            'import { brotliDecompressSync } from "node:zlib";',
            `const compressedCatalog = ${JSON.stringify(base64)};`,
            'export function loadCompressedLocale(locale) {',
            '  const bytes = brotliDecompressSync(Buffer.from(compressedCatalog, "base64"));',
            '  const catalog = JSON.parse(bytes.toString("utf8"));',
            '  const dictionary = catalog[locale];',
            '  if (!dictionary) throw new Error(`Unsupported compressed locale: ${locale}`);',
            '  return dictionary;',
            '}',
          ].join('\n'),
          loader: 'js',
        };
      });

      build.onLoad({ filter: sqlWasmFilter }, (args) => {
        const base64 = compress(
          readFileSync(args.path),
          zlibConstants.BROTLI_MODE_GENERIC,
        );
        return {
          contents: [
            'import { brotliDecompressSync } from "node:zlib";',
            `const wasmBinary = ${decodeExpression(base64)};`,
            'export default wasmBinary;',
          ].join('\n'),
          loader: 'js',
        };
      });

      build.onLoad({ filter: localeFilter }, (args) => {
        const raw = readFileSync(args.path);
        const dictionary = JSON.parse(raw.toString('utf8'));
        const exportNames = Object.keys(dictionary);
        if (!exportNames.every(name => /^[$A-Z_a-z][$\w]*$/.test(name))) {
          throw new Error(`Locale ${args.path} has a top-level key that cannot be exported`);
        }
        const locale = path.basename(args.path, '.json');
        const dictionaryExpression = locale === 'en'
          ? `JSON.parse(${decodeExpression(
            compress(raw, zlibConstants.BROTLI_MODE_TEXT),
          )}.toString("utf8"))`
          : `loadCompressedLocale(${JSON.stringify(locale)})`;
        return {
          contents: [
            locale === 'en'
              ? 'import { brotliDecompressSync } from "node:zlib";'
              : `import { loadCompressedLocale } from ${JSON.stringify(localeCatalogSpecifier)};`,
            `const dictionary = ${dictionaryExpression};`,
            ...exportNames.map(name => `const ${name} = dictionary.${name};`),
            `export { ${exportNames.join(', ')} };`,
            'export default dictionary;',
          ].join('\n'),
          loader: 'js',
        };
      });
    },
  };
}

module.exports = { createCompressedStaticAssetsPlugin };
