const path = require('node:path');

function createSourcePackageAliases({ root = process.cwd() } = {}) {
  return Object.freeze({
    '@claudian/collab-protocol': path.join(
      root,
      'packages',
      'collab-protocol',
      'src',
      'index.ts',
    ),
  });
}

module.exports = { createSourcePackageAliases };
