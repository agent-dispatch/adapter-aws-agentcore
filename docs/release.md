# Release Workflow

`@agent-dispatch/adapter-aws-agentcore` is published after `@agent-dispatch/core`.

## Prerequisites

- Publish `@agent-dispatch/core` for the target compatibility line.
- Add an npm automation token as `NPM_TOKEN` in repository secrets.
- Replace bootstrap `file:../agentdispatch-core` development links with the published core version before the first registry release.

## Publish

Use the `Publish` GitHub Actions workflow with the target version. The workflow validates typecheck, tests, and build before publishing with npm provenance.
