import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  InvokeAgentRuntimeCommandCommand,
  StopRuntimeSessionCommand
} from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  CreateAgentRuntimeEndpointCommand,
  DeleteAgentRuntimeCommand,
  DeleteAgentRuntimeEndpointCommand,
  GetAgentRuntimeEndpointCommand
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  createId,
  nowIso,
  toRuntimeError,
  type AccountProfile,
  type ArtifactRecord,
  type AdapterCapability,
  type BackendAdapter,
  type CancelResult,
  type CleanupResult,
  type DispatchRequest,
  type ProvisionRequest,
  type ProvisionResult,
  type ResolvedTarget,
  type RuntimeEvent,
  type RuntimeRecord,
  type RuntimeTarget,
  type SessionRecord,
  type StartTaskRequest,
  type StartTaskResult
} from "@agentdispatch/core";

export interface AwsAgentCoreAdapterConfig {
  account: AccountProfile;
  region: string;
  runtimeArn?: string;
  qualifier?: string;
  runtimeNamePrefix?: string;
  defaultExecutionRoleArn?: string;
  deleteRuntimeOnCompletion?: boolean;
}

interface AwsAgentCoreClients {
  data: BedrockAgentCoreClient;
  control: BedrockAgentCoreControlClient;
}

export class AwsAgentCoreAdapter implements BackendAdapter {
  readonly name = "aws-agentcore";
  readonly provider = "aws";
  private readonly config: AwsAgentCoreAdapterConfig;
  private readonly clients: AwsAgentCoreClients;
  private readonly events = new Map<string, RuntimeEvent[]>();
  private readonly sessions = new Map<string, { runtimeSessionId: string; runtimeArn: string; qualifier?: string; target?: RuntimeTarget }>();

  constructor(config: AwsAgentCoreAdapterConfig, clients?: Partial<AwsAgentCoreClients>) {
    this.config = config;
    this.clients = {
      data: clients?.data ?? new BedrockAgentCoreClient({ region: config.region }),
      control: clients?.control ?? new BedrockAgentCoreControlClient({ region: config.region })
    };
  }

  capabilities(): AdapterCapability[] {
    return [
      {
        provider: "aws",
        capability: "agent-runtime",
        taskTypes: ["agent.run", "command.run"],
        targetModes: ["session", "runtime"],
        configRequirements: ["region", "runtimeArn for session mode", "ecrImageUri and executionRoleArn for runtime mode"]
      }
    ];
  }

  async resolveTarget(request: DispatchRequest): Promise<ResolvedTarget> {
    const runtimeArn = request.target.mode === "session" ? this.requiredRuntimeArn() : undefined;
    return {
      account: this.config.account,
      target: {
        provider: "aws",
        accountProfile: request.accountProfile,
        capability: request.capability,
        backend: this.name,
        mode: request.target.mode,
        details: request.target.details,
        providerRefs: {
          region: this.config.region,
          runtimeArn,
          qualifier: this.config.qualifier ?? "DEFAULT"
        }
      }
    };
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    if (request.dispatch.target.mode === "runtime") {
      return this.provisionRuntime(request);
    }

    const runtimeArn = this.requiredRuntimeArn();
    const runtimeSessionId = createAgentCoreSessionId();
    const timestamp = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      taskId: request.task.id,
      provider: "aws",
      accountProfile: request.dispatch.accountProfile,
      capability: request.dispatch.capability,
      backend: this.name,
      status: "ready",
      providerRefs: {
        runtimeSessionId,
        runtimeArn,
        qualifier: this.config.qualifier ?? "DEFAULT"
      },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.sessions.set(request.task.id, { runtimeSessionId, runtimeArn, qualifier: this.config.qualifier, target: request.target });
    this.push(request.task.id, "session.created", "Created AgentCore runtime session.", session.providerRefs);
    return { session, providerRefs: session.providerRefs };
  }

  async startTask(request: StartTaskRequest): Promise<StartTaskResult> {
    const session = this.sessions.get(request.task.id);
    if (!session) {
      throw new Error(`No AgentCore runtime session found for task ${request.task.id}.`);
    }

    if (request.dispatch.taskType === "command.run") {
      return this.startCommandTask(request, session);
    }
    return this.startAgentTask(request, session);
  }

  async *streamEvents(taskId: string): AsyncIterable<RuntimeEvent> {
    const events = this.events.get(taskId) ?? [];
    for (const event of events) {
      yield event;
    }
    this.events.delete(taskId);
  }

  async cancel(taskId: string): Promise<CancelResult> {
    const session = this.sessions.get(taskId);
    if (!session) {
      return { status: "not_found" };
    }
    try {
      await this.clients.data.send(new StopRuntimeSessionCommand({
        agentRuntimeArn: session.runtimeArn,
        runtimeSessionId: session.runtimeSessionId,
        qualifier: session.qualifier
      }));
      return { status: "cancelled", providerRefs: { runtimeSessionId: session.runtimeSessionId } };
    } catch (error) {
      return { status: "failed", error: toRuntimeError(error, "aws_agentcore.cancel_failed") };
    }
  }

