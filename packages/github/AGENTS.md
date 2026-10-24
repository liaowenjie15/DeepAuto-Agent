# DeepAuto GitHub Prompt Layer

Version: `1`

- Use GitHub App installation tokens restricted to the target repository and the minimum permission set for one operation.
- Verify webhook HMAC before normalization. Ignore receipt-marker comments and configured bot comments to prevent recursive invocation.
- For PR comments, inspect the PR head with read-only permission and reject fork, unavailable, or uninspectable heads before execution.
- Do not dispatch arbitrary workflow runs, accept caller-supplied run IDs, or publish unmarked receipts.
