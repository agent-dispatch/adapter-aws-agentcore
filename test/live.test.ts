import { describe, expect, it } from "vitest";

describe("live AWS AgentCore integration", () => {
  it.skipIf(process.env.AGENTDISPATCH_LIVE_AGENTCORE !== "1")("is explicitly gated by environment", () => {
    expect(process.env.AGENTDISPATCH_AWS_REGION).toBeTruthy();
    expect(process.env.AGENTDISPATCH_AGENTCORE_RUNTIME_ARN).toBeTruthy();
  });
});
