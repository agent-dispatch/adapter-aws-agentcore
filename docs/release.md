# Release Workflow

`@agent-dispatch/adapter-aws-agentcore` is published after `@agent-dispatch/core`.

## Prerequisites

- Publish `@agent-dispatch/core` for the target compatibility line.
- Configure npm Trusted Publisher for `agent-dispatch/adapter-aws-agentcore` using workflow `.github/workflows/publish.yml`.
- Confirm the target package version has not already been published.

## Publish

Use the `Publish` GitHub Actions workflow with the target version. The workflow updates `@agent-dispatch/core` to the latest compatible published version, validates typecheck, tests, and build, then publishes through Trusted Publisher.
