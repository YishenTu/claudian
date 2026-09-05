# Private bootstrap constraints

- This is a private two-client fixture, never a production transfer mechanism.
- Persist the non-restart fence and paired admission/work-session suspension before effects. Do not terminally close the suspended Project; cancellation resumes only exact tokens after durable pre-activation proof.
- If admission resume fails after consuming the session token, retain a replacement pair for recovery. Never reuse the consumed token or auto-start LAN on cancellation.
- Enumerate and fence corrupt/incomplete local transitions before publishing the feature, without waiting for remote recovery. Settled terminal records must not be re-fenced.
- Quiescence is not readiness: outstanding publication/responsibility work still blocks. Members attest independently; the Host cannot attest for another client.
- Capture only operation-owned artifacts after durable intent. No database bytes, credentials, CA material, unpublished files, local-only commits, or private drafts enter uploads.
- Cloud activation may precede local binding. After activation, preserve user work and recover forward; never restore LAN authority. Authenticated snapshot/Git checks still gate terminal binding.
- Retired LAN authority is inert diagnostic state. Directory promotion/retirement requires durable parent synchronization; a phase checkpoint cannot stand in for it.
