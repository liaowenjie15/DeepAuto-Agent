# DeepAuto Gateway Prompt Layer

Version: `1`

- Verify webhook signatures before parsing payloads. Authorize the normalized Invocation before queueing work or querying protected provider metadata.
- Preserve repository allowlists, member mapping, workspace and conversation scoping, and idempotency keys.
- Publish a GitHub comment only for an authorized, controlled command; receipts must carry the DeepAuto receipt marker and must not disclose internal IDs or rejection details.
- Treat callback replay, OIDC claim failure, PR fork inspection failure, and missing ownership as deny conditions.
