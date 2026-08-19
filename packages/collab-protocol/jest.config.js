const os = require('node:os');

const availableParallelism = os.availableParallelism?.() ?? os.cpus().length;
const maxWorkers = Math.max(1, Math.min(4, Math.floor(availableParallelism / 2)));

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  maxWorkers,
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
  },
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
};
