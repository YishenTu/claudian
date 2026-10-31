import * as path from 'node:path';

/** The npm `.cmd` shim npm writes for the Pi package's bin; Pi must launch its target through Node. */
export function createPiCommandShim(commandPath: string, targetPath: string): string {
  const relativeTarget = path.relative(path.dirname(commandPath), targetPath)
    .split(path.sep)
    .join('\\');
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeTarget}" %*`,
    '',
  ].join('\r\n');
}
