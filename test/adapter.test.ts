import { describe, expect, it } from "vitest";
import { nowIso, type DispatchRequest, type RuntimeTarget, type TaskRecord } from "@agent-dispatch/core";
import { AwsAgentCoreAdapter, checkAwsAgentCoreLivePreflight, sendAwsAgentCoreA2AMessage } from "../src/index.js";

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
          agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/00000000-0000-0000-0000-000000000000:1",
          agentRuntimeId: "generated",
          agentRuntimeVersion: "1"
        };
      case "GetAgentRuntimeCommand":
        return { status: "READY" };
      case "ListAgentRuntimesCommand":
        return { agentRuntimes: [] };
      case "CreateAgentRuntimeEndpointCommand":
        return {
          agentRuntimeEndpointArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/00000000-0000-0000-0000-000000000000/endpoint/endpoint",
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

  it("prepares A2A AgentCore connection details for lead agents", async () => {
    const adapter = createAdapter();
    const request = createRequest("agent.run", "session", {
      instruction: "delegate",
      framework: "openclaw",
      model: "claude-sonnet",
      runtime_tools: { enabled: ["repo-search"] }
    }, undefined, "a2a");
    const task = createTask(request);
    const prepared = await adapter.prepareTask({ dispatch: request, task });
    const provisioned = await adapter.provision({
      dispatch: request,
      task,
      target: (await adapter.resolveTarget(request)).target
    });

    expect(prepared.cloudAgent).toMatchObject({
      protocol: "a2a",
      provider: "aws",
      backend: "aws-agentcore",
      accountProfile: "dev-aws",
      sessionId: expect.stringMatching(/^ad-[a-f0-9]{32}$/),
      invocation: {
        type: "aws.agentcore.invoke_agent_runtime",
        agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/00000000-0000-0000-0000-000000000000:1",
        runtimeUrl: "https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aagent%2F00000000-0000-0000-0000-000000000000%3A1/invocations/",
        sessionHeaderName: "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id",
        payloadFormat: "a2a.jsonrpc.message-send"
      },
      framework: "openclaw",
      model: "claude-sonnet",
      tools: { enabled: ["repo-search"] },
      a2a: {
        transport: "json-rpc-2.0-http",
        messageMethod: "message/send",
        agentCardOperation: "GetAgentCard",
        endpointUrl: "https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aagent%2F00000000-0000-0000-0000-000000000000%3A1/invocations/",
        agentCardUrl: "https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aagent%2F00000000-0000-0000-0000-000000000000%3A1/invocations/.well-known/agent-card.json"
      }
    });
    expect(provisioned.session?.providerRefs.runtimeSessionId).toBe(prepared.cloudAgent?.sessionId);
  });

  it("uses target.details.runtimeArn for session-mode clarification retries", async () => {
    const runtimeArn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:agent/11111111-1111-1111-1111-111111111111:1";
    const adapter = new AwsAgentCoreAdapter({
      account: { name: "dev-aws", provider: "aws", credentialSource: "aws-sdk-default" },
      region: "us-east-1"
    }, { data: new FakeDataClient() as any, control: new FakeControlClient() as any });
    const request = createRequest("agent.run", "session", { instruction: "delegate" }, { runtimeArn }, "a2a");
    const task = createTask(request);

    const target = (await adapter.resolveTarget(request)).target;
    const prepared = await adapter.prepareTask({ dispatch: request, task });
    const provisioned = await adapter.provision({ dispatch: request, task, target });

    expect(target.providerRefs?.runtimeArn).toBe(runtimeArn);
    expect(prepared.cloudAgent?.invocation?.agentRuntimeArn).toBe(runtimeArn);
    expect(provisioned.session?.providerRefs.runtimeArn).toBe(runtimeArn);
  });

  it("sends A2A message/send payloads when target protocol is a2a", async () => {
    const data = new FakeDataClient();
    const adapter = createAdapter(data);
    const request = createRequest("agent.run", "session", { instruction: "research this" }, undefined, "a2a");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });
    await adapter.startTask({ dispatch: request, task, target, session: provisioned.session });
    const payload = JSON.parse(Buffer.from(data.commands[0].input.payload).toString("utf8"));

    expect(payload).toMatchObject({
      jsonrpc: "2.0",
      id: task.id,
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "research this" }],
          messageId: task.id
        }
      }
    });
  });

  it("sends follow-up A2A messages from returned cloud-agent metadata", async () => {
    const data = new FakeDataClient({
      jsonrpc: "2.0",
      id: "req-1",
      result: {
        kind: "message",
        role: "agent",
        parts: [{ kind: "text", text: "follow-up done" }],
        metadata: { ok: true }
      }
    });
    const adapter = createAdapter(data);
    const request = createRequest("agent.run", "session", {
      instruction: "delegate",
      framework: "openclaw",
      model: "claude-sonnet",
      runtime_tools: { enabled: ["repo-search"] }
    }, undefined, "a2a");
    const task = createTask(request);
    const prepared = await adapter.prepareTask({ dispatch: request, task });

    const result = await sendAwsAgentCoreA2AMessage(prepared.cloudAgent!, {
      id: "req-1",
      messageId: "msg-1",
      text: "continue",
      metadata: { priority: "background" }
    }, { client: data as any });

    const command = data.commands.at(-1);
    const payload = JSON.parse(Buffer.from(command.input.payload).toString("utf8"));
    expect(command.constructor.name).toBe("InvokeAgentRuntimeCommand");
    expect(command.input).toMatchObject({
      agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/00000000-0000-0000-0000-000000000000:1",
      runtimeSessionId: prepared.cloudAgent?.sessionId,
      qualifier: "DEFAULT",
      contentType: "application/json",
      accept: "application/json"
    });
    expect(payload).toMatchObject({
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        metadata: {
          framework: "openclaw",
          model: "claude-sonnet",
          runtime_tools: { enabled: ["repo-search"] },
          priority: "background"
        },
        message: {
          role: "user",
          parts: [{ kind: "text", text: "continue" }],
          messageId: "msg-1"
        }
      }
    });
    expect(result).toMatchObject({ text: "follow-up done", metadata: { ok: true } });
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
    const data = new FakeDataClient();
    const adapter = createAdapter(data, control);
    const request = createRequest("agent.run", "runtime", {}, { ecrImageUri: "123.dkr.ecr.us-west-2.amazonaws.com/worker:latest", executionRoleArn: "arn:aws:iam::123:role/exec", cleanupAfterTask: true }, "a2a");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });
    await adapter.startTask({ dispatch: request, task, target, runtime: provisioned.runtime, session: provisioned.session });
    const cleanup = await adapter.cleanup(target);

    expect(provisioned.runtime?.providerRefs).toMatchObject({ agentRuntimeId: "generated" });
    expect(data.commands.find((command) => command.constructor.name === "InvokeAgentRuntimeCommand").input.qualifier).toBe(provisioned.session?.providerRefs.endpointName);
    expect(cleanup.status).toBe("completed");
    expect(control.commands.map((command) => command.constructor.name)).toEqual([
      "CreateAgentRuntimeCommand",
      "GetAgentRuntimeCommand",
      "CreateAgentRuntimeEndpointCommand",
      "GetAgentRuntimeEndpointCommand",
      "DeleteAgentRuntimeEndpointCommand",
      "DeleteAgentRuntimeCommand"
    ]);
    expect(control.commands.find((command) => command.constructor.name === "CreateAgentRuntimeCommand").input.agentRuntimeName).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(control.commands.find((command) => command.constructor.name === "CreateAgentRuntimeEndpointCommand").input).toMatchObject({
      name: expect.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/),
      agentRuntimeVersion: "1"
    });
    expect(control.commands.find((command) => command.constructor.name === "CreateAgentRuntimeCommand").input.protocolConfiguration).toEqual({
      serverProtocol: "A2A"
    });
    expect(control.commands.find((command) => command.constructor.name === "CreateAgentRuntimeCommand").input.environmentVariables).toMatchObject({
      AGENTDISPATCH_WORKER_PROTOCOL: "a2a"
    });
  });

  it("passes string runtime environment variables into AgentCore runtime mode", async () => {
    const control = new FakeControlClient();
    const adapter = createAdapter(new FakeDataClient(), control);
    const request = createRequest("agent.run", "runtime", {}, {
      ecrImageUri: "123.dkr.ecr.us-west-2.amazonaws.com/worker:latest",
      executionRoleArn: "arn:aws:iam::123:role/exec",
      environmentVariables: {
        AGENTDISPATCH_WORKER_PROTOCOL: "http",
        AGENTDISPATCH_AGENT_NAME: "Custom Agent"
      }
    }, "a2a");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);

    await adapter.provision({ dispatch: request, task, target });

    expect(control.commands.find((command) => command.constructor.name === "CreateAgentRuntimeCommand").input.environmentVariables).toEqual({
      AGENTDISPATCH_WORKER_PROTOCOL: "http",
      AGENTDISPATCH_AGENT_NAME: "Custom Agent"
    });
  });

  it("keeps A2A runtime-mode resources alive for follow-up by default", async () => {
    const control = new FakeControlClient();
    const adapter = createAdapter(new FakeDataClient(), control);
    const request = createRequest("agent.run", "runtime", {}, { ecrImageUri: "123.dkr.ecr.us-west-2.amazonaws.com/worker:latest", executionRoleArn: "arn:aws:iam::123:role/exec" }, "a2a");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    await adapter.provision({ dispatch: request, task, target });
    const cleanup = await adapter.cleanup(target);

    expect(cleanup).toMatchObject({
      status: "skipped",
      providerRefs: { cleanupReason: "a2a_session_available_for_followup" }
    });
    expect(control.commands.map((command) => command.constructor.name)).not.toContain("DeleteAgentRuntimeCommand");
  });

  it("fails command tasks when AgentCore emits a stream exception", async () => {
    const data = new FakeDataClient();
    (data as any).send = async (command: any) => {
      data.commands.push(command);
      if (command.constructor.name === "InvokeAgentRuntimeCommandCommand") {
        return { stream: [{ validationException: { message: "invalid command request" } }] };
      }
      return { runtimeSessionId: command.input.runtimeSessionId, statusCode: 200 };
    };
    const adapter = createAdapter(data);
    const request = createRequest("command.run", "session", { command: "echo hello" });
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });

    await expect(adapter.startTask({ dispatch: request, task, target, session: provisioned.session })).rejects.toThrow("invalid command request");
    const events = [];
    for await (const event of adapter.streamEvents(task.id)) events.push(event);
    expect(events.some((event) => event.type === "task.failed" && event.message === "invalid command request")).toBe(true);
  });

  it("stops AgentCore runtime sessions during cancellation", async () => {
    const data = new FakeDataClient();
    const adapter = createAdapter(data);
    const request = createRequest("agent.run", "session");
    const target = (await adapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await adapter.provision({ dispatch: request, task, target });

    await expect(adapter.cancel(task.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(data.commands.map((command) => command.constructor.name)).toContain("StopRuntimeSessionCommand");
    expect(data.commands.find((command) => command.constructor.name === "StopRuntimeSessionCommand").input.runtimeSessionId)
      .toBe(provisioned.session?.providerRefs.runtimeSessionId);
  });

  it("can cancel a session-mode task after adapter restart", async () => {
    const firstData = new FakeDataClient();
    const firstAdapter = createAdapter(firstData);
    const request = createRequest("agent.run", "session");
    const target = (await firstAdapter.resolveTarget(request)).target;
    const task = createTask(request);
    const provisioned = await firstAdapter.provision({ dispatch: request, task, target });

    const restartedData = new FakeDataClient();
    const restartedAdapter = createAdapter(restartedData);
    await expect(restartedAdapter.cancel(task.id)).resolves.toMatchObject({
      status: "cancelled",
      providerRefs: { runtimeSessionId: provisioned.session?.providerRefs.runtimeSessionId }
    });

    const stop = restartedData.commands.find((command) => command.constructor.name === "StopRuntimeSessionCommand");
    expect(stop.input).toMatchObject({
      agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/00000000-0000-0000-0000-000000000000:1",
      runtimeSessionId: provisioned.session?.providerRefs.runtimeSessionId
    });
  });

  it("checks live AgentCore runtime reachability for session mode", async () => {
    const control = new FakeControlClient();
    const checks = await checkAwsAgentCoreLivePreflight({
      runtimeName: "research-agent",
      region: "us-west-2",
      mode: "session",
      runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/00000000-0000-0000-0000-000000000000:1"
    }, { client: control });

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "aws.research-agent.credentials", status: "pass" }),
      expect.objectContaining({ name: "aws.research-agent.runtime", status: "pass" })
    ]));
    expect(control.commands.find((command) => command.constructor.name === "GetAgentRuntimeCommand").input).toMatchObject({
      agentRuntimeId: "00000000-0000-0000-0000-000000000000",
      agentRuntimeVersion: "1"
    });
  });

  it("checks AgentCore control plane reachability for runtime mode", async () => {
    const control = new FakeControlClient();
    const checks = await checkAwsAgentCoreLivePreflight({
      runtimeName: "fresh-agent",
      region: "us-west-2",
      mode: "runtime"
    }, { client: control });

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "aws.fresh-agent.control-plane", status: "pass" })
    ]));
    expect(control.commands.map((command) => command.constructor.name)).toContain("ListAgentRuntimesCommand");
  });
});

function createAdapter(data = new FakeDataClient(), control = new FakeControlClient()) {
  return new AwsAgentCoreAdapter({
    account: { name: "dev-aws", provider: "aws", credentialSource: "aws-sdk-default" },
    region: "us-west-2",
    runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:agent/00000000-0000-0000-0000-000000000000:1"
  }, { data: data as any, control: control as any });
}

function createRequest(taskType: DispatchRequest["taskType"], mode: RuntimeTarget["mode"], input: Record<string, unknown> = { instruction: "run" }, details?: Record<string, unknown>, protocol?: DispatchRequest["target"]["protocol"]): DispatchRequest {
  return {
    provider: "aws",
    accountProfile: "dev-aws",
    capability: "agent-runtime",
    taskType,
    target: { mode, protocol, details },
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
