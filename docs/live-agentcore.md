# Live AWS AgentCore Validation

The `Live AWS AgentCore` workflow is manual and opt-in. It does not run on pull requests or normal pushes.

## Required GitHub Secrets

- `AGENTDISPATCH_AWS_REGION`: AWS region for the test runtime.
- `AGENTDISPATCH_AGENTCORE_RUNTIME_ARN`: existing AgentCore runtime ARN for session-mode tests.
- `AWS_ROLE_ARN`: optional IAM role assumed by GitHub Actions OIDC. If omitted, provide AWS credentials through another GitHub Actions-supported mechanism.

Runtime mode additionally requires:

- `AGENTDISPATCH_AGENTCORE_RUNTIME_ECR_IMAGE_URI`: prebuilt AgentDispatch-compatible AgentCore worker image.
- `AGENTDISPATCH_AGENTCORE_EXECUTION_ROLE_ARN`: AgentCore execution role for created runtimes.

## IAM Permissions

Session mode requires:

- `bedrock-agentcore:InvokeAgentRuntime`
- `bedrock-agentcore:InvokeAgentRuntimeCommand`
- `bedrock-agentcore:StopRuntimeSession`

Runtime mode additionally requires:

- `bedrock-agentcore-control:CreateAgentRuntime`
- `bedrock-agentcore-control:CreateAgentRuntimeEndpoint`
- `bedrock-agentcore-control:GetAgentRuntime`
- `bedrock-agentcore-control:GetAgentRuntimeEndpoint`
- `bedrock-agentcore-control:DeleteAgentRuntimeEndpoint`
- `bedrock-agentcore-control:DeleteAgentRuntime`
- ECR image pull access for the AgentCore execution role
- `iam:PassRole` for the configured AgentCore execution role

## Coverage

The live workflow covers:

- session-mode command execution against an existing runtime
- provider refs for runtime ARN and runtime session ID
- streamed command events and log chunks
- session cancellation through `StopRuntimeSession`
- optional runtime-mode provisioning, invocation, and cleanup when `run_runtime_mode` is `true`

Runtime mode creates cloud resources and deletes them through adapter cleanup. Keep it disabled unless the ECR image and IAM role are intentionally configured for live validation.
