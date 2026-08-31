import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

export async function runGitHttpBackendFixture(
  request: IncomingMessage,
  response: ServerResponse,
  repository: { readonly barePath: string; readonly executablePath: string; readonly remoteUser: string },
  suffix: string,
): Promise<void> {
  const gitProtocolHeader = request.headers['git-protocol'];
  const gitProtocol = Array.isArray(gitProtocolHeader)
    ? gitProtocolHeader[0]
    : gitProtocolHeader;
  const child = spawn(repository.executablePath, ['http-backend'], {
    env: {
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_PROJECT_ROOT: path.dirname(repository.barePath),
      HTTP_GIT_PROTOCOL: gitProtocol ?? '',
      PATH_INFO: `/${path.basename(repository.barePath)}${suffix}`,
      PATH: process.env.PATH,
      QUERY_STRING: new URL(request.url ?? '/', 'http://127.0.0.1').search.slice(1),
      REMOTE_ADDR: '127.0.0.1',
      REMOTE_USER: repository.remoteUser,
      REQUEST_METHOD: request.method ?? 'GET',
      SERVER_PROTOCOL: 'HTTP/1.1',
      ...(request.headers['content-length'] === undefined
        ? {}
        : { CONTENT_LENGTH: request.headers['content-length'] }),
      ...(request.headers['content-type'] === undefined
        ? {}
        : { CONTENT_TYPE: request.headers['content-type'] }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.resume();
  request.pipe(child.stdin);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`git-http-backend:${String(code)}`)));
  });
  const output = Buffer.concat(stdout);
  const headerEnd = output.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw new Error('git-http-backend-headers');
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, headerEnd).toString('ascii').split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (name.toLocaleLowerCase('en-US') === 'status') status = Number(value.slice(0, 3));
    else headers[name] = value;
  }
  response.writeHead(status, headers);
  response.end(output.subarray(headerEnd + 4));
}

