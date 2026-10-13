import { SESSION_TOOL_ROUTE_HEADER } from '@/core/session-tools/SessionToolEndpoint';
import { SESSION_TOOL_SPECS } from '@/core/session-tools/sessionToolSpecs';

/** OpenCode v2's server plugin API is verified against the installed native runtime. */
export const OPENCODE_SESSION_TOOLS_PLUGIN_SOURCE = `const specs = ${JSON.stringify(SESSION_TOOL_SPECS)};
const routeHeader = ${JSON.stringify(SESSION_TOOL_ROUTE_HEADER)};
` + String.raw`
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
          const response = await fetch(process.env.CLAUDIAN_SESSION_TOOLS_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [routeHeader]: process.env.CLAUDIAN_SESSION_TOOLS_ROUTE_ID,
            },
            body: JSON.stringify({ tool: spec.name, args, callerNativeId: ctx.sessionID }),
            signal: ctx.signal,
          });
          if (!response.ok) throw new Error('Claudian session tools unavailable (' + response.status + ').');
          const result = await response.json();
          if (result.isError) throw new Error(result.text);
          return { output: result.text };
        },
      }));
    }
  },
};
`;
