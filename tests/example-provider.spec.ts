import { describe, it, expect } from "vitest";
import {
  EXAMPLE_PROVIDER_ID,
  exampleProvider,
  exampleWhoamiToolSpec,
  validateExampleConfig,
  projectExamplePluginConfig
} from "../src/providers/example/index.js";
import { createProviderTool } from "../src/core/tool-pipeline.js";
import type { ProviderToolPipelineDeps } from "../src/core/tool-pipeline.js";
import type { ExampleAgentIdentity } from "../src/providers/example/index.js";

describe("example provider definition", () => {
  it("is a coming-soon provider with a stable id", () => {
    expect(exampleProvider.id).toBe(EXAMPLE_PROVIDER_ID);
    expect(EXAMPLE_PROVIDER_ID).toBe("example");
    expect(exampleProvider.definition.status).toBe("coming-soon");
  });

  it("contributes exactly one tool and one manifest fragment", () => {
    expect(exampleProvider.tools).toHaveLength(1);
    expect(exampleProvider.tools[0].name).toBe("example_whoami");
    expect(exampleProvider.manifestTools).toHaveLength(1);
    expect((exampleProvider.manifestTools[0] as { name: string }).name).toBe("example_whoami");
  });

  it("has no resource-ref resolver (non-git provider)", () => {
    expect(exampleWhoamiToolSpec.resolveResourceRef).toBeUndefined();
  });
});

describe("validateExampleConfig", () => {
  it("accepts a well-formed identity", () => {
    const result = validateExampleConfig({ label: "Demo Bot", demoToken: "demo-secret" });
    expect(result).toEqual({ label: "Demo Bot", demoToken: "demo-secret" });
  });

  it("rejects a missing label with a message", () => {
    const result = validateExampleConfig({ demoToken: "demo-secret" });
    expect(typeof result).toBe("string");
    expect(result).toContain("label");
  });

  it("rejects a missing demoToken with a message", () => {
    const result = validateExampleConfig({ label: "Demo Bot" });
    expect(typeof result).toBe("string");
    expect(result).toContain("demoToken");
  });
});

describe("projectExamplePluginConfig", () => {
  it("keeps valid identities and drops invalid ones", () => {
    const projected = projectExamplePluginConfig({
      "agent-good": { label: "Good", demoToken: "t" },
      "agent-bad": { label: "" }
    });
    expect(Object.keys(projected)).toEqual(["agent-good"]);
    expect(projected["agent-good"]).toEqual({ label: "Good", demoToken: "t" });
  });
});

// Spec §12 suite: "Example-provider contract" — the stub runs through the SAME
// core pipeline as GitHub, WITHOUT git, and its token is redacted from output.
describe("example provider contract through the core pipeline", () => {
  const identity = { agentId: "agent-1", identity: { label: "Demo Bot", demoToken: "SECRET-DEMO" } };
  const deps: ProviderToolPipelineDeps<ExampleAgentIdentity> = {
    resolveIdentity: async () => identity,
    redactSecrets: <T,>(value: T, secrets: readonly string[]): T => {
      let json = JSON.stringify(value);
      for (const secret of secrets) json = json.split(secret).join("[REDACTED]");
      return JSON.parse(json) as T;
    }
  };

  it("resolves identity + credential and returns the label without leaking the token", async () => {
    const tool = createProviderTool(exampleProvider, exampleWhoamiToolSpec, {} as never, deps);
    const result = (await tool.handler({}, { agentId: "agent-1" } as never)) as {
      content: string;
      data: { label: string; tokenResolved: boolean };
    };
    expect(result.data.label).toBe("Demo Bot");
    expect(result.data.tokenResolved).toBe(true);
    // The token string must appear NOWHERE in the tool output.
    expect(JSON.stringify(result)).not.toContain("SECRET-DEMO");
  });
});
