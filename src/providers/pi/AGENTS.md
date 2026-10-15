# Pi constraints

- Windows npm-family shims and pi.dev managed launchers (`.cmd`/`.ps1`) are installation locators, not command transports. Resolve the package-owned entry and launch through Node with structured arguments; never serialize prompts/session targets through cmd.exe. Unproved entrypoints fail closed.
- Prove initial native state matches the requested resume ID/file before prompts, steering, or extension-dialog responses can carry input. Mismatch cannot replace persisted session identity.
- Pi before 1.0 remains supported. A prompt response without a `disposition` marks a pre-1.0 run, which never sends `agent_settled` and settles on the final non-retrying `agent_end`.
- Session-target changes require a new process. Store-locating inputs (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, which can rename the config dir) invalidate bindings; CLI path, `PATH`, and other process-only inputs restart the runtime and keep bindings, relying on the resume proof.
- Forking creates a new file without altering the source. Recover historical models only on the selected branch; a missing leaf cannot fall back to another branch or promote previous-session locators into live state.
- Metadata probes are independent processes and may receive extension UI requests. Keep native UI routing out of execution DOM code.
- Commands may fall back to the pushed catalog when compatibility shims omit get_commands.
- Session tools use a separate execution-only extension and private extension-UI input channel, never metadata/model probes. Apply the same resume-identity proof to this channel; bind callbacks to the run owning the native tool start and revoke pending calls on tool end, run settlement/cancellation, or process close (Pi does not report dialog aborts).
