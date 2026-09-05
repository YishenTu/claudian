# Membership intent constraints

- Cloud user mutations retain their frozen request/key and result across close, restart, response loss, and completed rejection. Explicit completion alone releases the result; resume replays it without rediscovering a revoked/removed target.
- Automatic responsibility acknowledgement/decline has a separate durable receipt and must not wait for the user-mutation slot or a manual confirmation.
- An ACK rejection settles only from exact authoritative offer/recovery evidence. An offered operation retains submitted intent; missing/inaccessible state does not prove settlement.
- Lifecycle-held authorization reads use direct authority snapshots, not projection refresh that can re-enter arbitration. Ordinary projection alone publishes cache/role/cursor before receipt reconciliation.
