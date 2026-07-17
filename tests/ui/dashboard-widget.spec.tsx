// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../src/credential-sidecar.js", () => ({
  CREDENTIAL_SIDECAR_PATH_ENV: "PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS",
  DEFAULT_CREDENTIAL_SIDECAR_PATH: "/tmp/test-home/.paperclip/agent-identities/credentials.json",
  getCredentialSidecarPath: () => "/tmp/test-home/.paperclip/agent-identities/credentials.json",
  resolveCredentialSidecarPath: vi.fn(async () => "/tmp/test-home/.paperclip/agent-identities/credentials.json"),
  readCredentialSidecar: vi.fn(async () => ({ identities: {} })),
  readCredentialSidecarIfExists: vi.fn(async () => ({ identities: {} })),
  parseCredentialSidecar: vi.fn((raw: unknown) => raw),
  upsertCredentialSidecarIdentity: vi.fn(async () => undefined),
  deleteCredentialSidecarIdentity: vi.fn(async () => undefined),
  resolveIdentityToken: vi.fn(async () => ({ token: "test-token" })),
  readSidecarIdentityForProvider: vi.fn(async () => null),
}));

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DashboardWidget } from "../../src/ui/index.js";

let lastDataParams: Record<string, unknown> | undefined;

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: (_key: string, params?: Record<string, unknown>) => {
    lastDataParams = params;
    return {
      data: {
        version: 4,
        identities: [
          {
            id: "agent-qa:slack",
            agentId: "agent-qa",
            provider: "slack",
            label: "QA [Plugin Lab]",
            slack: {
              teamId: "T0123456789",
              appId: "A0123456789",
              botUserId: "U0123456789",
            },
            slackSetup: {
              botTokenSecretId: "11111111-1111-4111-8111-111111111111",
              signingSecretId: "22222222-2222-4222-8222-222222222222",
            },
            credentialStatus: "configured",
          },
        ],
        providers: [],
        credentialSidecarPath: "/tmp/credentials.json",
      },
      loading: false,
      error: null,
    };
  },
  usePluginAction: () => vi.fn(async () => ({})),
}));

describe("DashboardWidget", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    lastDataParams = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads company-scoped Slack credentials and renders configured Slack coverage", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        // @ts-expect-error - minimal PluginHostContext for this test
        <DashboardWidget context={{ companyId: "company-qa", companyPrefix: "qa" }} />,
      );
    });

    expect(lastDataParams).toEqual({ companyId: "company-qa" });
    expect(container.textContent).toContain("Slack: T0123456789");
    expect(container.textContent).toContain("Configured");
    expect(container.textContent).toContain("0Need setup");
    expect(container.textContent).not.toContain("Missing");
  });
});
