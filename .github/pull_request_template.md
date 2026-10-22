## Summary

-

## Validation

-

## Workflow Execution Boundary

Complete this section when the pull request changes `.github/**`:

- [ ] The workflow receives an `execution_id` and obtains only task-bound, short-lived material from the Gateway through GitHub OIDC.
- [ ] The workflow does not read long-lived user, provider, or GitHub Secrets, and it does not connect directly to a database or Redis.
- [ ] The workflow reports outcomes to the Gateway; it does not grant user permissions or make the business task's final state authoritative.
- [ ] The workflow creates only task branches, commits, and pull requests. It does not merge pull requests, deploy production, or alter repository settings.