  async cleanup(target: RuntimeTarget): Promise<CleanupResult> {
    if (target.mode !== "runtime" || this.config.deleteRuntimeOnCompletion === false) {
      return { status: "skipped" };
    }
    const agentRuntimeId = String(target.providerRefs?.agentRuntimeId ?? "");
    const endpointName = String(target.providerRefs?.endpointName ?? "");
    try {
      if (agentRuntimeId && endpointName) {
        await this.clients.control.send(new DeleteAgentRuntimeEndpointCommand({ agentRuntimeId, endpointName }));
      }
      if (agentRuntimeId) {
        await this.clients.control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId }));
      }
      return { status: "completed", providerRefs: { agentRuntimeId, endpointName } };
    } catch (error) {
      return { status: "failed", error: toRuntimeError(error, "aws_agentcore.cleanup_failed") };
    }
  }

  private async provisionRuntime(request: ProvisionRequest): Promise<ProvisionResult> {
    const details = request.dispatch.target.details ?? {};
    const ecrImageUri = stringDetail(details, "ecrImageUri");
    const executionRoleArn = stringDetail(details, "executionRoleArn") ?? this.config.defaultExecutionRoleArn;
    if (!ecrImageUri || !executionRoleArn) {
      throw new Error("runtime mode requires target.details.ecrImageUri and target.details.executionRoleArn or defaultExecutionRoleArn.");
    }

    const runtimeName = `${this.config.runtimeNamePrefix ?? "agentdispatch"}-${request.task.id}`.slice(0, 48);
    const runtimeResponse: any = await this.clients.control.send(new CreateAgentRuntimeCommand({
      agentRuntimeName: runtimeName,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: ecrImageUri } },
      roleArn: executionRoleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: { serverProtocol: "HTTP" }
    } as any));

    const runtimeArn = runtimeResponse.agentRuntimeArn;
    const agentRuntimeId = runtimeResponse.agentRuntimeId ?? runtimeArnToId(runtimeArn);
    const endpointName = `endpoint-${request.task.id}`.slice(0, 48);
    const endpointResponse: any = await this.clients.control.send(new CreateAgentRuntimeEndpointCommand({
      agentRuntimeId,
      endpointName
    } as any));
    await this.waitForEndpoint(agentRuntimeId, endpointName);

    const runtimeSessionId = createAgentCoreSessionId();
    const timestamp = nowIso();
    const runtime: RuntimeRecord = {
      id: createId("runtime"),
      taskId: request.task.id,
      provider: "aws",
      accountProfile: request.dispatch.accountProfile,
      capability: request.dispatch.capability,
      backend: this.name,
      status: "ready",
      providerRefs: { runtimeArn, agentRuntimeId, endpointName, endpointArn: endpointResponse.agentRuntimeEndpointArn },
      cleanupStatus: "pending",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const session: SessionRecord = {
      id: createId("session"),
      taskId: request.task.id,
      provider: "aws",
      accountProfile: request.dispatch.accountProfile,
      capability: request.dispatch.capability,
      backend: this.name,
      status: "ready",
      providerRefs: { runtimeSessionId, runtimeArn, agentRuntimeId, endpointName },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    request.target.providerRefs = { ...request.target.providerRefs, ...runtime.providerRefs };
    this.sessions.set(request.task.id, { runtimeSessionId, runtimeArn, qualifier: this.config.qualifier, target: request.target });
    this.push(request.task.id, "runtime.provisioned", "Provisioned AgentCore runtime.", runtime.providerRefs);
    this.push(request.task.id, "session.created", "Created AgentCore runtime session.", session.providerRefs);
    return { runtime, session, providerRefs: { ...runtime.providerRefs, ...session.providerRefs } };
  }

  private async startAgentTask(request: StartTaskRequest, session: { runtimeSessionId: string; runtimeArn: string; qualifier?: string }): Promise<StartTaskResult> {
    const payload = JSON.stringify({ taskType: request.dispatch.taskType, input: request.dispatch.input, metadata: request.dispatch.metadata });
    const response: any = await this.clients.data.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: session.runtimeArn,
      runtimeSessionId: session.runtimeSessionId,
      qualifier: session.qualifier,
      contentType: "application/json",
      accept: "application/json",
      payload: Buffer.from(payload)
    }));
    const text = await response.response?.transformToString?.();
    const parsed = parseJsonObject(text);
    const workerEvents = normalizeWorkerEvents(request.task.id, parsed);
    if (workerEvents.length > 0) {
      for (const event of workerEvents) this.pushEvent(event);
    } else if (text) {
      this.push(request.task.id, "task.progress", text);
    }
    return {
      providerRefs: { runtimeSessionId: session.runtimeSessionId },
      result: parsed ?? { response: text ?? "" },
      artifacts: normalizeArtifactManifest(request.task.id, parsed)
    };
  }

  private async startCommandTask(request: StartTaskRequest, session: { runtimeSessionId: string; runtimeArn: string; qualifier?: string }): Promise<StartTaskResult> {
    const command = String(request.dispatch.input.command ?? "");
    if (!command) throw new Error("command.run requires input.command.");
    const response: any = await this.clients.data.send(new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: session.runtimeArn,
      runtimeSessionId: session.runtimeSessionId,
      qualifier: session.qualifier,
      contentType: "application/json",
      accept: "application/json",
      body: { command, timeout: typeof request.dispatch.input.timeoutSeconds === "number" ? request.dispatch.input.timeoutSeconds : undefined }
    }));
    let exitCode = 0;
    for await (const item of response.stream ?? []) {
      const chunk = item.chunk;
      if (chunk?.contentStart) this.push(request.task.id, "task.progress", "Command started.");
      if (chunk?.contentDelta?.stdout) this.push(request.task.id, "task.log", chunk.contentDelta.stdout, { stream: "stdout" });
      if (chunk?.contentDelta?.stderr) this.push(request.task.id, "task.log", chunk.contentDelta.stderr, { stream: "stderr" });
      if (chunk?.contentStop) {
        exitCode = chunk.contentStop.exitCode;
        this.push(request.task.id, exitCode === 0 ? "task.progress" : "task.failed", `Command ${chunk.contentStop.status}.`, { exitCode });
      }
    }
    if (exitCode !== 0) {
      throw new Error(`Command exited with ${exitCode}.`);
    }
    return { providerRefs: { runtimeSessionId: session.runtimeSessionId }, result: { exitCode } };
  }

  private requiredRuntimeArn(): string {
    if (!this.config.runtimeArn) {
      throw new Error("AWS AgentCore session mode requires runtimeArn.");
    }
    return this.config.runtimeArn;
  }

  private async waitForEndpoint(agentRuntimeId: string, endpointName: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const endpoint: any = await this.clients.control.send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId, endpointName }));
      if (endpoint.status === "READY") return;
      if (endpoint.status === "CREATE_FAILED") throw new Error(`AgentCore endpoint ${endpointName} failed to create.`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`Timed out waiting for AgentCore endpoint ${endpointName}.`);
  }

  private push(taskId: string, type: RuntimeEvent["type"], message?: string, payload?: Record<string, unknown>): void {
    this.pushEvent({ taskId, type, message, payload, timestamp: nowIso() });
  }

  private pushEvent(event: RuntimeEvent): void {
    const current = this.events.get(event.taskId) ?? [];
    current.push(event);
    this.events.set(event.taskId, current);
  }
}

