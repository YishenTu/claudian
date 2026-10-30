import { inferWSLDistroFromWindowsPath } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget, TargetLaunchSpec } from '@/core/process/execution-target/types';
import { forwardWSLEnvironment, type WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';
import { getWSLExecutable } from '@/core/process/execution-target/WSLExecutable';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

export interface BuildTargetLaunchSpecOptions {
  target: ExecutionTarget;
  command: string;
  args: readonly string[];
  hostCwd: string;
  env: Record<string, string>;
  forwardEnvironment?: readonly WSLForwardedVariable[];
}

// Capture startup exports in a separate process so rc files cannot consume or
// write protocol streams. Only validated variable names enter eval; values stay data.
const WSL_OUTER_SCRIPT = `# The outer shell retains protocol stdio and positional arguments.
if [ "\${CLAUDIAN_WSL_HOME+x}" = x ]; then
  export HOME=$CLAUDIAN_WSL_HOME
  unset CLAUDIAN_WSL_HOME
fi
claudian_cwd=$PWD
claudian_count=0
claudian_umask=$(umask)
claudian_entries=\${WSLENV:-}
while [ -n "$claudian_entries" ]; do
  claudian_entry=\${claudian_entries%%:*}
  case "$claudian_entries" in *:*) claudian_entries=\${claudian_entries#*:};; *) claudian_entries=;; esac
  case "$claudian_entry" in */*w*) continue;; esac
  claudian_key=\${claudian_entry%%/*}
  case "$claudian_key" in ''|[0-9]*|*[!a-zA-Z0-9_]*) continue;; esac
  eval 'claudian_present=\${'"$claudian_key"'+x}'
  [ "$claudian_present" = x ] || continue
  eval 'claudian_value_'"$claudian_count"'=\${'"$claudian_key"'}'
  eval 'claudian_key_'"$claudian_count"'=$claudian_key'
  claudian_count=$((claudian_count + 1))
done
if [ -n "\${SHELL:-}" ]; then
  umask 077
  CLAUDIAN_WSL_ENV_FILE=$(/usr/bin/mktemp /tmp/claudian-env-XXXXXX 2>/dev/null)
  export CLAUDIAN_WSL_ENV_FILE
  claudian_capture_pid=
  claudian_watchdog_pid=
  claudian_setsid=$(command -v setsid)
  claudian_start_capture() {
    if [ -n "$claudian_setsid" ]; then exec "$claudian_setsid" "$@"; fi
    exec "$@"
  }
  claudian_stop_capture() {
    [ -n "$claudian_capture_pid" ] || return 0
    if [ -n "$claudian_setsid" ]; then
      kill -TERM "-$claudian_capture_pid" 2>/dev/null
      if kill -0 "-$claudian_capture_pid" 2>/dev/null; then
        /bin/sleep 0.1
        kill -KILL "-$claudian_capture_pid" 2>/dev/null
      fi
    else
      # Interactive startup shells may ignore TERM.
      kill -KILL "$claudian_capture_pid" 2>/dev/null
    fi
  }
  claudian_stop_watchdog() {
    if [ -n "$claudian_watchdog_pid" ]; then
      kill -TERM "$claudian_watchdog_pid" 2>/dev/null
      wait "$claudian_watchdog_pid" 2>/dev/null
      claudian_watchdog_pid=
    fi
  }
  claudian_cleanup() {
    claudian_stop_watchdog
    claudian_stop_capture
    if [ -n "$claudian_capture_pid" ]; then
      wait "$claudian_capture_pid" 2>/dev/null
      claudian_capture_pid=
    fi
    /bin/rm -f "$CLAUDIAN_WSL_ENV_FILE"
  }
  trap claudian_cleanup 0
  trap 'exit 129' 1
  trap 'exit 130' 2
  trap 'exit 143' 15
  trap claudian_stop_capture USR1
  claudian_capture="exec /bin/sh -c 'export -p > \\"\\$CLAUDIAN_WSL_ENV_FILE\\"'"
  claudian_captured=
  if [ -n "$CLAUDIAN_WSL_ENV_FILE" ]; then
    case "\${SHELL##*/}" in
      csh|tcsh) claudian_start_capture "$SHELL" -c "$claudian_capture" </dev/null >/dev/null 2>&1 &;;
      *) claudian_start_capture "$SHELL" -l -i -c "$claudian_capture" </dev/null >/dev/null 2>&1 &;;
    esac
    claudian_capture_pid=$!
    (
      claudian_timer_pid=
      trap '[ -z "$claudian_timer_pid" ] || { kill -KILL "$claudian_timer_pid" 2>/dev/null; wait "$claudian_timer_pid" 2>/dev/null; }' 0
      trap 'exit' 1 2 15
      /bin/sleep 10 &
      claudian_timer_pid=$!
      wait "$claudian_timer_pid"
      claudian_timer_pid=
      # Interrupt the owner's wait so a deadline always takes the fallback.
      kill -USR1 "$$"
    ) </dev/null >/dev/null 2>&1 &
    claudian_watchdog_pid=$!
    wait "$claudian_capture_pid" 2>/dev/null && claudian_captured=yes
    claudian_stop_watchdog
    # Stop remaining group members even if the capture shell has already exited.
    if [ -n "$claudian_setsid" ]; then claudian_stop_capture; fi
    wait "$claudian_capture_pid" 2>/dev/null
    claudian_capture_pid=
  fi
  if [ "$claudian_captured" = yes ] && [ -s "$CLAUDIAN_WSL_ENV_FILE" ] &&
      (. "$CLAUDIAN_WSL_ENV_FILE") >/dev/null 2>&1; then
    . "$CLAUDIAN_WSL_ENV_FILE"
  else
    printf '%s\\n' 'Unable to capture WSL shell environment; using the base environment.' >&2
  fi
  claudian_cleanup
  trap - 0 1 2 15 USR1
  unset -f claudian_cleanup claudian_start_capture claudian_stop_capture claudian_stop_watchdog
fi
claudian_i=0
while [ "$claudian_i" -lt "$claudian_count" ]; do
  eval 'claudian_key=\${claudian_key_'"$claudian_i"'}'
  eval 'claudian_value=\${claudian_value_'"$claudian_i"'}'
  export "$claudian_key=$claudian_value"
  unset "claudian_key_$claudian_i" "claudian_value_$claudian_i"
  claudian_i=$((claudian_i + 1))
done
cd "$claudian_cwd" || exit 1
claudian_command=$1
shift
case "$claudian_command" in '~/'*) claudian_command=$HOME/\${claudian_command#??};; esac
umask "$claudian_umask"
unset CLAUDIAN_WSL_ENV_FILE claudian_setsid claudian_capture_pid claudian_watchdog_pid claudian_cwd claudian_count claudian_entries claudian_entry claudian_key claudian_present claudian_umask claudian_capture claudian_captured claudian_i claudian_value
exec "$claudian_command" "$@"
`;

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}

