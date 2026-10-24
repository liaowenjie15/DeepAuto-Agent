# DeepAuto Runner Manager Prompt Layer

Version: `1`

- Dispatch and control only DeepAuto-managed runs identified by the exact execution-derived run name.
- Model cancellation as requested/cancelling until a verified terminal status is observed; do not claim completion from an accepted API request.
- Keep executor APIs independent of Gateway authorization and database policy; they operate only on trusted execution inputs.
