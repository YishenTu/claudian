# Lifecycle arbitration constraints

- Ordinary admission/drain is not irreversible lifecycle arbitration. Every transition and recovery re-enters the same per-Project arbiter and consults durable owners before side effects.
- A record with a retained result or unfinished local activation/removal can still be nonterminal. Unknown, corrupt, conflicting, or multiply owned state fails only that Project closed; neither an index nor coordinator-local flags prove settlement.
- Coexistence is limited to exact validated predecessor/successor or responsibility relationships. Existing paired ownership does not authorize an unrelated new mutation. Keep exceptions in the arbiter policy rather than recreating them in each coordinator.
- Lifecycle modules retain their authorization, persistence, and phase policy. The arbiter must not interpret journals or become a generic recovery engine.
- A transition must never await ordinary work that is itself queued for that lifecycle lane. Projection-triggered reconciliation runs outside session-owned refresh promises and revalidates captured generation.
- Shutdown stops admission and recovery workers before stores close. Budget expiry preserves ambiguous journals, not permission to abandon live mutation dependencies.
