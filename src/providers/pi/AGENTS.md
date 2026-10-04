# Pi constraints

- Windows npm-family shims are installation locators, not command transports. Resolve the package-owned entry and launch through Node with structured arguments; never serialize prompts/session targets through cmd.exe. Unproved entrypoints fail closed.
- Prove initial native state matches the requested resume ID/file before prompts, steering, or extension-dialog responses can carry input. Mismatch cannot replace persisted session identity.
- Pi before 1.0 remains supported. A prompt response without a `disposition` marks a pre-1.0 run, which never sends `agent_settled` and settles on the final non-retrying `agent_end`.
- Session-target changes require a new process. Location-affecting environment/CLI changes invalidate bindings.
- Forking creates a new file without altering the source. Recover historical models only on the selected branch; a missing leaf cannot fall back to another branch or promote previous-session locators into live state.
- Metadata probes are independent processes and may receive extension UI requests. Keep native UI routing out of execution DOM code.
- Commands may fall back to the pushed catalog when compatibility shims omit get_commands.
