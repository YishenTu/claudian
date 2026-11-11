# Antigravity constraints

## Session creation and recovery

- Authentication is native: never call ACP `authenticate` or store Google credentials. Auth failures point to `agy acp --login`.
- Never fall back from `session/resume` to `session/load`: agy answers load for any id, then fails the next prompt (`trajectory not found`). A missing-session error during restoration keeps the `historySessionId` locator because transcripts outlive the session database. A failed immediate resume after creation keeps the new native id for retry.
- The native store follows HOME (USERPROFILE on Windows); a moved store retires bindings, other launch changes reload them.
- Agent body and tools are frozen at native session creation, including project text after a move. Select and prepare agent files only for `session/new`; existing ids resume without file checks or agent selection. Never send a system-prompt append.
- New custom-agent sessions need immediate same-process `session/resume` with the same MCP servers before prompting. Publish the created id before resume; mark it loaded only after resume succeeds so failures can retry the same id. Auxiliary sessions carry no MCP servers: an empty native tool list does not block MCP tools.
- Claudian owns only marked generated `agent.md` files, not their directories. Refuse foreign or malformed files; file failures must prevent native creation rather than silently use agy's default agent.
- Off because agy's ACP server lacks them: fork, rewind, ephemeral sessions, fast mode.

## Models and discovery

- Each session's config options are authoritative for the model catalog; ACP rejects models it did not advertise. Apply model, `thought_level` and mode with `session/set_config_option` only when they differ, and retire the process when cancellation interrupts that step so the cached values cannot go stale. `thought_level` is reported only for the current model and is absent for fixed-effort models; send none when the session offers none. Per-model levels come only from the legacy `models.availableModels` list in session/new and resume responses.
- Prefer live `available_commands_update` and config options; the prompt-less discovery probe is unlisted but leaves a native session directory.
- Unsupported built-in commands are hidden by name (`ANTIGRAVITY_HIDDEN_COMMANDS`) because agy marks no command as built-in.

## Permissions and tools

- `--dangerously-skip-permissions` overrides every mode until restart, so YOLO auto-allows permission requests client-side. Never select native `plan`; Claudian has no plan mode.
- Subagent tools are excluded (built-in subagents are unavailable under a custom agent, upstream #1225).
- `ask_question` arrives as form `elicitation/create` only when the client advertises elicitation; answer with option `const` values (match them before labels) and free text in `<field>_other`. Its completed update omits the answers, so the question router supplies them to the tool result by tool call id.

## Streaming and history

- agy echoes a prompt that starts a turn and a steer when it injects it, stripping a leading slash-command name; `/compact` and images are not echoed. Steering is confirmed by that echo or by the turn completing.
- Work that finishes after `end_turn` (long background commands, slower subagents, schedules) never streams; it lands only in the transcript.
- A prompt response's usage sums every model call in the turn. The context meter uses the transcript's last `PLANNER_RESPONSE` (`input_tokens + cache_read_tokens`) and reports no context when that is unreadable; never fall back to the sum.
- agy reports compaction only as a transcript `CHECKPOINT`: live, a `/compact` prompt that completes (not a steer that took over) is the boundary. Transcript `SYSTEM_MESSAGE`s from a task sender are notifications; `sender=system` notices are only context.
- Transcripts have no cancellation or steer marker. On replay, trailing unfinished model/tool output carries `isInterrupt` and no completion timing; a final planner reply without tools, a completed checkpoint, or a terminal `permission check failed` result completes it (denial also completes live). `USER_INPUT` may be a steer and task reports may arrive mid-run, so neither boundary proves an interruption. Empty/system-only segments do not prove a stop; a trailing incomplete snapshot cannot distinguish cancellation from another client's running turn. Background launch `RUNNING` status is not a turn outcome.
