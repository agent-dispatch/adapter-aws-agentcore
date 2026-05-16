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
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand
} from "@aws-sdk/client-bedrock-agentcore-control";
import { createHash } from "node:crypto";
import {
  createId,
  nowIso,
  toRuntimeError,
  type AccountProfile,
  type ArtifactRecord,
  type AdapterCapability,
  type BackendAdapter,
  type CancelResult,
  type CloudAgentInteraction,
  type CleanupResult,
  type DispatchRequest,
  type PrepareTaskRequest,
  type PrepareTaskResult,
  type ProvisionRequest,
  type ProvisionResult,
  type ResolvedTarget,
  type RuntimeEvent,
  type RuntimeRecord,
  type RuntimeProtocol,
  type RuntimeTarget,
  type SessionRecord,
  type StartTaskRequest,
  type StartTaskResult
} from "@agent-dispatch/core";

export interface AwsAgentCoreAdapterConfig {
  account: AccountProfile;
  region: string;
  runtimeArn?: string;
  qualifier?: string;
  protocol?: RuntimeProtocol;
  runtimeNamePrefix?: string;
  defaultExecutionRoleArn?: string;
  deleteRuntimeOnCompletion?: boolean;
}

export interface AwsAgentCoreA2AMessage {
  id?: string;
  role?: "user" | "agent" | (string & {});
  text?: string;
  parts?: Array<{ kind: "text" | (string & {}); text?: string; [key: string]: unknown }>;
  messageId?: string;
  metadata?: Record<string, unknown>;
}

