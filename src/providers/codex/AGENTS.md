# Codex constraints

- Keep the initialization handshake and experimental capability/raw-event opt-ins. Use live notifications, not transcript polling; reintroducing polling requires evidence that equivalent native notifications disappeared.
- Discovery processes must stay independent from chat. Runtime fingerprint changes invalidate native bindings; catalog/command results remain generation-fenced.
- Explicit enabled-model order is durable user preference, including a full-list order. Do not collapse it back to legacy null/native-default ordering.
- Start/resume threads in the current app-server process before targeting operations, including rollback on a fresh fork.
- Notifications can precede turn-start responses. Compact turn identity comes from the started event, not its request response; preserve buffering and binding fences.
- Replay may mix legacy/modern records; modern records take precedence. Compaction replacement history is not visible history; use the durable compacted event marker.
- History files can move to archived roots. Recover models only from valid rollback/fork checkpoints, verifying the source segment before trusting a materialized fork; never make invalidated metadata resumable.
- Temporary image lifetime includes steering, failure, and disposal. Native server-request resolution can dismiss interactions without client input.
- Claude's async task-result interpretation does not apply to Codex. Keep Codex disabled by default.
