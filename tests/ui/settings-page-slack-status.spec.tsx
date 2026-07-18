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

const EVENTS_REQUEST_URL = "https://paperclip-test.trycloudflare.com/events";
const BOT_TOKEN_SECRET_ID = "11111111-1111-4111-8111-111111111111";
const SIGNING_SECRET_ID = "22222222-2222-4222-8222-222222222222";

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
let root: Root | null;

beforeEach(() => {
  bridgeData = baseBridgeData();
  actionHandlers.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("network access is not available in this test");
  }));
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
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

function change(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) {
    throw new Error("form control not found");
  }
  const proto = el instanceof HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
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

function rerenderSettingsPage() {
  act(() => {
    root?.render(
      // @ts-expect-error -- minimal PluginHostContext for the test harness
      <SettingsPage context={{ companyId: "", companyPrefix: "acme" }} />,
    );
  });
}

function openNewSlackCredentialStep() {
  renderSettingsPage();
  const addButton = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent === "Add identity",
  );
  click(addButton ?? null);

  const agentSelect = Array.from(container.querySelectorAll("select")).find((select) =>
    select.querySelector('option[value="agent-0"]'),
  );
  change(agentSelect ?? null, "agent-0");
  const providerSelect = Array.from(container.querySelectorAll("select")).find((select) =>
    select.querySelector(`option[value="${SLACK_IDENTITY_PROVIDER_ID}"]`),
  );
  change(providerSelect ?? null, SLACK_IDENTITY_PROVIDER_ID);
  change(container.querySelector('input[placeholder="e.g. Cade Riven [Droidshop]"]'), "Release Bot");

  const nextButton = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent === "Next",
  );
  click(nextButton ?? null);
}

describe("Configured identity rows", () => {
  it("shows the provider type instead of its account identifier", () => {
    bridgeData = baseBridgeData([slackIdentityEntry()]);
    renderSettingsPage();

    const row = container.querySelector(".agent-identities-list-row");
    expect(row?.children[1]?.textContent).toBe("Slack");
    expect(row?.textContent).not.toContain("T0123456789");
  });
});

describe("Slack status panel (slack_bot_whoami)", () => {
  it("shows a loading state while slack_bot_whoami is in flight", async () => {
    actionFor("slack_bot_whoami").mockReturnValue(new Promise(() => {
      // never resolves for this assertion
    }));

    await openSlackEditDialog();

    expect(text()).toMatch(/Loading configured Slack identity metadata/i);
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
    expect(text()).toMatch(/Configured Slack identity/i);
    expect(text()).not.toMatch(/connection status: Connected/i);
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

    expect(text()).toMatch(/identity metadata unavailable/i);
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
    expect(text()).toMatch(/identity metadata unavailable|No Slack identity bound/i);
    expect(text()).not.toMatch(/xox[bpa]-/);
  });

  it("does not check or expose reinstall for unsaved form fields, then checks when that identity becomes persisted", async () => {
    actionFor("slack_bot_whoami").mockResolvedValue({
      data: {
        label: "Release Bot",
        teamId: "T0123456789",
        appId: "A0123456789",
        botUserId: "U0123456789",
        hasDefaultChannel: false,
      },
    });
    openNewSlackCredentialStep();

    change(container.querySelector('input[placeholder="e.g. T0123456789"]'), "T0123456789");
    change(container.querySelector('input[placeholder^="A0123456789"]'), "A0123456789");
    await act(async () => {
      await Promise.resolve();
    });

    expect(actionFor("slack_bot_whoami")).not.toHaveBeenCalled();
    expect(Array.from(container.querySelectorAll("button")).some((button) =>
      button.textContent === "Create Slack App manifest",
    )).toBe(true);
    expect(Array.from(container.querySelectorAll("summary")).some((summary) =>
      summary.textContent?.match(/reinstall/i),
    )).toBe(false);

    bridgeData = baseBridgeData([slackIdentityEntry()]);
    rerenderSettingsPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("slack_bot_whoami")).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/Configured Slack identity/i);
    expect(Array.from(container.querySelectorAll("summary")).some((summary) =>
      summary.textContent?.match(/reinstall/i),
    )).toBe(true);
  });

  it("re-checks configured metadata after updating an already-persisted identity", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    actionFor("slack_bot_whoami").mockResolvedValue({
      data: {
        label: "Release Bot",
        teamId: "T0123456789",
        appId: "A0123456789",
        botUserId: "U0123456789",
        hasDefaultChannel: false,
      },
    });
    actionFor("create-slack-app-manifest").mockResolvedValue({
      agentId: "agent-0",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      state: "state-update",
      manifest: '{"name":"slack-demo"}',
      createAppUrl: "https://api.slack.com/apps?new_app=1",
      label: "Release Bot",
      eventsRequestUrl: EVENTS_REQUEST_URL,
    });
    actionFor("save-slack-install-metadata").mockResolvedValue({
      agentId: "agent-0",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789",
      eventsRequestUrl: EVENTS_REQUEST_URL,
      botTokenSecretId: BOT_TOKEN_SECRET_ID,
      signingSecretId: SIGNING_SECRET_ID,
      status: "saved",
    });

    await openSlackEditDialog();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(actionFor("slack_bot_whoami")).toHaveBeenCalledTimes(1);

    expect(Array.from(container.querySelectorAll("button")).some((button) =>
      button.textContent === "Create Slack App manifest",
    )).toBe(false);
    change(
      container.querySelector('input[placeholder="https://your-public-tunnel.example/events"]'),
      EVENTS_REQUEST_URL,
    );
    const reinstallSummary = Array.from(container.querySelectorAll("summary")).find((summary) =>
      summary.textContent?.match(/reinstall/i),
    );
    click(reinstallSummary ?? null);
    const reinstallButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent === "Reinstall",
    );
    await act(async () => {
      click(reinstallButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });
    change(
      container.querySelector('input[placeholder="Company secret UUID containing the Slack bot token"]'),
      BOT_TOKEN_SECRET_ID,
    );
    change(
      container.querySelector('input[placeholder="Company secret UUID containing the Slack signing secret"]'),
      SIGNING_SECRET_ID,
    );

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent === "Save Slack install metadata",
    );
    await act(async () => {
      click(saveButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("save-slack-install-metadata")).toHaveBeenCalledTimes(1);
    expect(actionFor("slack_bot_whoami")).toHaveBeenCalledTimes(2);
  });
});

