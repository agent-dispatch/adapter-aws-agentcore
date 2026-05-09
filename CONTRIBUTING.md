# Contributing

AgentDispatch packages are developed as separate repositories under the `agent-dispatch` GitHub organization. Keep public contracts in `@agentdispatch/core` provider-neutral and avoid adding cloud-specific fields outside adapter-owned `details` or `providerRefs` objects.

Run these checks before opening a pull request:

```bash
npm test
npm run typecheck
npm run build
```
