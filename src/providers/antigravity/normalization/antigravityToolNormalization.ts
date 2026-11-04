import { SESSION_TOOL_MCP_SERVER_NAME } from '@/core/session-tools/sessionToolMCP';
import {
  isSessionTool,
  TOOL_ASK_USER_QUESTION,
  TOOL_BASH,
  TOOL_BASH_OUTPUT,
  TOOL_EDIT,
  TOOL_GENERATE_IMAGE,
  TOOL_KILL_SHELL,
  TOOL_LIST_MCP_RESOURCES,
  TOOL_MANAGE_TASKS,
  TOOL_READ,
  TOOL_READ_MCP_RESOURCE,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
  TOOL_WRITE_STDIN,
} from '@/core/tools/toolNames';
import type { AskUserAnswers, ToolProviderPayload } from '@/core/types';
import {
  type ACPResolvedToolRawName,
  ACPToolStreamAdapter,
} from '@/providers/acp';

/** Tool names as agy reports them over ACP (its internal names such as `view_file` never appear). */
const ANTIGRAVITY_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  ask_question: TOOL_ASK_USER_QUESTION,
  edit_file: TOOL_EDIT,
  generate_image: TOOL_GENERATE_IMAGE,
  list_resources: TOOL_LIST_MCP_RESOURCES,
  read_file: TOOL_READ,
  read_resource: TOOL_READ_MCP_RESOURCE,
  run_command: TOOL_BASH,
  search_web: TOOL_WEB_SEARCH,
  write_file: TOOL_WRITE,
};

/** `manage_task` covers background commands. */
const MANAGE_TASK_ACTION_MAP: Readonly<Record<string, string>> = {
  kill: TOOL_KILL_SHELL,
  list: TOOL_MANAGE_TASKS,
  send_input: TOOL_WRITE_STDIN,
  status: TOOL_BASH_OUTPUT,
};

/** agy prefixes MCP tools with `mcp_<server>_`; only Claudian's own server name is known. */
const SESSION_TOOL_PREFIX = `mcp_${SESSION_TOOL_MCP_SERVER_NAME}_`;

const COMMAND_OUTPUT_PATTERN = /^Command exited with code (-?\d+)\.\s*(?:Command output:\n?|No output from the command\.\s*$)?([\s\S]*)$/;

export function normalizeAntigravityToolName(rawName: string, rawInput?: unknown): string {
  const name = rawName.trim();
  if (name === 'manage_task' && isRecord(rawInput) && typeof rawInput.Action === 'string'
    && Object.hasOwn(MANAGE_TASK_ACTION_MAP, rawInput.Action)) {
    return MANAGE_TASK_ACTION_MAP[rawInput.Action];
  }
  // MCP servers from the user's agy config dispatch through `call_mcp_tool`; present the tool it calls.
  if (name === 'call_mcp_tool' && isRecord(rawInput)) {
    const server = typeof rawInput.ServerName === 'string' ? rawInput.ServerName.trim() : '';
    const tool = typeof rawInput.ToolName === 'string' ? rawInput.ToolName.trim() : '';
    if (server === SESSION_TOOL_MCP_SERVER_NAME && isSessionTool(tool)) return tool;
    if (server && tool) return `mcp__${server}__${tool}`;
  }
  if (name.startsWith(SESSION_TOOL_PREFIX)) {
    const sessionTool = name.slice(SESSION_TOOL_PREFIX.length);
    if (isSessionTool(sessionTool)) return sessionTool;
  }
  return Object.hasOwn(ANTIGRAVITY_TOOL_NAME_MAP, name) ? ANTIGRAVITY_TOOL_NAME_MAP[name] : (name || 'tool');
}

/** Projects agy's PascalCase arguments onto the shared tool inputs; native keys stay alongside. */
export function normalizeAntigravityToolInput(rawName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (rawName.trim()) {
    case 'read_file':
      return withAliases(input, { file_path: input.Path });
    case 'write_file':
      return withAliases(input, { content: input.Content, file_path: input.Path });
    case 'edit_file':
      return withAliases(input, { file_path: input.Path, new_string: input.Replacement, old_string: input.Target });
    case 'run_command':
      return withAliases(input, { command: input.CommandLine, description: input.toolSummary });
    case 'ask_question':
      return normalizeQuestionInput(input);
    case 'generate_image':
      return withAliases(input, { prompt: input.Prompt });
    case 'call_mcp_tool':
      return isRecord(input.Arguments) ? input.Arguments : input;
    case 'list_resources':
    case 'read_resource':
      return withAliases(input, { server: input.ServerName, uri: input.Uri ?? input.URI });
    case 'manage_task':
      return input.Action === 'send_input' ? withAliases(input, { chars: input.Input, session_id: input.TaskId }) : input;
    default: {
      if (!isSessionTool(normalizeAntigravityToolName(rawName))) return input;
      // agy adds a model-written summary to every MCP call; it is not a tool argument.
      const { toolSummary: _summary, ...args } = input;
      return args;
    }
  }
}

