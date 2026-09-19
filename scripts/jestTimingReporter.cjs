const { mkdirSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Capture Jest's resolved configuration rather than guessing from CLI defaults.
module.exports = class JestTimingReporter {
  constructor(globalConfig) {
    this.config = globalConfig;
  }

  onRunStart() {
    if (!this.config.json || !this.config.outputFile) return;
    mkdirSync(path.dirname(this.config.outputFile), { recursive: true });
    writeFileSync(`${this.config.outputFile}.metadata.json`, JSON.stringify({
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      availableParallelism: os.availableParallelism(),
      maxWorkers: this.config.maxWorkers,
      shard: this.config.shard ?? null,
      runner: process.env.RUNNER_NAME ?? null,
    }));
  }
};