export interface AwsAgentCoreA2AResult {
  raw?: Record<string, unknown>;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface AwsAgentCoreA2AOptions {
  client?: { send(command: InvokeAgentRuntimeCommand): Promise<any> };
  region?: string;
}

interface AwsAgentCoreClients {
  data: BedrockAgentCoreClient;
  control: BedrockAgentCoreControlClient;
}

type AgentCoreServerProtocol = "HTTP" | "MCP" | "A2A" | "AGUI";

interface AwsAgentCoreSession {
  runtimeSessionId: string;
  runtimeArn: string;
  qualifier?: string;
  protocol: RuntimeProtocol;
  serverProtocol: AgentCoreServerProtocol;
  target?: RuntimeTarget;
}

export class AwsAgentCoreAdapter implements BackendAdapter {
  readonly name = "aws-agentcore";
  readonly provider = "aws";
  private readonly config: AwsAgentCoreAdapterConfig;
  private readonly clients: AwsAgentCoreClients;
  private readonly events = new Map<string, RuntimeEvent[]>();
  private readonly sessions = new Map<string, AwsAgentCoreSession>();

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
        protocols: ["http", "a2a", "mcp", "ag-ui"],
        configRequirements: ["region", "runtimeArn for session mode", "ecrImageUri and executionRoleArn for runtime mode"]
      }
    ];
  }

  async prepareTask(request: PrepareTaskRequest): Promise<PrepareTaskResult> {
    const protocol = this.runtimeProtocol(request.dispatch);
    const serverProtocol = toAgentCoreServerProtocol(protocol);
    if (request.dispatch.target.mode !== "session") {
      return {
        providerRefs: { region: this.config.region, protocol, serverProtocol },
        cloudAgent: this.cloudAgentInteraction(request.dispatch, { protocol, serverProtocol })
      };
    }

    const session = this.ensureSession(
      request.task.id,
      this.sessionRuntimeArn(request.dispatch),
      this.config.qualifier,
      protocol,
      undefined
    );
    const providerRefs = this.sessionProviderRefs(session);
    return {
      providerRefs,
      cloudAgent: this.cloudAgentInteraction(request.dispatch, session)
    };
  }

  async resolveTarget(request: DispatchRequest): Promise<ResolvedTarget> {
    const runtimeArn = request.target.mode === "session" ? this.sessionRuntimeArn(request) : undefined;
    const protocol = this.runtimeProtocol(request);
    const serverProtocol = toAgentCoreServerProtocol(protocol);
    return {
      account: this.config.account,
      target: {
        provider: "aws",
        accountProfile: request.accountProfile,
        capability: request.capability,
        backend: this.name,
        mode: request.target.mode,
        protocol,
        details: request.target.details,
        providerRefs: {
          region: this.config.region,
          runtimeArn,
          qualifier: this.config.qualifier ?? "DEFAULT",
          protocol,
          serverProtocol
        }
      }
    };
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    if (request.dispatch.target.mode === "runtime") {
      return this.provisionRuntime(request);
    }

    const runtimeArn = this.sessionRuntimeArn(request.dispatch);
    const sessionState = this.ensureSession(
      request.task.id,
      runtimeArn,
      this.config.qualifier,
      this.runtimeProtocol(request.dispatch),
      request.target
    );
    const timestamp = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      taskId: request.task.id,
      provider: "aws",
      accountProfile: request.dispatch.accountProfile,
      capability: request.dispatch.capability,
      backend: this.name,
      status: "ready",
      providerRefs: this.sessionProviderRefs(sessionState),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.push(request.task.id, "session.created", "Created AgentCore runtime session.", session.providerRefs);
    return {
      session,
      providerRefs: session.providerRefs,
      cloudAgent: this.cloudAgentInteraction(request.dispatch, sessionState)
    };
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
    const session = this.sessions.get(taskId) ?? this.fallbackSession(taskId);
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
    const protocol = normalizeRuntimeProtocol(String(target.providerRefs?.protocol ?? target.protocol ?? target.details?.protocol ?? "http"));
    if (protocol === "a2a" && target.details?.cleanupAfterTask !== true) {
      return { status: "skipped", providerRefs: { cleanupReason: "a2a_session_available_for_followup" } };
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

    const runtimeName = createAgentCoreResourceName(this.config.runtimeNamePrefix ?? "agentdispatch", request.task.id);
    const protocol = this.runtimeProtocol(request.dispatch);
    const serverProtocol = toAgentCoreServerProtocol(protocol);
    const environmentVariables = runtimeEnvironmentVariables(details, protocol);
    const runtimeResponse: any = await this.clients.control.send(new CreateAgentRuntimeCommand({
      agentRuntimeName: runtimeName,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: ecrImageUri } },
      roleArn: executionRoleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: { serverProtocol },
      ...(Object.keys(environmentVariables).length > 0 ? { environmentVariables } : {}),
      clientToken: createAgentCoreClientToken("runtime", request.task.id)
    } as any));

    const runtimeArn = requiredString(runtimeResponse.agentRuntimeArn, "CreateAgentRuntime did not return agentRuntimeArn.");
    const agentRuntimeId = runtimeResponse.agentRuntimeId ?? runtimeArnToId(runtimeArn);
    const agentRuntimeVersion = runtimeResponse.agentRuntimeVersion;
    await this.waitForRuntime(agentRuntimeId);
    const endpointName = createAgentCoreResourceName("endpoint", request.task.id);
    const endpointResponse: any = await this.clients.control.send(new CreateAgentRuntimeEndpointCommand({
      agentRuntimeId,
      name: endpointName,
      agentRuntimeVersion,
      clientToken: createAgentCoreClientToken("endpoint", request.task.id)
    } as any));
    await this.waitForEndpoint(agentRuntimeId, endpointName);

    const sessionState = this.ensureSession(request.task.id, runtimeArn, endpointName, protocol, request.target);
    const timestamp = nowIso();
    const runtime: RuntimeRecord = {
      id: createId("runtime"),
      taskId: request.task.id,
      provider: "aws",
      accountProfile: request.dispatch.accountProfile,
      capability: request.dispatch.capability,
      backend: this.name,
      status: "ready",
      providerRefs: { runtimeArn, agentRuntimeId, agentRuntimeVersion, endpointName, endpointArn: endpointResponse.agentRuntimeEndpointArn, protocol, serverProtocol },
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
      providerRefs: { ...this.sessionProviderRefs(sessionState), agentRuntimeId, endpointName },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    request.target.providerRefs = { ...request.target.providerRefs, ...runtime.providerRefs };
    this.push(request.task.id, "runtime.provisioned", "Provisioned AgentCore runtime.", runtime.providerRefs);
    this.push(request.task.id, "session.created", "Created AgentCore runtime session.", session.providerRefs);
    return {
      runtime,
      session,
      providerRefs: { ...runtime.providerRefs, ...session.providerRefs },
      cloudAgent: this.cloudAgentInteraction(request.dispatch, sessionState)
    };
  }

  private async startAgentTask(request: StartTaskRequest, session: AwsAgentCoreSession): Promise<StartTaskResult> {
    const payload = JSON.stringify(createAgentRuntimePayload(request.dispatch, request.task.id, session.protocol));
    const response: any = await this.clients.data.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: session.runtimeArn,
      runtimeSessionId: session.runtimeSessionId,
      qualifier: session.qualifier,
      contentType: "application/json",
      accept: "application/json",
      payload: Buffer.from(payload)
    }));
    const text = await readResponseToString(response.response);
    const agentResponse = parseAgentRuntimeResponse(text);
    const parsed = agentResponse.parsed;
    const workerEvents = normalizeWorkerEvents(request.task.id, parsed);
    if (workerEvents.length > 0) {
      for (const event of workerEvents) this.pushEvent(event);
    } else if (agentResponse.data.length > 0) {
      for (const chunk of agentResponse.data) this.push(request.task.id, "task.progress", chunk);
    } else if (agentResponse.text) {
      this.push(request.task.id, "task.progress", agentResponse.text);
    }
    if (parsed?.ok === false) {
      throw new Error(typeof parsed.error === "string" ? parsed.error : "AgentCore worker returned ok:false.");
    }
    return {
      providerRefs: this.sessionProviderRefs(session),
      cloudAgent: this.cloudAgentInteraction(request.dispatch, session),
      result: parsed ?? { response: agentResponse.data.length > 0 ? agentResponse.data.join("\n") : agentResponse.text ?? "" },
      artifacts: normalizeArtifactManifest(request.task.id, parsed)
    };
  }

  private async startCommandTask(request: StartTaskRequest, session: AwsAgentCoreSession): Promise<StartTaskResult> {
    const command = String(request.dispatch.input.command ?? "");
    if (!command) throw new Error("command.run requires input.command.");
    const response: any = await this.clients.data.send(new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: session.runtimeArn,
      runtimeSessionId: session.runtimeSessionId,
      qualifier: session.qualifier,
      contentType: "application/json",
      accept: "application/vnd.amazon.eventstream",
      body: { command, timeout: typeof request.dispatch.input.timeoutSeconds === "number" ? request.dispatch.input.timeoutSeconds : undefined }
    }));
    let exitCode = 0;
    for await (const item of response.stream ?? []) {
      const streamError = commandStreamError(item);
      if (streamError) {
        this.push(request.task.id, "task.failed", streamError.message, { error: streamError });
        throw new Error(streamError.message);
      }
      const chunk = item.chunk;
      if (chunk?.contentStart) this.push(request.task.id, "task.progress", "Command started.");
      if (chunk?.contentDelta?.stdout) this.push(request.task.id, "task.log", chunk.contentDelta.stdout, { stream: "stdout" });
      if (chunk?.contentDelta?.stderr) this.push(request.task.id, "task.log", chunk.contentDelta.stderr, { stream: "stderr" });
      if (chunk?.contentStop) {
        exitCode = chunk.contentStop.exitCode ?? -1;
        this.push(request.task.id, exitCode === 0 ? "task.progress" : "task.failed", `Command ${chunk.contentStop.status}.`, { exitCode });
      }
    }
    if (exitCode !== 0) {
      throw new Error(`Command exited with ${exitCode}.`);
    }
    return {
      providerRefs: this.sessionProviderRefs(session),
      cloudAgent: this.cloudAgentInteraction(request.dispatch, session),
      result: { exitCode }
    };
  }

  private sessionRuntimeArn(request: DispatchRequest): string {
    const runtimeArn = stringDetail(request.target.details ?? {}, "runtimeArn") ?? this.config.runtimeArn;
    if (!runtimeArn) {
      throw new Error("AWS AgentCore session mode requires runtimeArn in backend config, AGENTDISPATCH_AGENTCORE_RUNTIME_ARN, or target.details.runtimeArn.");
    }
    return runtimeArn;
  }

  private ensureSession(
    taskId: string,
    runtimeArn: string,
    qualifier: string | undefined,
    protocol: RuntimeProtocol,
    target: RuntimeTarget | undefined
  ): AwsAgentCoreSession {
    const existing = this.sessions.get(taskId);
    if (existing) {
      const next = { ...existing, target: target ?? existing.target };
      this.sessions.set(taskId, next);
      return next;
    }
    const session: AwsAgentCoreSession = {
      runtimeSessionId: createAgentCoreSessionId(taskId),
      runtimeArn,
      qualifier,
      protocol,
      serverProtocol: toAgentCoreServerProtocol(protocol),
      target
    };
    this.sessions.set(taskId, session);
    return session;
  }

  private fallbackSession(taskId: string): AwsAgentCoreSession | undefined {
    if (!this.config.runtimeArn) return undefined;
    const protocol = normalizeRuntimeProtocol(this.config.protocol ?? "http");
    return {
      runtimeSessionId: createAgentCoreSessionId(taskId),
      runtimeArn: this.config.runtimeArn,
      qualifier: this.config.qualifier,
      protocol,
      serverProtocol: toAgentCoreServerProtocol(protocol)
    };
  }

  private sessionProviderRefs(session: Pick<AwsAgentCoreSession, "runtimeSessionId" | "runtimeArn" | "qualifier" | "protocol" | "serverProtocol">): Record<string, unknown> {
    return {
      runtimeSessionId: session.runtimeSessionId,
      runtimeArn: session.runtimeArn,
      qualifier: session.qualifier ?? "DEFAULT",
      protocol: session.protocol,
      serverProtocol: session.serverProtocol
    };
  }

  private runtimeProtocol(request: DispatchRequest): RuntimeProtocol {
    const details = request.target.details ?? {};
    return normalizeRuntimeProtocol(
      request.target.protocol ??
      stringDetail(details, "protocol") ??
      stringInput(request.input, "protocol") ??
      this.config.protocol ??
      "http"
    );
  }

  private cloudAgentInteraction(
    request: DispatchRequest,
    session: Partial<AwsAgentCoreSession> & { protocol: RuntimeProtocol; serverProtocol: AgentCoreServerProtocol }
  ): CloudAgentInteraction {
    const runtimeUrl = session.runtimeArn ? createAgentCoreInvocationUrl(this.config.region, session.runtimeArn) : undefined;
    const sessionHeaderName = session.protocol === "mcp"
      ? "Mcp-Session-Id"
      : "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id";
    const providerRefs = {
      region: this.config.region,
      ...(session.runtimeSessionId ? { runtimeSessionId: session.runtimeSessionId } : {}),
      ...(session.runtimeArn ? { runtimeArn: session.runtimeArn } : {}),
      ...(session.qualifier ? { qualifier: session.qualifier } : { qualifier: this.config.qualifier ?? "DEFAULT" }),
      protocol: session.protocol,
      serverProtocol: session.serverProtocol,
      ...(runtimeUrl ? { runtimeUrl } : {})
    };
    const interaction: CloudAgentInteraction = {
      protocol: session.protocol,
      provider: "aws",
      backend: this.name,
      accountProfile: request.accountProfile,
      sessionId: session.runtimeSessionId,
      providerRefs,
      model: request.input.model,
      tools: recordInput(request.input, "runtime_tools")
    };
    if (session.runtimeArn && session.runtimeSessionId) {
      interaction.invocation = {
        type: "aws.agentcore.invoke_agent_runtime",
        provider: "aws",
        region: this.config.region,
        accountProfile: request.accountProfile,
        credentialSource: this.config.account.credentialSource,
        runtimeUrl,
        agentRuntimeArn: session.runtimeArn,
        qualifier: session.qualifier ?? this.config.qualifier ?? "DEFAULT",
        runtimeSessionId: session.runtimeSessionId,
        sessionHeaderName,
        sessionHeaderValue: session.runtimeSessionId,
        contentType: "application/json",
        accept: "application/json",
        payloadFormat: session.protocol === "a2a" ? "a2a.jsonrpc.message-send" : "agentdispatch.runtime-envelope"
      };
    }
    if (session.protocol === "a2a") {
      interaction.a2a = {
        transport: "json-rpc-2.0-http",
        messageMethod: "message/send",
        agentCardPath: "/.well-known/agent-card.json",
        agentCardOperation: "GetAgentCard",
        payloadFormat: "a2a.jsonrpc.message-send",
        endpointUrl: runtimeUrl,
        agentCardUrl: runtimeUrl ? new URL(".well-known/agent-card.json", runtimeUrl).toString() : undefined,
        sessionHeaderName,
        sessionHeaderValue: session.runtimeSessionId
      };
    }
    return interaction;
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

  private async waitForRuntime(agentRuntimeId: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const runtime: any = await this.clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
      if (runtime.status === "READY") return;
      if (runtime.status === "CREATE_FAILED") throw new Error(`AgentCore runtime ${agentRuntimeId} failed to create.`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`Timed out waiting for AgentCore runtime ${agentRuntimeId}.`);
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

export async function sendAwsAgentCoreA2AMessage(
  cloudAgent: CloudAgentInteraction,
  message: AwsAgentCoreA2AMessage,
  options: AwsAgentCoreA2AOptions = {}
): Promise<AwsAgentCoreA2AResult> {
  if (cloudAgent.protocol !== "a2a") {
    throw new Error(`Cloud agent protocol is ${cloudAgent.protocol}, not a2a.`);
  }
  const invocation = cloudAgent.invocation;
  if (!invocation || invocation.type !== "aws.agentcore.invoke_agent_runtime") {
    throw new Error("Cloud agent does not include AWS AgentCore invocation metadata.");
  }
  const region = options.region ?? stringRecordValue(invocation, "region") ?? stringRecordValue(cloudAgent.providerRefs, "region");
  const client = options.client ?? new BedrockAgentCoreClient({ region });
  const runtimeSessionId = stringRecordValue(invocation, "runtimeSessionId") ?? cloudAgent.sessionId;
  if (!runtimeSessionId) {
    throw new Error("cloudAgent.invocation.runtimeSessionId or cloudAgent.sessionId is required.");
  }
  const response = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: requiredRecordString(invocation, "agentRuntimeArn", "cloudAgent.invocation.agentRuntimeArn is required."),
    runtimeSessionId,
    qualifier: stringRecordValue(invocation, "qualifier"),
    contentType: stringRecordValue(invocation, "contentType") ?? "application/json",
    accept: stringRecordValue(invocation, "accept") ?? "application/json",
    payload: Buffer.from(JSON.stringify(createA2AMessageSendPayload(message)))
  }));
  const text = await readResponseToString(response.response);
  const parsed = parseJsonObject(text);
  return {
    raw: parsed,
    text: extractA2AResultText(parsed) ?? text,
    metadata: extractA2AResultMetadata(parsed)
  };
}