function createAgentCoreSessionId(): string {
  return createId("agentcore_session");
}

function stringDetail(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runtimeArnToId(runtimeArn: string): string {
  return runtimeArn.split("/").at(-1) ?? runtimeArn;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeWorkerEvents(taskId: string, parsed: Record<string, unknown> | undefined): RuntimeEvent[] {
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type as RuntimeEvent["type"] : undefined;
    if (!type) return [];
    const message = typeof record.message === "string" ? record.message : undefined;
    const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? record.payload as Record<string, unknown>
      : undefined;
    return [{ taskId, type, message, payload, timestamp: nowIso() }];
  });
}

function normalizeArtifactManifest(taskId: string, parsed: Record<string, unknown> | undefined): ArtifactRecord[] {
  const artifacts = Array.isArray(parsed?.artifacts)
    ? parsed.artifacts
    : Array.isArray(parsed?.artifact_manifest)
      ? parsed.artifact_manifest
      : [];
  return artifacts.flatMap((artifact) => {
    if (!artifact || typeof artifact !== "object") return [];
    const record = artifact as Record<string, unknown>;
    const uri = typeof record.uri === "string" ? record.uri : typeof record.path === "string" ? record.path : undefined;
    if (!uri) return [];
    return [{
      id: typeof record.id === "string" ? record.id : createId("art"),
      taskId,
      kind: typeof record.kind === "string" ? record.kind : "file",
      uri,
      contentType: typeof record.contentType === "string" ? record.contentType : typeof record.content_type === "string" ? record.content_type : undefined,
      sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : typeof record.size_bytes === "number" ? record.size_bytes : undefined,
      providerRefs: record.providerRefs && typeof record.providerRefs === "object" && !Array.isArray(record.providerRefs)
        ? record.providerRefs as Record<string, unknown>
        : undefined,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso()
    }];
  });
}
