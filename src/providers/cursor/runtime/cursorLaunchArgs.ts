export type CursorPermissionMode = 'yolo' | 'plan' | 'normal';

export interface BuildCursorAgentFlagArgsOptions {
  workspaceDir: string;
  model?: string | null;
  permissionMode: CursorPermissionMode;
  resumeSessionId?: string | null;
  approveMcps?: boolean;
}

export function buildCursorAgentFlagArgs(options: BuildCursorAgentFlagArgsOptions): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--stream-partial-output',
    '--workspace', options.workspaceDir,
    '--trust',
  ];

  if (options.permissionMode === 'yolo') {
    args.push('--force', '--sandbox', 'disabled');
  } else if (options.permissionMode === 'plan') {
    args.push('--mode', 'plan', '--sandbox', 'enabled');
  } else {
    args.push('--sandbox', 'enabled');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  if (options.approveMcps) {
    args.push('--approve-mcps');
  }

  return args;
}

export function buildCursorAgentJsonModeFlagArgs(
  options: BuildCursorAgentFlagArgsOptions,
): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'json',
    '--workspace', options.workspaceDir,
    '--trust',
  ];

  if (options.permissionMode === 'yolo') {
    args.push('--force', '--sandbox', 'disabled');
  } else if (options.permissionMode === 'plan') {
    args.push('--mode', 'plan', '--sandbox', 'enabled');
  } else {
    args.push('--sandbox', 'enabled');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  if (options.approveMcps) {
    args.push('--approve-mcps');
  }

  return args;
}

export function buildCursorAgentTextModeFlagArgs(
  options: Omit<BuildCursorAgentFlagArgsOptions, never>,
): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'text',
    '--workspace', options.workspaceDir,
    '--trust',
  ];

  if (options.permissionMode === 'yolo') {
    args.push('--force', '--sandbox', 'disabled');
  } else if (options.permissionMode === 'plan') {
    args.push('--mode', 'plan', '--sandbox', 'enabled');
  } else {
    args.push('--sandbox', 'enabled');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  return args;
}
