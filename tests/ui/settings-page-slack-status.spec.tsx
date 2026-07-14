// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same test-environment shim as tests/ui/settings-page-interactions.spec.tsx:
// importing SettingsPage pulls in the full provider composition root (via
// providers/index.ts -> github/credentials.ts -> credential-sidecar.ts),
// which touches node:os/node:fs/node:crypto at module-eval time. Those are
// browser-shimmed under jsdom and don't work, but this plugin never runs
// credential-sidecar code outside the worker (Node), so stubbing it here is
// purely a test harness concern, not a behavior change.
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
import { act } from "react-dom/test-utils";
import { SettingsPage } from "../../src/ui/SettingsPage.js";
import { GITHUB_IDENTITY_PROVIDER_ID, SLACK_IDENTITY_PROVIDER_ID } from "../../src/shared/types.js";

const actionHandlers = new Map<string, ReturnType<typeof vi.fn>>();

function actionFor(key: string) {
  let handler = actionHandlers.get(key);
  if (!handler) {
    handler = vi.fn(async () => ({}));
    actionHandlers.set(key, handler);
  }
  return handler;
}

let bridgeData: Record<string, unknown> = {};

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: (key: string) => ({
    data: bridgeData[key] ?? null,
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
  }),
  usePluginAction: (key: string) => actionFor(key),
}));

const providers = [
  { id: GITHUB_IDENTITY_PROVIDER_ID, name: "GitHub", status: "enabled", description: "GitHub" },
  { id: SLACK_IDENTITY_PROVIDER_ID, name: "Slack", status: "coming-soon", description: "Slack" },
];

function slackIdentityEntry() {
  return {
    id: "id-1",
    agentId: "agent-0",
    provider: SLACK_IDENTITY_PROVIDER_ID,
    label: "Release Bot",
    slack: { teamId: "T0123456789", appId: "A0123456789", botUserId: "U0123456789" },
    credential: {},
    credentialStatus: "ok",
  };
}

function baseBridgeData(identities: unknown[] = []) {
  return {
    "bot-identity-config": {
      identities,
      providers,
      companyName: "Acme",
      credentialSidecarPath: "",
      credentialSidecarError: null,
    },
    "paperclip-agents": {
      agents: [
        { id: "agent-0", role: "Engineer", status: "active" },
        { id: "agent-1", role: "Engineer", status: "active" },
      ],
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  bridgeData = baseBridgeData();
  actionHandlers.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network access is not available in this test");
  }));
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderSettingsPage() {
  act(() => {
    root = createRoot(container);
    root.render(
      // @ts-expect-error -- minimal PluginHostContext for the test harness
      <SettingsPage context={{ companyId: "", companyPrefix: "acme" }} />,
    );
  });
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function text(): string {
  return container.textContent ?? "";
}

async function openSlackEditDialog() {
  bridgeData["bot-identity-config"] = {
    identities: [slackIdentityEntry()],
    providers,
    companyName: "Acme",
    credentialSidecarPath: "",
    credentialSidecarError: null,
  };
  renderSettingsPage();
  const editButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Edit");
  click(editButton ?? null);
  const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
  click(nextButton ?? null);
}

describe("Slack status panel (slack_bot_whoami)", () => {
  it("shows a loading state while slack_bot_whoami is in flight", async () => {
    actionFor("slack_bot_whoami").mockReturnValue(new Promise(() => {
      // never resolves for this assertion
    }));

    await openSlackEditDialog();

    expect(text()).toMatch(/Checking Slack connection|Loading/i);
  });

  it("renders bot user id / team from a successful slack_bot_whoami response, never a token", async () => {
    actionFor("slack_bot_whoami").mockResolvedValue({
      content: "Configured Slack identity: Release Bot (team T0123456789, app A0123456789).",
      data: {
        label: "Release Bot",
        teamId: "T0123456789",
        appId: "A0123456789",
        botUserId: "bot-user-U123",
        hasDefaultChannel: false,
      },
    });

    await openSlackEditDialog();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("slack_bot_whoami")).toHaveBeenCalled();
    expect(text()).toContain("bot-user-U123");
    expect(text()).toContain("T0123456789");
    expect(text()).not.toMatch(/xox[bpa]-/);
  });

  it("renders a secret-free not-connected message when slack_bot_whoami fails", async () => {
    actionFor("slack_bot_whoami").mockRejectedValue(new Error("Not connected"));

    await openSlackEditDialog();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text()).toMatch(/Not connected/i);
    expect(text()).not.toMatch(/xox[bpa]-/);
  });

  it("renders a secret-free not-connected message when slack_bot_whoami resolves with { error } instead of rejecting", async () => {
    // The plugin action pipeline can resolve a handled tool failure as
    // `{ error }` rather than throwing (e.g. no bound identity, revoked
    // token). This must not be treated as a successful status payload.
    actionFor("slack_bot_whoami").mockResolvedValue({
      error: "No Slack identity bound for this agent.",
    });

    await openSlackEditDialog();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text()).not.toMatch(/Connected\./i);
    expect(text()).toMatch(/Not connected|No Slack identity bound/i);
    expect(text()).not.toMatch(/xox[bpa]-/);
  });
});

