/**
 * Static native plugins, bundled as text and written beside the launch patch. They import only Node
 * built-ins. Prompts never appear in code: each preset reads its own prompt file at every assembly, and chat agents
 * read the code-mode file at creation and at each turn start.
 */
export const DEEPSEEK_COMPATIBILITY_SOURCE = String.raw`
import { readFileSync } from 'node:fs';

export const name = 'claudian-compatibility';
export const inject = ['systemPrompt', 'tools'];

export function apply(ctx, config) {
  if (typeof config?.promptFile !== 'string' || !config.promptFile) {
    throw new TypeError('Claudian compatibility requires a prompt file.');
  }
  const allowed = ['read', 'read_image', 'glob', 'grep'];
  if (config.allow !== undefined && (!Array.isArray(config.allow)
    || config.allow.some(value => !allowed.includes(value))
    || (config.allow.length !== 0 && (config.allow.length !== 4 || new Set(config.allow).size !== 4)))) {
    throw new TypeError('Claudian auxiliary policy must be passive or read-only.');
  }
  if (config.codeModeFile !== undefined && (typeof config.codeModeFile !== 'string' || !config.codeModeFile || config.allow !== undefined)) {
    throw new TypeError('Claudian code mode requires a chat preset and a mode file.');
  }
  const prompt = () => readFileSync(config.promptFile, 'utf8');
  for (const [name, order, text] of [
    ['deployment:persona-prefix', 'DEPLOYMENT_PERSONA_PREFIX', prompt],
    ['deployment:persona-suffix', 'DEPLOYMENT_PERSONA_SUFFIX', ''],
    ['harness:identity', 'HARNESS_IDENTITY', ''],
    ['harness:source', 'HARNESS_SOURCE', ''],
    ['app:web-surface', 'WEB_SURFACE', ''],
    ['ui:deliverable-file-references', 'DELIVERABLE_FILE_REFERENCES', ''],
  ]) {
    ctx.effect(() => ctx.systemPrompt.section({
      name, order: ctx.systemPrompt.getSectionOrder(order), text,
      interpolate: false, complete: false,
    }), 'claudian.compatibility.section()');
  }
  if (config.allow !== undefined) {
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.presentAs('native');
      agent.ctx.tools.restrict({ allow: config.allow });
    });
  }
  if (config.codeModeFile !== undefined) {
    // Chat presentation follows Claudian's live code-mode preference, read only between turns.
    const declared = new WeakMap();
    const present = agent => {
      let mode = 'native';
      try { if (readFileSync(config.codeModeFile, 'utf8') === 'both') mode = 'both'; } catch {}
      const current = declared.get(agent);
      if (current?.mode === mode) return;
      current?.dispose();
      declared.set(agent, { mode, dispose: agent.ctx.tools.presentAs(mode) });
    };
    ctx.on('agent/created', ({ agent }) => present(agent));
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'running') present(agent); });
  }
}
`;

/** Claudian keeps the Host's stdin open for its whole lifetime; EOF means the owner is gone. */
export const DEEPSEEK_LIFECYCLE_SOURCE = String.raw`
export const name = 'claudian-lifecycle';

export function apply() {
  const exit = () => process.kill(process.pid, 'SIGTERM');
  process.stdin.once('end', exit);
  process.stdin.once('error', exit);
  process.stdin.resume();
}
`;
