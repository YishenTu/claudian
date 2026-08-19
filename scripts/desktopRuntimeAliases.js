const desktopRequire = require;

function createDesktopRuntimeAliases() {
  return Object.freeze({
    ws: desktopRequire.resolve('ws'),
  });
}

module.exports = {
  createDesktopRuntimeAliases,
};
