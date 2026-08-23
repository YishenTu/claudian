const desktopRequire = require;
const path = require('node:path');

function createDesktopRuntimeAliases() {
  const markdownCommonJsEntry = desktopRequire.resolve('@lezer/markdown');

  return Object.freeze({
    '@lezer/markdown': path.join(path.dirname(markdownCommonJsEntry), 'index.js'),
    ws: desktopRequire.resolve('ws'),
  });
}

module.exports = {
  createDesktopRuntimeAliases,
};
