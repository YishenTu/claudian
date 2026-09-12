const base = require('./jest.config.js').projects[0];

if (!process.env.CLAUDIAN_LAN_BASELINE_MODULE) {
  throw new Error('Run published LAN compatibility with npm run test:lan-compatibility');
}

module.exports = {
  ...base,
  rootDir: __dirname,
  displayName: 'published-lan',
  roots: ['<rootDir>/tests/compatibility'],
  testMatch: ['<rootDir>/tests/compatibility/**/*.test.ts'],
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^sql.js/dist/sql-wasm.wasm$': '<rootDir>/tests/compatibility/SqlWasmAsset.ts',
    '^@lan226$': process.env.CLAUDIAN_LAN_BASELINE_MODULE,
  },
};
