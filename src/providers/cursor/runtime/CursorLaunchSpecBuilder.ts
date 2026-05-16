import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';

export interface CursorLaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  spawnCwd: string | undefined;
}

export interface BuildCursorLaunchSpecInput {
  cliPath: string;
  prompt: string;
  envText: string;
  workspaceCwd?: string;
  threadId?: string;
  model?: string;
  /** Auto-approve tool calls (passes `--force` so command tools can run). */
  autoApprove?: boolean;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function mergeProcessEnv(envText: string): NodeJS.ProcessEnv {
  const overrides = parseEnvironmentVariables(envText || '');
  const merged: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  // Ensure PATH includes the user's standard install dirs so spawned tools
  // (git, node, etc.) inside the agent's shell tools resolve correctly.
  merged.PATH = getEnhancedPath(overrides.PATH ?? merged.PATH);
  return merged;
}

/**
 * Builds the spawn invocation for `cursor-agent` in headless streaming mode.
 *
 * The flag surface is sourced from the live binary (`cursor-agent --help`):
 *
 *   --print --output-format stream-json --stream-partial-output --force
 *   [--resume <threadId>] [--model <id>] [--workspace <cwd>]
 *
 * `--force` is set unconditionally during MVP because Claudian does not yet
 * surface tool approvals from the Cursor stream; without it any shell tool
 * the agent picks would block on a TTY prompt the plugin cannot satisfy.
 */
export function buildCursorLaunchSpec(input: BuildCursorLaunchSpecInput): CursorLaunchSpec {
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--stream-partial-output',
  ];

  if (input.autoApprove !== false) {
    args.push('--force');
  }

  const threadId = trimmedOrUndefined(input.threadId);
  if (threadId) {
    args.push('--resume', threadId);
  }

  const model = trimmedOrUndefined(input.model);
  if (model) {
    args.push('--model', model);
  }

  const workspace = trimmedOrUndefined(input.workspaceCwd);
  if (workspace) {
    args.push('--workspace', workspace);
  }

  args.push(input.prompt);

  return {
    command: input.cliPath,
    args,
    env: mergeProcessEnv(input.envText),
    spawnCwd: workspace,
  };
}

export interface BuildCursorCreateChatLaunchSpecInput {
  cliPath: string;
  envText: string;
  workspaceCwd?: string;
}

/**
 * Builds the spawn invocation for `cursor-agent create-chat`. Output is a
 * single line containing the new chat id on stdout.
 */
export function buildCursorCreateChatLaunchSpec(
  input: BuildCursorCreateChatLaunchSpecInput,
): CursorLaunchSpec {
  const workspace = trimmedOrUndefined(input.workspaceCwd);
  return {
    command: input.cliPath,
    args: ['create-chat'],
    env: mergeProcessEnv(input.envText),
    spawnCwd: workspace,
  };
}
