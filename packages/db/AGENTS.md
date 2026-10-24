# DeepAuto Database Prompt Layer

Version: `1`

- Every read and write must remain scoped by the authorized workspace and relevant provider identity.
- Use transactions and uniqueness constraints for idempotency, cancellation intent, and execution state transitions; do not replace them with in-memory checks.
- Store audit facts required for accountability, but never persist credentials, raw webhook bodies, or unnecessary user content.