export function buildTargetLaunchSpec(options: BuildTargetLaunchSpecOptions): TargetLaunchSpec {
  const { target } = options;
  const pathMapper = createExecutionPathMapper(target);
  const spawnCwd = options.hostCwd;

  const workspaceDistro = inferWSLDistroFromWindowsPath(options.hostCwd);
  if (
    target.method === 'wsl'
    && target.distroName
    && workspaceDistro
    && target.distroName.toLowerCase() !== workspaceDistro.toLowerCase()
  ) {
    throw new Error(
      `WSL distro override "${target.distroName}" does not match workspace distro "${workspaceDistro}"`,
    );
  }

  if (target.method === 'wsl' && !target.distroName) {
    throw new Error(
      'Unable to determine the WSL distro. Set WSL distro override or configure a default WSL distro.',
    );
  }

  const targetCwd = pathMapper.toTargetPath(spawnCwd);

  if (!targetCwd) {
    throw new Error('WSL mode only supports Windows drive paths and \\\\wsl$ or \\\\wsl.localhost workspace paths');
  }

  return {
    target,
    command: target.method === 'wsl' ? getWSLExecutable() : options.command,
    // WSL --exec uses CommandLineToArgvW on the remaining command line.
    // Windows limits the entire command line to 32,767 characters; large prompts
    // must use a provider-owned file or stdin transport rather than argv.
    // A fixed argv[0] avoids its special executable-name parsing; all caller
    // command/argument values reach the constant POSIX script as positional data.
    args: target.method === 'wsl'
      ? ['--distribution', target.distroName!, '--cd', targetCwd, '--exec',
          '/bin/sh', '-c', WSL_OUTER_SCRIPT, 'claudian', options.command, ...options.args].map(quoteWindowsArgument)
      : [...options.args],
    ...(target.method === 'wsl' ? { windowsVerbatimArguments: true } : {}),
    spawnCwd,
    targetCwd,
    env: target.method === 'wsl'
      ? forwardWSLEnvironment(options.env, options.forwardEnvironment ?? [])
      : options.env,
    pathMapper,
  };
}
