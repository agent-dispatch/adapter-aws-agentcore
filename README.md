# @agentdispatch/adapter-aws-agentcore

AWS Bedrock AgentCore adapter for AgentDispatch.

V1 supports:

- `provider: "aws"`
- `capability: "agent-runtime"`
- `task_type: "agent.run"` through `InvokeAgentRuntime`
- `task_type: "command.run"` through `InvokeAgentRuntimeCommand`
- target modes `session` and `runtime`

`session` mode invokes an existing AgentCore runtime ARN. `runtime` mode creates AgentCore runtime resources from a prebuilt ECR image and execution role ARN, then cleans them up by default.

## AgentCore entrypoint payloads

For `agent.run`, the adapter preserves the AgentDispatch envelope:

```json
{
  "taskType": "agent.run",
  "input": {
    "instruction": "Research the market"
  },
  "metadata": {}
}
```

It also adds a top-level `prompt` alias when `input.prompt` or `input.instruction` is present. This keeps AgentDispatch-compatible workers working while also supporting common AgentCore starter-toolkit wrappers whose entrypoint reads `payload.get("prompt")`.

## Artifact contract

AgentDispatch workers can return artifact metadata in either `artifacts` or `artifact_manifest`:

```json
{
  "ok": true,
  "events": [{ "type": "task.progress", "message": "done" }],
  "artifacts": [
    {
      "uri": "s3://bucket/result.json",
      "kind": "json",
      "contentType": "application/json",
      "sizeBytes": 128
    }
  ]
}
```

The adapter normalizes this manifest into `ArtifactRecord` values for the configured AgentDispatch store.

## Live tests

Live AWS tests are opt-in only:

```bash
AGENTDISPATCH_LIVE_AGENTCORE=1 \
AGENTDISPATCH_AWS_REGION=us-west-2 \
AGENTDISPATCH_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:... \
npm test
```

For the manual GitHub Actions workflow, required secrets, IAM permissions, and optional runtime-mode validation, see `docs/live-agentcore.md`.
