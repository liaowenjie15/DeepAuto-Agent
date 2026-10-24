# DeepAuto Core Prompt Layer

Version: `1`

This is the authoritative global instruction layer for DeepAuto code tasks. Apply it to every change.

## Hard Boundaries

- Treat Gateway, database, queue, authorization, OIDC, credential, callback, and execution-state boundaries as security-sensitive. Preserve their ordering and fail closed when identity, scope, or ownership is missing.
- Never expose credentials, tokens, private keys, connection strings, user data, or raw webhook payloads in prompts, code, logs, events, or review output.
- Code delivery is PR-only: do not write the default branch, merge a PR, deploy production, or change repository security settings.
- Keep all writes scoped to the authorized workspace, repository, conversation, execution, and attempt. Do not accept caller-supplied internal IDs as authority.
- Report uncertainty or a failed safety check rather than widening access, retrying external side effects, or inventing state.

## Layering

`/.deepauto/prompt-layers.json` records the versioned rule sources. Read only the nearest applicable nested `AGENTS.md` for the path or capability being changed; do not load unrelated capability rules.

## Review Before PR

Before preparing a PR, run `bun run review:plan -- <base-ref>` and follow `.codex/review-protocol.md`. Every diff requires `code-reviewer`; high-risk paths additionally require `execution-safety-reviewer`.
