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
  // WSL init replaces HOME with the account's passwd home after WSLENV import.
  // The launcher restores this private copy after that platform boundary.
  const homeEntry = entries.find(entry => /^HOME(?:\/[^w]*)?$/u.test(entry));
  if (homeEntry && env.HOME !== undefined) {
    entries.push(homeEntry.replace('HOME', 'CLAUDIAN_WSL_HOME'));
    return { ...env, CLAUDIAN_WSL_HOME: env.HOME, WSLENV: entries.join(':') };
  }
  return entries.length || env.WSLENV !== undefined ? { ...env, WSLENV: entries.join(':') } : { ...env };
}
