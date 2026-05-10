import { describe, expect, it } from "vitest";
import { nowIso, type DispatchRequest, type RuntimeTarget, type TaskRecord } from "@agentdispatch/core";
import { AwsAgentCoreAdapter } from "../src/index.js";

describe("live AWS AgentCore integration", () => {
  it.skipIf(process.env.AGENTDISPATCH_LIVE_AGENTCORE !== "1")("runs command tasks in session mode and exposes refs/events", async () => {
    expect(process.env.AGENTDISPATCH_AWS_REGION).toBeTruthy();
    expect(process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ARN).toBeTruthy();

    const adapter = createLiveAdapter();
    const request = createRequest("command.run", "session", { command: "echo agentdispatch-live" });
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });
    const result = await adapter.startTask({ dispatch: request, task, target, session: provisioned.session });
    const events = [];
    for await (const event of adapter.streamEvents(task.id)) events.push(event);
    const cancellation = await adapter.cancel(task.id);

    expect(provisioned.session?.providerRefs).toMatchObject({
      runtimeArn: process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ARN
    });
    expect(result).toMatchObject({ result: { exitCode: 0 } });
    expect(events.some((event) => event.type === "task.log" && event.message?.includes("agentdispatch-live"))).toBe(true);
    expect(["cancelled", "not_found"]).toContain(cancellation.status);
  });

  it.skipIf(process.env.AGENTDISPATCH_LIVE_AGENTCORE !== "1" || process.env.AGENTDISPATCH_LIVE_AGENTCORE_RUNTIME_MODE !== "true")("provisions, invokes, and cleans up runtime mode", async () => {
    expect(process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ECR_IMAGE_URI).toBeTruthy();
    expect(process.env.AGENTDISPATCH_AGENTCORE_EXECUTION_ROLE_ARN).toBeTruthy();

    const adapter = createLiveAdapter();
    const request = createRequest("agent.run", "runtime", { instruction: "Return a short AgentDispatch live test response." }, {
      ecrImageUri: process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ECR_IMAGE_URI,
      executionRoleArn: process.env.AGENTDISPATCH_AGENTCORE_EXECUTION_ROLE_ARN
    });
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });
    const result = await adapter.startTask({ dispatch: request, task, target, runtime: provisioned.runtime, session: provisioned.session });
    const cleanup = await adapter.cleanup(target);

    expect(provisioned.runtime?.providerRefs).toMatchObject({
      agentRuntimeId: expect.any(String),
      endpointName: expect.any(String)
    });
    expect(result.providerRefs).toMatchObject({ runtimeSessionId: expect.any(String) });
    expect(cleanup.status).toBe("completed");
  });
});

function createLiveAdapter() {
  return new AwsAgentCoreAdapter({
    account: { name: "live-aws", provider: "aws", region: process.env.AGENTDISPATCH_AWS_REGION, credentialSource: "aws-sdk-default" },
    region: process.env.AGENTDISPATCH_AWS_REGION ?? "us-west-2",
    runtimeArn: process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ARN,
    qualifier: process.env.AGENTDISPATCH_AGENTCORE_QUALIFIER ?? "DEFAULT",
    runtimeNamePrefix: "agentdispatch-live",
    deleteRuntimeOnCompletion: true
  });
}

function createRequest(taskType: DispatchRequest["taskType"], mode: RuntimeTarget["mode"], input: Record<string, unknown>, details?: Record<string, unknown>): DispatchRequest {
  return {
    provider: "aws",
    accountProfile: "live-aws",
    capability: "agent-runtime",
    taskType,
    target: { mode, details },
    input
  };
}

function createTask(request: DispatchRequest): TaskRecord {
  const timestamp = nowIso();
  return {
    id: `task_live_${Date.now()}`,
    provider: request.provider,
    accountProfile: request.accountProfile,
    capability: request.capability,
    taskType: request.taskType,
    target: request.target,
    input: request.input,
    backend: "aws-agentcore",
    status: "queued",
    providerRefs: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
