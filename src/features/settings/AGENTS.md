# Settings UI constraints

- Keep pending and in-flight text drafts owned by the settings tab across panel disposal and recreation. Reopened controls display the newest draft; a save that fails before commit retains it for retry without overwriting newer edits, and a committed save whose publication fails is never retried.
- For controls that commit immediately, reconcile their values and optimistic projections from the settings owner's committed state after the save settles. A post-commit publication failure must leave the committed value displayed.
