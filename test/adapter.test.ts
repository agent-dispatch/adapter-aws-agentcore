import { describe, expect, it } from "vitest";
import { nowIso, type DispatchRequest, type RuntimeTarget, type TaskRecord } from "@agentdispatch/core";
import { AwsAgentCoreAdapter } from "../src/index.js";

class FakeDataClient {
  commands: any[] = [];
  constructor(private readonly agentResponse: Record<string, unknown> | string = {
    ok: true,
    output: "done",
    events: [{ type: "task.progress", message: "worker progress" }],
    artifacts: [{ uri: "s3://bucket/result.json", kind: "json", contentType: "application/json", sizeBytes: 12 }]
  }) {}

  async send(command: any) {
    this.commands.push(command);
    if (command.constructor.name === "InvokeAgentRuntimeCommand") {
      return {
        response: {
          transformToString: async () => typeof this.agentResponse === "string" ? this.agentResponse : JSON.stringify(this.agentResponse)
        }
      };
    }
    if (command.constructor.name === "InvokeAgentRuntimeCommandCommand") {
      return {
        stream: [
          { chunk: { contentStart: {} } },
          { chunk: { contentDelta: { stdout: "hello" } } },
          { chunk: { contentStop: { exitCode: 0, status: "COMPLETED" } } }
        ]
      };
    }
    if (command.constructor.name === "StopRuntimeSessionCommand") {
      return { runtimeSessionId: command.input.runtimeSessionId, statusCode: 200 };
    }
    throw new Error(`Unexpected data command ${command.constructor.name}`);
  }
}

class FakeControlClient {
  commands: any[] = [];
  async send(command: any) {
    this.commands.push(command);
    switch (command.constructor.name) {
      case "CreateAgentRuntimeCommand":
        return {
          agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/generated",
          agentRuntimeId: "generated"
        };
      case "CreateAgentRuntimeEndpointCommand":
        return {
          agentRuntimeEndpointArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/generated/endpoint/endpoint",
          status: "CREATING"
        };
      case "GetAgentRuntimeEndpointCommand":
        return { status: "READY" };
      case "DeleteAgentRuntimeEndpointCommand":
      case "DeleteAgentRuntimeCommand":
        return { status: "DELETING" };
      default:
        throw new Error(`Unexpected control command ${command.constructor.name}`);
    }
  }
}

describe("AwsAgentCoreAdapter", () => {
  it("runs agent tasks in session mode and normalizes worker events and artifacts", async () => {
    const data = new FakeDataClient();
    const adapter = createAdapter(data);
    const request = createRequest("agent.run", "session");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });
    const result = await adapter.startTask({ dispatch: request, task, target, session: provisioned.session });
    const events = [];
    for await (const event of adapter.streamEvents(task.id)) events.push(event);

    expect(data.commands.map((command) => command.constructor.name)).toContain("InvokeAgentRuntimeCommand");
    expect(JSON.parse(Buffer.from(data.commands[0].input.payload).toString("utf8"))).toMatchObject({
      taskType: "agent.run",
      input: { instruction: "run" },
      prompt: "run"
    });
    expect(result.result).toMatchObject({ ok: true, output: "done" });
    expect(result.artifacts?.[0]).toMatchObject({ taskId: task.id, uri: "s3://bucket/result.json", kind: "json" });
    expect(events.some((event) => event.message === "worker progress")).toBe(true);
  });

  it("runs command tasks and maps command stream chunks to events", async () => {
    const data = new FakeDataClient();
    const adapter = createAdapter(data);
    const request = createRequest("command.run", "session", { command: "echo hello" });
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });
    const result = await adapter.startTask({ dispatch: request, task, target, session: provisioned.session });
    const events = [];
    for await (const event of adapter.streamEvents(task.id)) events.push(event);

    expect(result.result).toEqual({ exitCode: 0 });
    expect(data.commands[0].input.accept).toBe("application/vnd.amazon.eventstream");
    expect(events.map((event) => event.type)).toEqual(["session.created", "task.progress", "task.log", "task.progress"]);
    expect(events.some((event) => event.message === "hello")).toBe(true);
  });

  it("maps text/event-stream agent responses into progress and result state", async () => {
    const data = new FakeDataClient([
      "data: {\"ok\":true,\"output\":\"chunk one\"}",
      "",
      "data: {\"ok\":true,\"output\":\"done\",\"events\":[{\"type\":\"task.progress\",\"message\":\"sse progress\"}]}",
      ""
    ].join("\n"));
    const adapter = createAdapter(data);
    const request = createRequest("agent.run", "session");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });
    const result = await adapter.startTask({ dispatch: request, task, target, session: provisioned.session });
    const events = [];
    for await (const event of adapter.streamEvents(task.id)) events.push(event);

    expect(result.result).toMatchObject({ output: "done" });
    expect(events.some((event) => event.message === "sse progress")).toBe(true);
  });

  it("fails agent tasks when the worker returns ok false", async () => {
    const data = new FakeDataClient({
      ok: false,
      error: "worker failed",
      events: [{ type: "task.log", message: "failure details", payload: { stream: "stderr" } }]
    });
    const adapter = createAdapter(data);
    const request = createRequest("agent.run", "session");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });

    await expect(adapter.startTask({ dispatch: request, task, target, session: provisioned.session })).rejects.toThrow("worker failed");
    const events = [];
    for await (const event of adapter.streamEvents(task.id)) events.push(event);
    expect(events.some((event) => event.message === "failure details")).toBe(true);
  });

  it("provisions runtime mode and cleans up runtime resources", async () => {
    const control = new FakeControlClient();
    const adapter = createAdapter(new FakeDataClient(), control);
    const request = createRequest("agent.run", "runtime", {}, { ecrImageUri: "123.dkr.ecr.us-west-2.amazonaws.com/worker:latest", executionRoleArn: "arn:aws:iam::123:role/exec" });
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });
    const cleanup = await adapter.cleanup(target);

    expect(provisioned.runtime?.providerRefs).toMatchObject({ agentRuntimeId: "generated" });
    expect(cleanup.status).toBe("completed");
    expect(control.commands.map((command) => command.constructor.name)).toEqual([
      "CreateAgentRuntimeCommand",
      "CreateAgentRuntimeEndpointCommand",
      "GetAgentRuntimeEndpointCommand",
      "DeleteAgentRuntimeEndpointCommand",
      "DeleteAgentRuntimeCommand"
    ]);
  });

  it("stops AgentCore runtime sessions during cancellation", async () => {
    const data = new FakeDataClient();
    const adapter = createAdapter(data);
    const request = createRequest("agent.run", "session");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    await adapter.provision({ dispatch: request, task, target });

    await expect(adapter.cancel(task.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(data.commands.map((command) => command.constructor.name)).toContain("StopRuntimeSessionCommand");
  });
});

function createAdapter(data = new FakeDataClient(), control = new FakeControlClient()) {
  return new AwsAgentCoreAdapter({
    account: { name: "dev-aws", provider: "aws", credentialSource: "aws-sdk-default" },
    region: "us-west-2",
    runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/example"
  }, { data: data as any, control: control as any });
}

function createRequest(taskType: DispatchRequest["taskType"], mode: RuntimeTarget["mode"], input: Record<string, unknown> = { instruction: "run" }, details?: Record<string, unknown>): DispatchRequest {
  return {
    provider: "aws",
    accountProfile: "dev-aws",
    capability: "agent-runtime",
    taskType,
    target: { mode, details },
    input
  };
}

function createTask(request: DispatchRequest): TaskRecord {
  const timestamp = nowIso();
  return {
    id: "task_test",
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
