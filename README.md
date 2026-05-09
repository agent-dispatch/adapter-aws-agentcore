# @agentdispatch/adapter-aws-agentcore

AWS Bedrock AgentCore adapter for AgentDispatch.

V1 supports:

- `provider: "aws"`
- `capability: "agent-runtime"`
- `task_type: "agent.run"` through `InvokeAgentRuntime`
- `task_type: "command.run"` through `InvokeAgentRuntimeCommand`
- target modes `session` and `runtime`

`session` mode invokes an existing AgentCore runtime ARN. `runtime` mode creates AgentCore runtime resources from a prebuilt ECR image and execution role ARN, then cleans them up by default.
