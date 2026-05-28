/** @type {import('ts-jest').JestConfigWithTsJest} */
// Worktree-specific config: <rootDir> resolves to a path containing \.worktrees\
// which confuses the glob engine on Windows. Use explicit absolute forward-slash paths.
const root = __dirname.replace(/\\/g, '/');

const baseConfig = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: `${root}/tsconfig.jest.json` }],
  },
  roots: [`${root}/src`, `${root}/tests`],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  setupFilesAfterEnv: [`${root}/tests/setupWindow.ts`],
  moduleNameMapper: {
    '^@/(.*)$': `${root}/src/$1`,
    '^@test/(.*)$': `${root}/tests/$1`,
    '^@anthropic-ai/claude-agent-sdk$': `${root}/tests/__mocks__/claude-agent-sdk.ts`,
    '^obsidian$': `${root}/tests/__mocks__/obsidian.ts`,
    '^@modelcontextprotocol/sdk/(.*)$': `${root}/node_modules/@modelcontextprotocol/sdk/dist/cjs/$1`,
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@anthropic-ai/claude-agent-sdk)/)',
  ],
};

module.exports = {
  projects: [
    {
      ...baseConfig,
      displayName: 'unit',
      testMatch: [`${root}/tests/unit/**/*.test.ts`],
    },
    {
      ...baseConfig,
      displayName: 'integration',
      testMatch: [`${root}/tests/integration/**/*.test.ts`],
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
};
