# DeepAuto Two-Layer Review Protocol

Version: `1`

1. Before preparing a PR, run `bun run review:plan -- <base-ref>`; it reports only changed paths and required reviewer roles.
2. Every change receives `code-reviewer`. If the plan names `execution-safety-reviewer`, run it as a separate read-only review of the diff and relevant architecture rules.
3. Report findings as either `blocking` or `non-blocking`. A blocking finding names the affected boundary, a concrete attack or failure path, and a remediation direction.
4. Only a repository maintainer or designated security owner may waive a blocking finding, and the waiver must be written in the PR record.
5. An Agent may repair and repeat the two reviews at most twice. Any remaining blocker requires human handoff; reviewers never approve merges, deployments, or remote operations.
