/**
 * The native dsh services Claudian's bundled compatibility plugin reaches, at each supported native version. Plugins run
 * in their own Node process, so this is plain ESM that test scripts and process fixtures import by file URL. Services the
 * plugin is not expected to use are not modeled and throw.
 *
 * - 0.2.1 declares tool presentation per scope with `tools.presentAs()`, reads turn boundaries through generic
 *   projections and ships `list_agents` as the `/list-agents` subpath entry.
 * - 0.2.2 selects presentation by mounting an executor plugin in the agent's scope, reads turn boundaries through the
 *   Agent service and registers `list_agents` with the subagent control plugin.
 */
const VERSIONS = new Set(['0.2.1', '0.2.2']);
const MODULES = {
  '0.2.1': { '@deepseek-ai/dsh-tool-subagent-control/list-agents': 'list-agents' },
  '0.2.2': { '@deepseek-ai/dsh-tool-executor-native': 'native-tool-executor', '@deepseek-ai/dsh-tool-executor-ptc': 'ptc-tool-executor' },
};

const unmodeled = name => () => { throw new Error(`Native fixture does not model ${name}.`); };

export function createNativePluginHost(version) {
  if (!VERSIONS.has(version)) throw new Error(`Unsupported native fixture version ${version}.`);
  const scoped = version === '0.2.1';
  const listeners = {};
  const sections = [];
  /** Plugins mounted in the preset's own scope. */
  const mounted = [];
  /** Per-agent presentation and tool-policy declarations, in order. */
  const log = [];
  const turns = new Map();
  const turnBoundary = session => ({ lastTurn: turns.get(session.id) });
  const ctx = {
    effect: execute => execute(),
    on: (name, listener) => { (listeners[name] ??= []).push(listener); return () => {}; },
    systemPrompt: { section: section => { sections.push(section); return () => {}; }, getSectionOrder: name => name },
    sessionProjections: { stateOf: scoped ? (session, key) => key === 'turnBoundary' ? turnBoundary(session) : undefined : unmodeled('deprecated stateOf') },
    agents: scoped ? {} : { turnBoundaryOf: turnBoundary },
    tools: scoped ? { presentAs: unmodeled('preset-scope presentAs') } : {},
    loader: {
      import: async specifier => {
        const name = MODULES[version][specifier];
        if (name) return { name };
        throw Object.assign(new Error(`Package subpath is not defined by exports: ${specifier}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      },
    },
    plugin: module => { mounted.push(module.name); return { dispose: unmodeled('disposing a preset plugin') }; },
  };
  const agent = (id, { parent } = {}) => {
    const tools = { restrict: ({ allow }) => { log.push(`${id} allow ${allow.join(',')}`); } };
    return {
      id,
      session: { id, header: { id, ...(parent ? { parentSession: parent } : {}) } },
      ctx: scoped
        ? { tools: { ...tools, presentAs: mode => { log.push(`${id} present ${mode}`); return () => log.push(`${id} dispose ${mode}`); } } }
        : { tools, plugin: module => { log.push(`${id} present ${module.name}`); return { dispose: () => log.push(`${id} dispose ${module.name}`) }; } },
    };
  };
  return {
    ctx, sections, mounted, log, agent,
    /** Each plugin's apply result, which Cordis accepts only as a disposer or nothing. */
    apply: async (plugin, config) => {
      const result = await plugin.apply(ctx, config);
      if (result !== undefined && typeof result !== 'function') throw new Error(`Invalid Cordis effect: ${JSON.stringify(result)}`);
    },
    emit: (name, payload) => { for (const listener of listeners[name] ?? []) listener(payload); },
    setTurn: (sessionId, turn) => { turns.set(sessionId, turn); },
    /** Presentation labels this version records for direct tools and for code mode. */
    presentation: scoped ? { direct: 'native', code: 'both' } : { direct: 'native-tool-executor', code: 'ptc-tool-executor' },
  };
}