function createAgentCoreSessionId(taskId: string): string {
  return `ad-${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`;
}

function createAgentCoreInvocationUrl(region: string, runtimeArn: string): string {
  const domainSuffix = runtimeArn.split(":")[1] === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://bedrock-agentcore.${region}.${domainSuffix}/runtimes/${encodeURIComponent(runtimeArn)}/invocations/`;
}

function stringDetail(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordDetail(details: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = details[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordInput(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function runtimeEnvironmentVariables(details: Record<string, unknown>, protocol: RuntimeProtocol): Record<string, string> {
  const configured = recordDetail(details, "environmentVariables") ?? recordDetail(details, "environment_variables") ?? {};
  const environmentVariables: Record<string, string> = {
    AGENTDISPATCH_WORKER_PROTOCOL: protocol
  };
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value !== "string") {
      throw new Error(`target.details.environmentVariables.${key} must be a string.`);
    }
    environmentVariables[key] = value;
  }
  return environmentVariables;
}

function normalizeRuntimeProtocol(value: string): RuntimeProtocol {
  const normalized = value.toLowerCase();
  if (normalized === "agui") return "ag-ui";
  return normalized as RuntimeProtocol;
}

function toAgentCoreServerProtocol(protocol: RuntimeProtocol): AgentCoreServerProtocol {
  switch (protocol) {
    case "a2a":
      return "A2A";
    case "mcp":
      return "MCP";
    case "ag-ui":
    case "agui":
      return "AGUI";
    case "http":
    default:
      return "HTTP";
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(message);
}

function runtimeArnToId(runtimeArn: string): string {
  return runtimeArn.split("/").at(-1)?.split(":")[0] ?? runtimeArn;
}

function createAgentCoreResourceName(prefix: string, taskId: string): string {
  const safePrefix = sanitizeAgentCoreName(prefix || "agentdispatch");
  const safeTask = sanitizeAgentCoreName(taskId).slice(-24);
  const maxPrefixLength = Math.max(1, 47 - safeTask.length);
  return sanitizeAgentCoreName(`${safePrefix.slice(0, maxPrefixLength)}_${safeTask}`).slice(0, 48);
}

function sanitizeAgentCoreName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  return /^[a-zA-Z]/.test(normalized) ? normalized : `a${normalized}`;
}

function createAgentCoreClientToken(...parts: string[]): string {
  return `ad${createHash("sha256").update(parts.join(":")).digest("hex")}`;
}

function commandStreamError(item: any): { code: string; message: string } | undefined {
  for (const key of [
    "accessDeniedException",
    "internalServerException",
    "resourceNotFoundException",
    "serviceQuotaExceededException",
    "throttlingException",
    "validationException",
    "runtimeClientError"
  ]) {
    const error = item?.[key];
    if (error) {
      return {
        code: key,
        message: typeof error.message === "string" ? error.message : `AgentCore command stream failed with ${key}.`
      };
    }
  }
  return undefined;
}

async function readResponseToString(response: any): Promise<string | undefined> {
  if (!response) return undefined;
  if (typeof response === "string") return response;
  if (response instanceof Uint8Array) return Buffer.from(response).toString("utf8");
  if (typeof response.transformToString === "function") return response.transformToString();
  if (typeof response[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return undefined;
}

function parseAgentRuntimeResponse(text: string | undefined): { text?: string; data: string[]; parsed?: Record<string, unknown> } {
  const data = extractSseData(text);
  let parsed = parseJsonObject(text);
  for (const chunk of data) {
    const chunkJson = parseJsonObject(chunk);
    if (chunkJson) parsed = chunkJson;
  }
  return { text, data, parsed };
}

function extractSseData(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createA2AMessageSendPayload(message: AwsAgentCoreA2AMessage): Record<string, unknown> {
  const parts = message.parts ?? (message.text !== undefined ? [{ kind: "text", text: message.text }] : undefined);
  if (!parts?.length) {
    throw new Error("A2A follow-up requires message.text or message.parts.");
  }
  return {
    jsonrpc: "2.0",
    id: message.id ?? createClientPayloadId("a2a"),
    method: "message/send",
    params: {
      message: {
        role: message.role ?? "user",
        parts,
        messageId: message.messageId ?? createClientPayloadId("msg")
      },
      ...(message.metadata ? { metadata: message.metadata } : {})
    }
  };
}

function createAgentRuntimePayload(request: DispatchRequest, taskId: string, protocol: RuntimeProtocol): Record<string, unknown> {
  const prompt = typeof request.input.prompt === "string"
    ? request.input.prompt
    : typeof request.input.instruction === "string"
      ? request.input.instruction
      : undefined;
  if (protocol === "a2a") {
    return {
      jsonrpc: "2.0",
      id: taskId,
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: prompt ?? "" }],
          messageId: taskId
        },
        metadata: {
          taskType: request.taskType,
          input: request.input,
          context: request.input.context ?? {},
          ...(request.metadata ? { dispatchMetadata: request.metadata } : {})
        }
      }
    };
  }
  return {
    taskType: request.taskType,
    input: request.input,
    metadata: request.metadata,
    ...(prompt ? { prompt } : {}),
    ...(request.input.context ? { context: request.input.context } : {})
  };
}

function extractA2AResultText(parsed: Record<string, unknown> | undefined): string | undefined {
  const result = recordValue(parsed, "result") ?? parsed;
  const message = recordValue(result, "message") ?? result;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts
    .flatMap((part) => typeof part === "object" && part && typeof (part as Record<string, unknown>).text === "string"
      ? [(part as Record<string, string>).text]
      : [])
    .join("\n");
  return text || undefined;
}

function extractA2AResultMetadata(parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const result = recordValue(parsed, "result") ?? parsed;
  const message = recordValue(result, "message") ?? result;
  return recordValue(message, "metadata") ?? recordValue(result, "metadata");
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

function recordValue(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringRecordValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredRecordString(record: Record<string, unknown>, key: string, message: string): string {
  const value = stringRecordValue(record, key);
  if (!value) throw new Error(message);
  return value;
}

function createClientPayloadId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
