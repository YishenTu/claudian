import * as path from 'node:path';

export interface BuildCursorLaunchSpecParams {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface CursorLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function buildCursorLaunchSpec(params: BuildCursorLaunchSpecParams): CursorLaunchSpec {
  return {
    args: ['acp'],
    command: params.command,
    cwd: params.cwd,
    env: withCommandDirectoryOnPath(params.command, params.env ?? process.env),
  };
}

function withCommandDirectoryOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const commandPath = command.trim();
  if (!path.isAbsolute(commandPath)) return env;

  const commandDirectory = path.dirname(commandPath);
  const existingPath = env.PATH ?? '';
  const entries = existingPath.split(path.delimiter).filter(Boolean);
  if (entries.includes(commandDirectory)) return env;
  return { ...env, PATH: [commandDirectory, ...entries].join(path.delimiter) };
}
