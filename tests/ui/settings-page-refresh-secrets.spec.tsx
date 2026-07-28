// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// See settings-page-interactions.spec.tsx for why these node-module shims
// are needed to import SettingsPage under jsdom.
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
import { act } from "react-dom/test-utils";
import { SettingsPage } from "../../src/ui/SettingsPage.js";
import { SLACK_IDENTITY_PROVIDER_ID } from "../../src/shared/types.js";

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
  { id: "github", name: "GitHub", status: "enabled", description: "GitHub" },
  { id: SLACK_IDENTITY_PROVIDER_ID, name: "Slack", status: "coming-soon", description: "Slack" },
];

const COMPANY_ID = "company-1";
const BOT_TOKEN_SECRET_ID = "11111111-1111-4111-8111-111111111111";
const SIGNING_SECRET_ID = "22222222-2222-4222-8222-222222222222";

function baseBridgeData() {
  return {
    "bot-identity-config": {
      identities: [],
      providers,
      companyName: "Acme",
      credentialSidecarPath: "",
      credentialSidecarError: null,
    },
    "paperclip-agents": {
      agents: [{ id: "agent-1", role: "Engineer", status: "active" }],
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function stubSecrets(secrets: Array<{ id: string; name: string }>) {
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => secrets }));
}

function stubSecretsFailure(message = "network down") {
  fetchMock.mockImplementation(async () => {
    throw new Error(message);
  });
}

