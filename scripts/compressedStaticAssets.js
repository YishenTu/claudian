const { readFileSync } = require('node:fs');
const {
  brotliCompressSync,
  constants: zlibConstants,
} = require('node:zlib');

const localeFilter = /[\\/]src[\\/]i18n[\\/]locales[\\/][^\\/]+\.json$/;
const sqlWasmFilter = /[\\/]node_modules[\\/]sql\.js[\\/]dist[\\/]sql-wasm\.wasm$/;

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

function createCompressedStaticAssetsPlugin() {
  return {
    name: 'compressed-static-assets',
    setup(build) {
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
        const base64 = compress(raw, zlibConstants.BROTLI_MODE_TEXT);
        return {
          contents: [
            'import { brotliDecompressSync } from "node:zlib";',
            `const dictionary = JSON.parse(${decodeExpression(base64)}.toString("utf8"));`,
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