describe("Slack reinstall action", () => {
  it("keeps an existing identity on the confirmation-gated reinstall path after rebinding its agent", async () => {
    actionFor("slack_bot_whoami").mockResolvedValue({ error: "No Slack identity bound for this agent." });
    bridgeData = baseBridgeData([slackIdentityEntry()]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderSettingsPage();
    const editButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent === "Edit",
    );
    click(editButton ?? null);

    const agentSelect = Array.from(container.querySelectorAll("select")).find((select) =>
      select.querySelector('option[value="agent-1"]'),
    );
    change(agentSelect ?? null, "agent-1");
    expect(text()).toContain("Edit agent identity");

    const nextButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent === "Next",
    );
    click(nextButton ?? null);
    change(
      container.querySelector('input[placeholder="https://your-public-tunnel.example/events"]'),
      EVENTS_REQUEST_URL,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(Array.from(container.querySelectorAll("button")).some((button) =>
      button.textContent === "Create Slack App manifest",
    )).toBe(false);
    const reinstallSummary = Array.from(container.querySelectorAll("summary")).find((summary) =>
      summary.textContent?.match(/reinstall/i),
    );
    expect(reinstallSummary).not.toBeUndefined();
    click(reinstallSummary ?? null);

    const reinstallButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent === "Reinstall",
    );
    await act(async () => {
      click(reinstallButton ?? null);
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(actionFor("create-slack-app-manifest")).not.toHaveBeenCalled();
  });

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
      eventsRequestUrl: EVENTS_REQUEST_URL,
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    await openSlackEditDialog();

    expect(Array.from(container.querySelectorAll("button")).some((button) =>
      button.textContent === "Create Slack App manifest",
    )).toBe(false);
    change(
      container.querySelector('input[placeholder="https://your-public-tunnel.example/events"]'),
      EVENTS_REQUEST_URL,
    );

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
    expect(actionFor("create-slack-app-manifest")).toHaveBeenCalledWith(expect.objectContaining({
      eventsRequestUrl: EVENTS_REQUEST_URL,
    }));
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
    expect(confirmMessage).toMatch(/Add identity/i);
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
    expect(confirmMessage).toMatch(/Add identity/i);
    expect(confirmMessage).not.toMatch(/Slack/i);
  });
});
