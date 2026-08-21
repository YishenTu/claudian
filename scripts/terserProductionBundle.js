const { promises: fs } = require('node:fs');
const path = require('node:path');
const { minify } = require('terser');

const preservedComment = /^!|@preserve|@license|@cc_on/i;

async function minifyProductionBundle(source) {
  const result = await minify(source, {
    compress: {
      passes: 3,
      toplevel: true,
    },
    ecma: 2022,
    format: {
      comments: preservedComment,
    },
    mangle: {
      toplevel: true,
    },
    module: false,
  });
  if (typeof result.code !== 'string') {
    throw new Error('Terser did not produce a production bundle');
  }
  return result.code;
}

function createTerserProductionBundlePlugin(outputPaths) {
  return {
    name: 'terser-production-bundle',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length > 0) return;
        const workingDirectory = build.initialOptions.absWorkingDir ?? process.cwd();
        for (const outputPath of outputPaths) {
          const absolutePath = path.resolve(workingDirectory, outputPath);
          const source = await fs.readFile(absolutePath, 'utf8');
          const minified = await minifyProductionBundle(source);
          await fs.writeFile(absolutePath, `${minified}\n`, 'utf8');
        }
      });
    },
  };
}

module.exports = {
  createTerserProductionBundlePlugin,
  minifyProductionBundle,
};
