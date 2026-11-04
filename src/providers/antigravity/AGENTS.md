# Antigravity constraints

- Authentication is native: never call ACP `authenticate` or store Google credentials. Auth failures point to `agy acp --login`.
- Never fall back from `session/resume` to `session/load`: agy answers load for any id, then fails the next prompt (`trajectory not found`). A missing-session error during restoration keeps the `historySessionId` locator because transcripts outlive the session database. A failed immediate resume after creation keeps the new native id for retry.
- The native store follows HOME (USERPROFILE on Windows); a moved store retires bindings, other launch changes reload them.
- History hydrates from agy's transcript (`transcript_full.jsonl`, else the JSON-encoded, truncated `transcript.jsonl`). Result steps follow their planner step in call order with no tool-call ids; a denial aborts the rest of its batch without result steps.
- Agent body and tools are frozen at native session creation, including project text after a move. Select and prepare agent files only for `session/new`; existing ids resume without file checks or agent selection. Never send a system-prompt append.
- New custom-agent sessions need immediate same-process `session/resume` with the same MCP servers before prompting. Publish the created id before resume; mark it loaded only after resume succeeds so failures can retry the same id. Auxiliary sessions carry no MCP servers: an empty native tool list does not block MCP tools.
- Claudian owns only marked generated `agent.md` files, not their directories. Refuse foreign or malformed files; file failures must prevent native creation rather than silently use agy's default agent.
- Each session's config options are authoritative for the model catalog; ACP rejects models it did not advertise. Apply model, `thought_level` and mode with `session/set_config_option` only when they differ, and retire the process when cancellation interrupts that step so the cached values cannot go stale.
- `--dangerously-skip-permissions` overrides every mode until restart, so YOLO auto-allows permission requests client-side. Never select native `plan`; Claudian has no plan mode.
- Subagent tools are excluded (built-in subagents are unavailable under a custom agent, upstream #1225).
- Off because ACP 1.5.0 lacks them: fork, rewind, ephemeral sessions, fast mode. Work that finishes after `end_turn` (long background commands, slower subagents, schedules) never streams; it lands only in the transcript. `boost`, `browser`, `plan`, `schedule` and `teamwork` are hidden by name because agy marks no command as built-in.
- agy echoes a prompt that starts a turn and a steer when it injects it, stripping a leading slash-command name; `/compact` and images are not echoed. Steering is confirmed by that echo or by the turn completing.
- Prefer live `available_commands_update` and config options; the prompt-less discovery probe is unlisted but leaves a native session directory.
- Live updates for file reads, web search, image generation, `manage_task` and MCP tools carry no output; show none rather than agy's `Tool completed` placeholder. Their transcript steps do carry results.
- `ask_question` arrives as form `elicitation/create` only when the client advertises elicitation; answer with option `const` values (match them before labels) and free text in `<field>_other`.
