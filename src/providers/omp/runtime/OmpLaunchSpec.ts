import * as path from 'node:path';

import type { OmpProviderSettings } from '../settings';

export function buildOmpEnvironment(
  inheritedEnv: NodeJS.ProcessEnv,
  configuredEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const withoutPiEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^PI_/i.test(key)),
  );

  return {
    ...withoutPiEnvironment(inheritedEnv),
    ...withoutPiEnvironment(configuredEnv),
  };
}

export interface BuildOmpLaunchSpecParams {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  settings: OmpProviderSettings;
}

export interface OmpLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function buildOmpLaunchSpec(params: BuildOmpLaunchSpecParams): OmpLaunchSpec {
  return {
    args: ['acp'],
    command: params.command,
    cwd: params.cwd,
    env: withCommandDirectoryOnPath(params.command, params.env ?? process.env),
  };
}

function withCommandDirectoryOnPath(command: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const commandPath = command.trim();
  if (!path.isAbsolute(commandPath)) return env;

  const commandDirectory = path.dirname(commandPath);
  const existingPath = env.PATH ?? '';
  const entries = existingPath.split(path.delimiter).filter(Boolean);
  if (entries.includes(commandDirectory)) return env;
  return { ...env, PATH: [commandDirectory, ...entries].join(path.delimiter) };
}
