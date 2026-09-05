# Native Git constraints

- Validation reuse is allowed only inside a callback-bounded read session without mutation APIs. Expired sessions cannot authorize writes or credential exposure; those require fresh validation.
- Review may reuse already-fetched refs only after exact-origin validation proves they satisfy fresh authoritative OIDs. Admission, request ensure, Accept, and recovery still require complete reachable-tree validation.
- Origin repair is limited to generated same-Project LAN bindings or an exact journaled Cloud relocation. Never derive a Cloud Server URL from a Git URL origin.
- The CA file is reusable public trust material, not a cached authorization decision. Revalidate membership, origin, control reachability, and its contents before exposing runtime credentials; never persist credentials in helpers.
