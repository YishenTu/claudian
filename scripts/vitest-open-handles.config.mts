import base from '../vitest.config.mts';

// Native file-backed localStorage creates a process-lifetime resource. The test
// setup supplies in-memory storage when that option is absent.
export default {
  ...base,
  test: { ...base.test, execArgv: [], runner: './scripts/openHandleTestRunner.mjs' },
};
