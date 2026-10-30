import { SESSION_TOOL_ROUTE_HEADER } from '@/core/session-tools/SessionToolEndpoint';
import { SESSION_TOOL_SPECS } from '@/core/session-tools/sessionToolSpecs';

/** OpenCode v2's server plugin API is verified against the installed native runtime. */
export const OPENCODE_SESSION_TOOLS_PLUGIN_SOURCE = `const specs = ${JSON.stringify(SESSION_TOOL_SPECS)};
const routeHeader = ${JSON.stringify(SESSION_TOOL_ROUTE_HEADER)};
` + String.raw`
import { spawn } from 'node:child_process';

function callRelay(descriptor, payload, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(descriptor.command, descriptor.args, { env: { ...process.env, ...descriptor.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      child.stdin.end();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error('Claudian session tool cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error('Claudian session tool relay could not start.')));
    child.stdin.on('error', () => finish(new Error('Claudian session tool relay input closed.')));
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end < 0) return;
      try { finish(undefined, JSON.parse(output.slice(0, end))); }
      catch { finish(new Error('Invalid Claudian session tool relay response.')); }
    });
    child.on('close', () => finish(new Error('Claudian session tool relay closed without a response.')));
    // EOF cancels the Windows request, so keep stdin open until the response.
    child.stdin.write(JSON.stringify(payload) + '\n');
    if (signal?.aborted) abort();
  });
}

export default {
  id: 'claudian-session-tools',
  async setup(ctx) {
    for (const spec of specs) {
      await ctx.tool.transform(d => d.add({
        name: spec.name,
        description: spec.description,
        input: spec.inputSchema,
        output: {},
        options: { codemode: false },
        async execute(args, ctx) {
          const payload = { tool: spec.name, args, callerNativeId: ctx.sessionID };
          let result;
          if (process.env.CLAUDIAN_SESSION_TOOLS_RELAY) {
            result = await callRelay(JSON.parse(process.env.CLAUDIAN_SESSION_TOOLS_RELAY), payload, ctx.signal);
          } else {
          const response = await fetch(process.env.CLAUDIAN_SESSION_TOOLS_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [routeHeader]: process.env.CLAUDIAN_SESSION_TOOLS_ROUTE_ID,
            },
            body: JSON.stringify(payload),
            signal: ctx.signal,
          });
          if (!response.ok) throw new Error('Claudian session tools unavailable (' + response.status + ').');
          result = await response.json();
          }
          if (result.isError) throw new Error(result.text);
          return { output: result.text };
        },
      }));
    }
  },
};
`;
