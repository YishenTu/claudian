import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';

export default class VitestMetadataReporter {
  activeModules = new Set();

  onInit(ctx) {
    this.ctx = ctx;
  }

  get outputFile() {
    const { outputFile } = this.ctx.config;
    return typeof outputFile === 'string' ? outputFile : outputFile?.json;
  }

  onTestRunStart() {
    this.activeModules.clear();
    this.writeProgress();
  }

  onTestModuleQueued(module) {
    this.activeModules.add(module.moduleId);
    this.writeProgress();
  }

  onTestModuleEnd(module) {
    this.activeModules.delete(module.moduleId);
    this.writeProgress();
  }

  writeProgress() {
    if (!this.outputFile) return;
    mkdirSync(path.dirname(this.outputFile), { recursive: true });
    // Keep the in-flight files available even if a blocked worker prevents the
    // final JSON report and teardown hooks from running.
    writeFileSync(`${this.outputFile}.progress.json`, JSON.stringify({
      shard: this.ctx.config.shard ?? null,
      activeModules: [...this.activeModules],
    }, null, 2));
  }

  onTestRunEnd(_modules, errors, reason) {
    const { config } = this.ctx;
    const output = this.outputFile;
    if (!output) return;
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(`${output}.metadata.json`, JSON.stringify({
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      availableParallelism: availableParallelism(),
      maxWorkers: config.maxWorkers,
      shard: config.shard ?? null,
      runner: process.env.RUNNER_NAME ?? null,
      projects: this.ctx.projects.map(project => ({ name: project.name, pool: project.config.pool })),
      unhandledErrors: errors.length,
      reason,
    }));
  }
}
