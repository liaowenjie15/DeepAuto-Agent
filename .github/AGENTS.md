# DeepAuto Workflow Prompt Layer

Version: `1`

- Workflows execute already-authorized Attempts only; Gateway remains the source of identity, authorization, execution state, and callback acceptance.
- Keep `execution_id` bound to `run-name`, OIDC bootstrap, and callback endpoints. Do not add direct secrets, database/Redis access, user tokens, merge commands, repository-setting changes, or production deployment.
- Workflows may use only short-lived OIDC-derived credentials and must not pass credentials or raw webhook content to Codex prompts.