/**
 * agy reports command outcomes as text (`Command exited with code N.`), so a nonzero exit is the
 * failure signal. Results agy never streams (file reads, MCP calls) stay empty instead of showing
 * a generic completion placeholder.
 */
export function normalizeAntigravityToolResult(
  rawName: string,
  content: string,
  rawOutput: unknown,
): { content: string; isError: boolean } {
  if (rawName.trim() === 'run_command') {
    const text = isRecord(rawOutput) && typeof rawOutput.output === 'string' ? rawOutput.output : content;
    const match = text.replace(/\r\n/g, '\n').match(COMMAND_OUTPUT_PATTERN);
    if (match) {
      const exitCode = Number(match[1]);
      const output = match[2].replace(/\n+$/, '');
      const failed = exitCode !== 0;
      return { content: failed ? [`exit: ${exitCode}`, output].filter(Boolean).join('\n') : output, isError: failed };
    }
  }
  const empty = rawOutput === undefined || (isRecord(rawOutput) && Object.keys(rawOutput).length === 0);
  if (empty && (content === 'Tool completed' || content === 'Tool failed')) return { content: '', isError: false };
  return { content, isError: false };
}

export function buildAntigravityToolProviderPayload(
  rawName: string,
  rawInput: unknown,
  rawOutput: unknown,
): ToolProviderPayload {
  return {
    ...(rawInput !== undefined ? { rawInput } : {}),
    rawName,
    ...(rawOutput !== undefined ? { rawOutput } : {}),
  };
}

/** agy sends its tool name in a non-standard `name` field; the ACP title is display text. */
export function withAntigravityToolTitle<T extends { name?: unknown; title?: unknown }>(update: T): T {
  return typeof update.name === 'string' && update.name.trim() ? { ...update, title: update.name.trim() } : update;
}

/** `takeAnswers` returns the answers the user gave to a question tool; agy's result does not report them. */
export function createAntigravityToolStreamAdapter(
  takeAnswers: (toolCallId: string) => AskUserAnswers | undefined = () => undefined,
): ACPToolStreamAdapter {
  return new ACPToolStreamAdapter({
    buildToolProviderPayload: (rawName, rawInput, rawOutput) => buildAntigravityToolProviderPayload(rawName ?? 'tool', rawInput, rawOutput),
    normalizeToolInput: (rawName, input) => normalizeAntigravityToolInput(rawName ?? 'tool', input),
    normalizeToolName: (rawName, rawInput) => normalizeAntigravityToolName(rawName ?? 'tool', rawInput),
    normalizeToolResult: (rawName, content, rawOutput) => normalizeAntigravityToolResult(rawName ?? 'tool', content, rawOutput),
    normalizeToolResultDetails: (_rawName, _input, _rawOutput, toolCallId) => {
      const resolvedAnswers = takeAnswers(toolCallId);
      return resolvedAnswers ? { resolvedAnswers } : undefined;
    },
    resolveRawToolName: (current, update) => resolveAntigravityRawToolName(current, update),
  });
}

function resolveAntigravityRawToolName(
  current: ACPResolvedToolRawName | undefined,
  update: { kind?: string | null; title?: string | null },
): ACPResolvedToolRawName {
  if (current?.provenance === 'title') return current;
  const title = update.title?.trim();
  if (title) return { provenance: 'title', rawName: title };
  if (current) return current;
  const kind = update.kind?.trim();
  return kind ? { provenance: 'kind', rawName: kind } : { provenance: 'fallback', rawName: 'tool' };
}

function normalizeQuestionInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.questions)) return input;
  return {
    ...input,
    questions: input.questions.filter(isRecord).map((question, index) => ({
      header: `Q${index + 1}`,
      multiSelect: question.is_multi_select === true,
      options: Array.isArray(question.options)
        ? question.options.filter((option): option is string => typeof option === 'string')
          .map(label => ({ description: '', label }))
        : [],
      question: typeof question.question === 'string' ? question.question : '',
    })),
  };
}

function withAliases(input: Record<string, unknown>, aliases: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  for (const [key, value] of Object.entries(aliases)) {
    if (next[key] === undefined && value !== undefined) next[key] = value;
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
