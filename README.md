# @agent-dispatch/adapter-aws-agentcore

[![npm](https://img.shields.io/npm/v/@agent-dispatch/adapter-aws-agentcore.svg)](https://www.npmjs.com/package/@agent-dispatch/adapter-aws-agentcore)
[![license](https://img.shields.io/npm/l/@agent-dispatch/adapter-aws-agentcore.svg)](https://www.npmjs.com/package/@agent-dispatch/adapter-aws-agentcore)

- `provider: "aws"`
- `capability: "agent-runtime"`
- `taskType: "agent.run"` through `InvokeAgentRuntime`
- `taskType: "command.run"` through `InvokeAgentRuntimeCommand`
- target modes `session` and `runtime`

AWS AgentCore runtime adapter for AgentDispatch. This is the first production adapter: it lets a lead agent call one MCP tool, spawn an AWS-hosted cloud subagent, poll durable status, and continue interaction through returned runtime metadata.

## Supported capabilities

- Provider: `aws`
- Capability: `agent-runtime`
- Task types: `agent.run`, `command.run`
- Target modes:
  - `session` — invoke a configured AgentCore runtime ARN and create/use an isolated runtime session.
  - `runtime` — create an AgentCore runtime from a prebuilt ECR image, run the task, and clean up by default.
- Runtime protocols: `a2a`, `mcp`, `ag-ui`, `http`

## How it maps to AgentCore

AgentDispatch request | AWS AgentCore behavior
--- | ---
`agent.run` | Invokes the runtime with a structured agent instruction payload.
`command.run` | Invokes the runtime with a command payload for worker-style tasks.
`target.mode = "session"` | Uses an existing `runtimeArn` from adapter config or target details.
`target.mode = "runtime"` | Creates runtime resources from `ecrImageUri` and `executionRoleArn`.
`protocol = "a2a"` | Configures runtime protocol hints and maps the first agent message to JSON-RPC `message/send`.
`get_task_logs` | Reads provider-neutral event mappings from AgentCore streaming chunks.

## Configuration

Use standard AWS credentials outside MCP, for example AWS SDK default credentials, SSO, environment variables, or role-based credentials.

```json
{
  "accounts": {
    "dev-aws": {
      "provider": "aws",
      "region": "us-west-2",
      "credentialSource": "aws-sdk-default"
    }
  },
  "adapters": {
    "aws-agentcore": {
      "region": "us-west-2",
      "runtimeArn": "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my-runtime",
      "protocol": "a2a"
    }
  }
}
```

Runtime provisioning mode:

```json
{
  "adapters": {
    "aws-agentcore": {
      "region": "us-west-2",
      "ecrImageUri": "123456789012.dkr.ecr.us-west-2.amazonaws.com/agentdispatch-worker:latest",
      "executionRoleArn": "arn:aws:iam::123456789012:role/AgentDispatchAgentCoreRole",
      "protocol": "a2a"
    }
  }
}
```

## Spawn from MCP

```json
{
  "provider": "aws",
  "account_profile": "dev-aws",
  "capability": "agent-runtime",
  "task_type": "agent.run",
  "target": {
    "mode": "session",
    "protocol": "a2a"
  },
  "input": {
    "instruction": "Review this pull request and produce a risk report.",
    "model": {
      "id": "anthropic.claude-3-5-sonnet-20241022-v2:0"
    },
    "tools": [
      {
        "name": "repo_search",
        "description": "Search indexed repository files."
      }
    ]
  }
}
```

The response includes `cloud_agent` details such as protocol, provider, runtime session ID, runtime ARN, AgentCore invocation URL, A2A Agent Card URL, and the required session header. A lead agent can use that data to continue with A2A where supported by the runtime.

## Continue With A2A

Use `sendAwsAgentCoreA2AMessage` when you want the lead agent or application code to continue the same AgentCore runtime session after `spawn_cloud_agent` returns:

```ts
import { sendAwsAgentCoreA2AMessage } from "@agent-dispatch/adapter-aws-agentcore";

const followUp = await sendAwsAgentCoreA2AMessage(task.cloudAgent!, {
  text: "Continue the investigation and focus on IAM findings."
});

console.log(followUp.text);
```

The helper uses the AWS SDK default credential chain. It reads `agentRuntimeArn`, `runtimeSessionId`, `qualifier`, content type, and accept headers from `cloudAgent.invocation`, sends a JSON-RPC `message/send` payload through `InvokeAgentRuntime`, and returns normalized text plus metadata.

## Worker image

For a ready reference runtime, use `@agent-dispatch/worker-agentcore`. It exposes health, Agent Card discovery, and A2A JSON-RPC `message/send` endpoints suitable for AgentCore runtime experiments.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
