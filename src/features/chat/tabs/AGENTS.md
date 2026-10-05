# Tab constraints

- Providers declaring `startsSharedRuntimeOnTabPresence` may start their shared runtime on tab presence without creating a session, thread, or turn. This includes inactive restored shells and blank drafts; it is an exception to startup restrictions, not permission to execute or create native history.
- Optimistic tab presentation must not enter persistence before admission/switch commit. Failed assembly/activation restores the prior committed owner; post-commit observer failure cannot undo membership.
- Close pauses intent admission reversibly until replacement/successor publication succeeds. Keep required runtime state callbacks available during preflight and drain; duplicate close/destroy must not repeat effects.
- Forking captures and revalidates the source binding across every await; never use whichever tab becomes current later.
