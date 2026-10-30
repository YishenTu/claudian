/** Callers own which values cross into Linux and whether they are host paths. */
export interface WSLForwardedVariable {
  key: string;
  hostPath?: boolean;
  pathList?: boolean;
}

export function forwardWSLEnvironment(
  env: Record<string, string>,
  variables: readonly WSLForwardedVariable[],
): Record<string, string> {
  const declarations = new Map(variables.filter(({ key }) => key !== 'WSLENV').map(variable => [variable.key, variable]));
  const entries = (env.WSLENV ?? '').split(':').filter(entry => entry && !declarations.has(entry.split('/')[0]));
  for (const { key, hostPath, pathList } of declarations.values()) {
    if (env[key] === undefined) continue;
    const flags = `${hostPath ? 'p' : ''}${pathList ? 'l' : ''}`;
    entries.push(`${key}${flags ? `/${flags}` : ''}`);
  }
  return entries.length || env.WSLENV !== undefined ? { ...env, WSLENV: entries.join(':') } : { ...env };
}