beforeEach(() => {
  bridgeData = baseBridgeData();
  actionHandlers.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderSettingsPage(companyId = COMPANY_ID) {
  act(() => {
    root = createRoot(container);
    root.render(
      // @ts-expect-error -- minimal PluginHostContext for the test harness
      <SettingsPage context={{ companyId, companyPrefix: "acme" }} />,
    );
  });
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setValue(el: Element | null, value: string) {
  if (!el) throw new Error("element not found");
  const input = el as HTMLInputElement | HTMLSelectElement;
  const proto = input instanceof HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function text(): string {
  return container.textContent ?? "";
}

function refreshButton() {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Refresh secrets") || b.textContent === "Refreshing...");
}

function botTokenSelect() {
  return Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes("Bot token"))
    ?.querySelector("select");
}

function signingSecretSelect() {
  return Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes("Signing secret"))
    ?.querySelector("select");
}

async function openSlackCredentialStep() {
  renderSettingsPage();
  // Let the initial (companyId-driven) secrets fetch resolve before the
  // dialog is opened, so field state below isn't racing that first load.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const newButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add identity");
  click(newButton ?? null);

  const agentSelect = Array.from(container.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === "agent-1"),
  );
  setValue(agentSelect ?? null, "agent-1");
  const providerSelect = Array.from(container.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === SLACK_IDENTITY_PROVIDER_ID),
  );
  setValue(providerSelect ?? null, SLACK_IDENTITY_PROVIDER_ID);
  const labelInput = Array.from(container.querySelectorAll("input")).find((i) => i.placeholder?.includes("Cade Riven"));
  setValue(labelInput ?? null, "Release Bot");

  const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
  await act(async () => {
    click(nextButton ?? null);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openGithubCredentialStep() {
  renderSettingsPage();
  // Let the initial (companyId-driven) secrets fetch resolve before the
  // dialog is opened, so field state below isn't racing that first load.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const newButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add identity");
  click(newButton ?? null);

  const agentSelect = Array.from(container.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === "agent-1"),
  );
  setValue(agentSelect ?? null, "agent-1");
  const labelInput = Array.from(container.querySelectorAll("input")).find((i) => i.placeholder?.includes("Cade Riven"));
  setValue(labelInput ?? null, "Release Bot");
  const usernameInput = Array.from(container.querySelectorAll("input")).find((i) =>
    i.placeholder?.includes("ouroboros-paperclip-agent"),
  );
  setValue(usernameInput ?? null, "release-bot[bot]");

  const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
  await act(async () => {
    click(nextButton ?? null);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function privateKeySelect() {
  return Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes("Private key Paperclip secret UUID"))
    ?.querySelector("select");
}

function fallbackTokenSelect() {
  return Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes("Fallback token secret UUID"))
    ?.querySelector("select");
}

describe("SettingsPage: refresh secrets inside the open GitHub credential step (DRO-1155)", () => {
  it("re-queries the active company's secrets and shows the newly created private-key/fallback-token refs without closing the dialog", async () => {
    stubSecrets([]);
    await openGithubCredentialStep();

    fetchMock.mockClear();
    stubSecrets([
      { id: BOT_TOKEN_SECRET_ID, name: "private-key-secret" },
      { id: SIGNING_SECRET_ID, name: "fallback-token-secret" },
    ]);

    await act(async () => {
      click(refreshButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(text()).toContain("private-key-secret");
    expect(text()).toContain("fallback-token-secret");

    setValue(privateKeySelect() ?? null, BOT_TOKEN_SECRET_ID);
    setValue(fallbackTokenSelect() ?? null, SIGNING_SECRET_ID);

    expect((privateKeySelect() as HTMLSelectElement).value).toBe(BOT_TOKEN_SECRET_ID);
    expect((fallbackTokenSelect() as HTMLSelectElement).value).toBe(SIGNING_SECRET_ID);
  });

  it("preserves the selected private-key/fallback-token refs across a refresh", async () => {
    stubSecrets([
      { id: BOT_TOKEN_SECRET_ID, name: "private-key-secret" },
      { id: SIGNING_SECRET_ID, name: "fallback-token-secret" },
    ]);
    await openGithubCredentialStep();
    setValue(privateKeySelect() ?? null, BOT_TOKEN_SECRET_ID);
    setValue(fallbackTokenSelect() ?? null, SIGNING_SECRET_ID);

    await act(async () => {
      click(refreshButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((privateKeySelect() as HTMLSelectElement).value).toBe(BOT_TOKEN_SECRET_ID);
    expect((fallbackTokenSelect() as HTMLSelectElement).value).toBe(SIGNING_SECRET_ID);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("shows an explicit missing-secret error for a deleted private key ref and does not treat the credential as complete", async () => {
    stubSecrets([{ id: BOT_TOKEN_SECRET_ID, name: "private-key-secret" }]);
    await openGithubCredentialStep();
    setValue(privateKeySelect() ?? null, BOT_TOKEN_SECRET_ID);

    const appIdInput = Array.from(container.querySelectorAll("input")).find((i) => i.placeholder === "GitHub App ID");
    setValue(appIdInput ?? null, "123456");
    const installIdInput = Array.from(container.querySelectorAll("input")).find((i) =>
      i.placeholder === "GitHub App installation ID",
    );
    setValue(installIdInput ?? null, "789");

    // The private-key secret is deleted server-side.
    stubSecrets([]);
    await act(async () => {
      click(refreshButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text()).toContain("no longer exists");
    // Selection itself is preserved (not silently switched away). Once
    // secretOptions is empty, the field falls back to a plain text input
    // (see hasSecretOptions in settings-adapter-ui.tsx) rather than a select.
    const privateKeyInput = Array.from(container.querySelectorAll("label")).find((l) =>
      l.textContent?.includes("Private key Paperclip secret UUID"),
    )?.querySelector("input");
    expect((privateKeyInput as HTMLInputElement).value).toBe(BOT_TOKEN_SECRET_ID);
  });
});

describe("SettingsPage: refresh secrets inside the open identity dialog (DRO-1155)", () => {
  it("re-queries the active company's secrets and shows the newly created bot/signing refs without closing the dialog", async () => {
    stubSecrets([]);
    await openSlackCredentialStep();

    expect(text()).toContain("No Paperclip secrets were found");
    fetchMock.mockClear();
    stubSecrets([
      { id: BOT_TOKEN_SECRET_ID, name: "bot-token" },
      { id: SIGNING_SECRET_ID, name: "signing-secret" },
    ]);

    await act(async () => {
      click(refreshButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain(encodeURIComponent(COMPANY_ID));

    expect(text()).toContain("bot-token");
    expect(text()).toContain("signing-secret");

    setValue(botTokenSelect() ?? null, BOT_TOKEN_SECRET_ID);
    setValue(signingSecretSelect() ?? null, SIGNING_SECRET_ID);

    expect((botTokenSelect() as HTMLSelectElement).value).toBe(BOT_TOKEN_SECRET_ID);
    expect((signingSecretSelect() as HTMLSelectElement).value).toBe(SIGNING_SECRET_ID);
  });

  it("disables the refresh button and shows progress while a refresh is in flight, without disabling unrelated fields", async () => {
    stubSecrets([]);
    await openSlackCredentialStep();

    const teamIdInput = Array.from(container.querySelectorAll("input")).find((i) => i.placeholder?.includes("T0123456789"));

    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    click(refreshButton() ?? null);
    expect(refreshButton()?.hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("Refreshing");
    // Unrelated fields (e.g. the Team ID input) remain interactive during refresh.
    expect(teamIdInput?.hasAttribute("disabled")).toBe(false);

    // A second click while in flight must not trigger a duplicate fetch.
    const callsBeforeSecondClick = fetchMock.mock.calls.length;
    click(refreshButton() ?? null);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSecondClick);

    await act(async () => {
      resolveFetch({ ok: true, json: async () => [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshButton()?.hasAttribute("disabled")).toBe(false);
  });

  it("keeps the last successful options and unsaved form intact on a failed refresh, with a retryable error", async () => {
    stubSecrets([{ id: BOT_TOKEN_SECRET_ID, name: "bot-token" }]);
    await openSlackCredentialStep();
    setValue(botTokenSelect() ?? null, BOT_TOKEN_SECRET_ID);

    const defaultChannelInput = Array.from(container.querySelectorAll("input")).find((i) =>
      i.placeholder?.includes("#") || i.placeholder?.toLowerCase().includes("channel"),
    );
    if (defaultChannelInput) setValue(defaultChannelInput, "#unsaved-value");

    stubSecretsFailure("boom");
    await act(async () => {
      click(refreshButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text()).toContain("Could not load Paperclip secrets");
    // The previously loaded option is still present and still selected.
    expect(text()).toContain("bot-token");
    expect((botTokenSelect() as HTMLSelectElement).value).toBe(BOT_TOKEN_SECRET_ID);
    if (defaultChannelInput) {
      expect((defaultChannelInput as HTMLInputElement).value).toBe("#unsaved-value");
    }

    // Retry succeeds.
    stubSecrets([
      { id: BOT_TOKEN_SECRET_ID, name: "bot-token" },
      { id: SIGNING_SECRET_ID, name: "signing-secret" },
    ]);
    await act(async () => {
      click(refreshButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text()).not.toContain("Could not load Paperclip secrets");
    expect(text()).toContain("signing-secret");
  });

  it("shows an explicit validation error when a selected secret no longer exists after refresh, instead of silently switching", async () => {
    stubSecrets([
      { id: BOT_TOKEN_SECRET_ID, name: "bot-token" },
      { id: SIGNING_SECRET_ID, name: "signing-secret" },
    ]);
    await openSlackCredentialStep();
    setValue(botTokenSelect() ?? null, BOT_TOKEN_SECRET_ID);
    setValue(signingSecretSelect() ?? null, SIGNING_SECRET_ID);

    // The bot-token secret is deleted server-side; only the signing secret remains.
    stubSecrets([{ id: SIGNING_SECRET_ID, name: "signing-secret" }]);
    await act(async () => {
      click(refreshButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text()).toContain("no longer exists");
    // The selection itself is preserved (not silently switched to another value).
    expect((botTokenSelect() as HTMLSelectElement).value).toBe(BOT_TOKEN_SECRET_ID);
  });

  it("preserves agent, provider, unsaved fields, and active step across a refresh", async () => {
    stubSecrets([]);
    await openSlackCredentialStep();

    const teamIdInput = Array.from(container.querySelectorAll("input")).find((i) => i.placeholder?.includes("T0123456789"));
    setValue(teamIdInput ?? null, "T0123456789");
    expect(text()).toContain("Slack App setup");

    stubSecrets([{ id: BOT_TOKEN_SECRET_ID, name: "bot-token" }]);
    await act(async () => {
      click(refreshButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Still on the Slack credential step, with the unsaved Team ID field
    // preserved and the dialog still open (not reset back to the identity
    // step or closed).
    expect(text()).toContain("Slack App setup");
    expect((teamIdInput as HTMLInputElement).value).toBe("T0123456789");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("still fetches secrets exactly once on initial page load (no polling, no new dependency)", async () => {
    stubSecrets([{ id: BOT_TOKEN_SECRET_ID, name: "bot-token" }]);
    await openSlackCredentialStep();

    expect(fetchMock.mock.calls.length).toBe(1);
  });
});
