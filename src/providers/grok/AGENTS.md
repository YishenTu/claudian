# Grok constraints

- Share ACP primitives, not a generic runtime superclass that absorbs provider policy.
- Authentication is native: never automatically call ACP authenticate or persist xAI credentials. Preserve session identity across prompt/CLI/environment changes by reloading it after process replacement.
- Native fork requests omit system-prompt metadata. Load the child with the complete current replacement before its first prompt; mark configuration applied only after successful load.
- Preserve unknown tool data and native task names/payloads while adapting subagent presentation.
- Plan is a native mode layered over remembered Safe/YOLO; native updates remain authoritative.
- Explicit enabled-model order supersedes discovered default. Chat options reverse persisted order only to compensate for the upward-opening toolbar; settings/default resolution must not reverse it.
- Discover reasoning metadata through actual sessions, never a session created only for discovery. Clear device discovery on environment/CLI fingerprint change while preserving native conversation identifiers.
- Do not rewrite native config, own BYOK endpoints, or source shell startup files.
- Grok discovers user runtime AGENTS.md natively. Claudian must not create, rewrite, suppress, or explicitly inject those files.
- Nonstandard xAI behavior requires sanitized native protocol evidence.
