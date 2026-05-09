import { describe, expect, it } from "vitest";
import { AwsAgentCoreAdapter } from "../src/index.js";

describe("AwsAgentCoreAdapter", () => {
  it("declares provider-neutral capability support", () => {
    const adapter = new AwsAgentCoreAdapter({
      account: { name: "dev-aws", provider: "aws", credentialSource: "aws-sdk-default" },
      region: "us-west-2",
      runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/example"
    });

    expect(adapter.capabilities()[0]).toMatchObject({
      provider: "aws",
      capability: "agent-runtime",
      taskTypes: ["agent.run", "command.run"],
      targetModes: ["session", "runtime"]
    });
  });
});
