# Collab contract constraints

- Preserve the discriminated LAN/Cloud model. Do not fabricate Cloud Host/Manager-generation fields or weaken LAN-only required fields into shared optionals.
- Feature intents carry user choices and stable entity IDs, not caller-supplied roles, membership revisions, authority generations, or actor identities. Application owners derive those facts from authenticated reads. Explicit content/OID expectations for editing, Publish, and Accept remain valid.
- Unsupported Cloud capability never permits a LAN fallback. Core must not adopt transport construction, transfer phases, checkpoint/claim semantics, or server policy.
- Complete presentation detail and bounded Runtime paging are separate contracts. Do not add cursor aliases to the general feature facade or treat incomplete pages as complete cached detail.
- Conflict descriptors are immutable evidence. Per-file resolution choices are not a core state machine; users/agents edit the real Project and Publish validates the result.
