# Codex constraints

- Keep the initialization handshake and experimental capability/raw-event opt-ins. Use live notifications, not transcript polling; reintroducing polling requires evidence that equivalent native notifications disappeared.
- Runtime fingerprint changes preserve thread bindings, which resume on the replacement server; stale catalog/command generations must not publish results.
- The app-server is provider-owned and shared. Caller/session cancellation never shuts it down. Fingerprint changes send new work to a new server while the old server drains; disable/unload cancels and shuts down all generations. Idle session release unsubscribes its thread, not the server.
- Await one startup plugin reconciliation before thread execution or skill listing. Reconciliation failure warns and allows work to continue; model/history reads need only initialization. Unsubscribe alone does not cancel a turn, and resume on a subscribed loaded thread can ignore instruction overrides.
- Unsubscribe removes turn/item delivery, but thread status and closed notifications remain broadcast. Keep native cleanup ownership for late activity until closure or safe reattachment; detaching a chat must not retain its UI. Cleanup reads use metadata (`includeTurns: false`) because ephemeral threads reject history reads.
- Start/resume threads in the current app-server process before targeting operations, including rollback on a fresh fork.
- Notifications can precede turn-start responses. Compact turn identity comes from the started event, not its request response; preserve buffering and binding fences.
- Compaction replacement history is not visible history; render only the boundary and deduplicate its record/event representations.
- History files can move to archived roots. Recover models only from valid rollback/fork checkpoints, verifying the source segment before trusting a materialized fork; never make invalidated metadata resumable.
- Temporary image lifetime includes steering, failure, and disposal. Native server-request resolution can dismiss interactions without client input.
