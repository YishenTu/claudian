# Tab constraints

- Providers declaring `startsSharedRuntimeOnTabPresence` may start their shared runtime on tab presence without creating a session, thread, or turn. This includes inactive restored tabs and blank drafts; it is an exception to startup restrictions, not permission to execute or create native history.
- Optimistic tab presentation must not enter persistence before admission/switch commit. Failed assembly/activation restores the prior committed owner; post-commit observer failure cannot undo membership.
- Close claims presentation membership reversibly until successor publication succeeds; it never pauses session admission. Rebind preserves tab order, label and composer drafts (a wide preview instead parks the old session's text in `ParkedDrafts`), and releases the old attachment only after the replacement commits. Duplicate close/destroy must not repeat effects.
- Forking captures and revalidates the session source binding across every await; destination publication also validates its original tab request.
