# Composition constraints

- Collab wiring here implements the Collab enablement rules in `src/app/AGENTS.md`; read that section before changing enablement, startup, restore, or shutdown order.
- Reach the Collab application layer and Agent Runtime only through dynamic imports. Static imports here join main's eager graph, which must not reach `src/app/collab`.
