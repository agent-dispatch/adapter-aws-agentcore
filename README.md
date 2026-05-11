# @agent-dispatch/adapter-aws-agentcore

AWS Bedrock AgentCore adapter for AgentDispatch.

V1 supports:

- `provider: "aws"`
- `capability: "agent-runtime"`
- `taskType: "agent.run"` through `InvokeAgentRuntime`
- `taskType: "command.run"` through `InvokeAgentRuntimeCommand`
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

If a worker returns `{ "ok": false, "error": "..." }`, the adapter maps the invocation to a failed AgentDispatch task while preserving any worker-emitted events. Agent responses can be plain JSON or `text/event-stream` lines with `data: ...` JSON payloads.

`command.run` requests use the AgentCore command execution event stream and set `accept: "application/vnd.amazon.eventstream"` so stdout/stderr chunks are converted into provider-neutral log events.

## Live tests

Live AWS tests are opt-in only:

```bash
AGENTDISPATCH_LIVE_AGENTCORE=1 \
AGENTDISPATCH_AWS_REGION=us-west-2 \
AGENTDISPATCH_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/... \
npm test
```

For the manual GitHub Actions workflow, required secrets, IAM permissions, and optional runtime-mode validation, see `docs/live-agentcore.md`.
