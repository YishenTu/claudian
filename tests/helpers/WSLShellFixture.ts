import { execFileSync } from 'node:child_process';

/** Startup files used by local shells and the real WSL distro tests. */
export function wslShellFixtureFiles(behavior: WSLShellBehavior = 'ordinary'): Record<string, string> {
  const posix = `cd /tmp
export OPENAI_API_KEY=linux-shell-key
export CODEX_HOME="$CLAUDIAN_WSL_TEST_HOME/codex-home"
export STARSHIP_SESSION_KEY=$$
printf 'rc noise without a newline'
printf '%s' "$CLAUDIAN_WSL_TEST_NOISE"
`;
  const path = 'export PATH="$CLAUDIAN_WSL_TEST_HOME/bin:/usr/bin:/bin"\n';
  // BSD csh rejects a single expanded word this large; emit the bytes via sh.
  const csh = `cd /tmp
setenv OPENAI_API_KEY linux-shell-key
setenv CODEX_HOME "$CLAUDIAN_WSL_TEST_HOME/codex-home"
setenv STARSHIP_SESSION_KEY $$
setenv PATH "$CLAUDIAN_WSL_TEST_HOME/bin:/usr/bin:/bin"
/usr/bin/printf 'rc noise without a newline'
/bin/sh -c 'printf "%s" "$CLAUDIAN_WSL_TEST_NOISE"'
`;
  const startup = wslShellStartupBehavior(behavior);
  return {
    '.bash_profile': '. "$HOME/.bashrc"\n',
    '.bashrc': posix + path + startup,
    '.zshenv': posix,
    '.zshrc': path + startup,
    '.cshrc': csh + startup,
    '.tcshrc': csh + startup,
    'config/fish/config.fish': `cd /tmp
set -gx OPENAI_API_KEY linux-shell-key
set -gx CODEX_HOME "$CLAUDIAN_WSL_TEST_HOME/codex-home"
set -gx STARSHIP_SESSION_KEY $fish_pid
set -gx PATH "$CLAUDIAN_WSL_TEST_HOME/bin" /usr/bin /bin
printf 'rc noise without a newline'
printf '%s' "$CLAUDIAN_WSL_TEST_NOISE"
` + startup,
    'bin/node': '#!/bin/sh\nexec /bin/sh "$@"\n',
    'bin/test-cli': `#!/usr/bin/env node
if [ "$1" = '--version' ]; then printf 'test-cli 1.2.3\\n'; exit; fi
if [ "$1" = '--cwd' ]; then printf '%s' "$PWD"; exit; fi
if [ "$1" = '--exports' ]; then printf '%s\\0' "$OPENAI_API_KEY" "$CODEX_HOME" "$STARSHIP_SESSION_KEY"; exit; fi
printf '%s\\0' "$@"
`,
  };
}

export const WSL_LITERAL_ARGS = ['=sh', '~', '*', '$x', 'a\\b\\', 'double\\\\slash', 'space and trailing\\\\', "a'quote", 'a"quote', 'line1\nline2', ''];

export type WSLShellBehavior = 'ordinary' | 'read' | 'replace' | 'background' | 'fail' | 'temp-file';

function wslShellStartupBehavior(behavior: WSLShellBehavior): string {
  switch (behavior) {
    case 'read': return "/bin/sh -c 'read ignored'\n";
    case 'replace': return 'exec /bin/zsh -f\n';
    case 'background': return "/bin/sh -c 'sleep 0.1; printf delayed-rc-noise' &\n";
    case 'fail': return 'exec /usr/bin/false\n';
    case 'temp-file': return `/bin/sh -c 'printf "%s" "$CLAUDIAN_WSL_ENV_FILE" > "$HOME/capture-path"; /bin/ls -l "$CLAUDIAN_WSL_ENV_FILE" > "$HOME/capture-mode"'\n`;
    default: return '';
  }
}

/** Optional local interpreters; the Windows contract suite uses its provisioned distro instead. */
export function localWSLExecutable(name: string): string {
  if (process.platform === 'win32') return '';
  try { return execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'fixture', name], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
