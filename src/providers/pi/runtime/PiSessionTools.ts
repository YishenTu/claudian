import { SESSION_TOOL_SPECS } from '@/core/session-tools/sessionToolSpecs';

export const PI_SESSION_TOOLS_TITLE = 'claudian-session-tools';

/** Pi 1.1 accepts plain JSON Schema; keep the embedded extension dependency-free. */
export const PI_SESSION_TOOLS_EXTENSION_SOURCE = `
export default function (pi) {
  for (const spec of ${JSON.stringify(SESSION_TOOL_SPECS)}) {
    pi.registerTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      async execute(toolCallId, args, signal, onUpdate, ctx) {
        const value = await ctx.ui.input('${PI_SESSION_TOOLS_TITLE}', JSON.stringify({
          toolCallId, name: spec.name, args,
        }), { signal });
        const result = value === undefined
          ? { isError: true, text: 'The session tool call was cancelled.' }
          : JSON.parse(value);
        return { content: [{ type: 'text', text: result.text }], isError: result.isError, details: {} };
      },
    });
  }
}
`;
