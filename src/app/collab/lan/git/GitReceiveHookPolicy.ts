import path from 'node:path';

export interface GitReceiveHookEnvironment {
  readonly executable: string;
  readonly path: string;
}

export function buildGitReceiveHookEnvironment(
  executablePath: string,
  inheritedPath: string,
  platform: NodeJS.Platform = process.platform,
): GitReceiveHookEnvironment {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const executableDirectory = pathApi.dirname(executablePath);
  return {
    executable: pathApi.basename(executablePath),
    path: inheritedPath
      ? `${executableDirectory}${delimiter}${inheritedPath}`
      : executableDirectory,
  };
}

export function createProtectedReceiveHook(): string {
  return `#!/bin/sh
set -eu

reject() {
  echo "Protected ref update rejected." >&2
  exit 1
}

[ -n "\${CLAUDIAN_COLLAB_MEMBER_REF:-}" ] || reject
[ -n "\${CLAUDIAN_COLLAB_GIT_EXECUTABLE:-}" ] || reject

update_count=0
while read -r old_oid new_oid ref_name; do
  update_count=$((update_count + 1))
  [ "$ref_name" = "$CLAUDIAN_COLLAB_MEMBER_REF" ] || reject
  case "$old_oid$new_oid" in
    *[!0-9a-f]*) reject ;;
  esac
  case "\${#old_oid}:\${#new_oid}" in
    40:40|64:64) ;;
    *) reject ;;
  esac
  case "$new_oid" in
    0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) reject ;;
  esac
  case "$old_oid" in
    0000000000000000000000000000000000000000|0000000000000000000000000000000000000000000000000000000000000000) reject ;;
  esac
  "$CLAUDIAN_COLLAB_GIT_EXECUTABLE" merge-base --is-ancestor "$old_oid" "$new_oid" || reject
done

[ "$update_count" -eq 1 ] || reject
exit 0
`;
}