describe("Slack reinstall action", () => {
  it("is confirmation-gated and launches the manifest flow (create-slack-app-manifest) only after confirming", async () => {
    actionFor("slack_bot_whoami").mockResolvedValue({
      content: "ok",
      data: { label: "Release Bot", teamId: "T0123456789", appId: "A0123456789", botUserId: "bot-user-U123", hasDefaultChannel: false },
    });
    actionFor("create-slack-app-manifest").mockResolvedValue({
      agentId: "agent-0",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      state: "state-reinstall",
      manifest: '{"name":"slack-demo"}',
      createAppUrl: "https://api.slack.com/apps?new_app=1",
      label: "Release Bot",
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    await openSlackEditDialog();

    const detailsSummary = Array.from(container.querySelectorAll("summary")).find((s) =>
      s.textContent?.match(/reinstall/i),
    );
    expect(detailsSummary).not.toBeUndefined();
    // Expand the collapsed <details> reinstall section.
    click(detailsSummary ?? null);

    const reinstallButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.match(/reinstall/i),
    );
    expect(reinstallButton).not.toBeUndefined();

    // Declining confirmation must not launch the manifest flow.
    await act(async () => {
      click(reinstallButton ?? null);
      await Promise.resolve();
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(actionFor("create-slack-app-manifest")).not.toHaveBeenCalled();

    // Confirming must launch it.
    confirmSpy.mockReturnValue(true);
    await act(async () => {
      click(reinstallButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(actionFor("create-slack-app-manifest")).toHaveBeenCalled();
  });
});

describe("Slack removal confirmation copy", () => {
  it("calls window.confirm with Slack-specific recovery-guidance copy, and only deletes when confirmed", async () => {
    bridgeData["bot-identity-config"] = {
      identities: [slackIdentityEntry()],
      providers,
      companyName: "Acme",
      credentialSidecarPath: "",
      credentialSidecarError: null,
    };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    actionFor("delete-bot-identity-config").mockResolvedValue({});

    renderSettingsPage();

    const deleteButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Delete");
    await act(async () => {
      click(deleteButton ?? null);
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalled();
    const confirmMessage = confirmSpy.mock.calls[0]?.[0] as string;
    expect(confirmMessage).toMatch(/Slack install metadata/i);
    expect(confirmMessage).toMatch(/not.*deleted|are not deleted/i);
    expect(actionFor("delete-bot-identity-config")).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await act(async () => {
      click(deleteButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(actionFor("delete-bot-identity-config")).toHaveBeenCalledWith({
      agentId: "agent-0",
      provider: SLACK_IDENTITY_PROVIDER_ID,
    });
  });

  it("uses generic confirmation copy for GitHub identities (no Slack-specific text)", async () => {
    bridgeData["bot-identity-config"] = {
      identities: [
        {
          id: "id-2",
          agentId: "agent-0",
          provider: GITHUB_IDENTITY_PROVIDER_ID,
          label: "Release Bot",
          github: { username: "release-bot[bot]" },
          credential: {},
          credentialStatus: "ok",
        },
      ],
      providers,
      companyName: "Acme",
      credentialSidecarPath: "",
      credentialSidecarError: null,
    };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    actionFor("delete-bot-identity-config").mockResolvedValue({});

    renderSettingsPage();
    const deleteButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Delete");
    await act(async () => {
      click(deleteButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    const confirmMessage = confirmSpy.mock.calls[0]?.[0] as string;
    expect(confirmMessage).toMatch(/GitHub App/i);
    expect(confirmMessage).not.toMatch(/Slack/i);
  });
});
