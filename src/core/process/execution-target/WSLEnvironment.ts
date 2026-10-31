/** Describes a value selected for forwarding into Linux. */
export interface WSLForwardedVariable {
  key: string;
  hostPath?: boolean;
  pathList?: boolean;
}

export interface WSLPathVariable {
  key: string;
  pathList?: boolean;
}

const STANDARD_PATH_VARIABLES: readonly WSLPathVariable[] = [
  { key: 'SSL_CERT_FILE' }, { key: 'SSL_CERT_DIR', pathList: true },
  { key: 'REQUESTS_CA_BUNDLE' }, { key: 'CURL_CA_BUNDLE' }, { key: 'NODE_EXTRA_CA_CERTS' },
  { key: 'TMPDIR' }, { key: 'TMP' }, { key: 'TEMP' },
];

/** Providers approve inherited names and describe their own paths; process path policy is shared. */
export function selectWSLForwardedEnvironment({ env, configured, inheritedKeys, providerPathVariables }: {
  env: Readonly<NodeJS.ProcessEnv>;
  configured: Readonly<Record<string, string>>;
  inheritedKeys: readonly string[];
  providerPathVariables: readonly WSLPathVariable[];
}): WSLForwardedVariable[] {
  const keys = new Set([...Object.keys(configured), ...inheritedKeys]);
  const pathVariables = new Map([...STANDARD_PATH_VARIABLES, ...providerPathVariables].map(variable => [variable.key, variable]));
  return [...keys].filter(key => {
    // Only explicitly configured Linux HOME/PATH may replace the distro defaults.
    if (['HOME', 'PATH', 'USERPROFILE'].includes(key)) {
      return key !== 'USERPROFILE' && configured[key]?.startsWith('/') && !configured[key].includes('\\');
    }
    return key !== 'WSLENV';
  }).map(key => {
    const pathVariable = pathVariables.get(key);
    const hostPath = pathVariable !== undefined && /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/u.test(env[key] ?? '');
    return { key, hostPath, pathList: hostPath && pathVariable?.pathList === true };
  });
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
