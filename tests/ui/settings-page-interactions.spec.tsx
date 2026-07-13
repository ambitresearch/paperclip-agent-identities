// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// React 19's act() checks this global to confirm the host environment wants
// act-wrapped updates batched/flushed synchronously (see
// https://react.dev/warnings/react-dom-test-utils). jsdom doesn't set it
// automatically the way a full testing-library setup would.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's browser-shimmed "node:os" (via vite's externalization for browser
// compatibility) doesn't provide a working `homedir()`, which
// src/providers/github/credentials.ts calls at module-eval time via
// src/credential-sidecar.ts. Stub it so importing SettingsPage (which pulls
// in the full provider composition root for the settings-adapter registry)
// doesn't crash under jsdom -- this plugin only ever runs its worker code in
// Node, so this is purely a test-environment shim, not a behavior change.
// jsdom's browser-shimmed "node:os"/"node:path"/"node:fs/promises"/"node:crypto"
// (via vite's externalization for browser compatibility) don't provide
// working implementations, and src/credential-sidecar.ts (pulled in
// transitively through src/providers/index.ts -> github/credentials.ts, which
// SettingsPage imports for the settings-adapter registry) calls them at
// module-eval time. Stub the whole module -- this plugin only ever runs its
// credential-sidecar code in Node (the worker), so this is purely a
// test-environment shim for importing SettingsPage under jsdom, not a
// behavior change.
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

// Mock the plugin-sdk UI hooks entirely: SettingsPage is a Settings-page
// plugin component whose data/actions come from the Paperclip host bridge
// (usePluginData/usePluginAction), which isn't available outside a running
// host. We provide an in-memory harness so the component can be exercised
// exactly the way the host would drive it -- via provider selection,
// creating a manifest, saving install metadata, and deleting an identity --
// without needing the real bridge/network.
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

beforeEach(() => {
  bridgeData = baseBridgeData();
  actionHandlers.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  // Empty companyId keeps the secrets-loading effect a no-op (see
  // SettingsPage's `if (!companyId) { ...; return; }` branch), and no
  // fetch() call needs to be mocked for these interaction tests.
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

function setValue(el: Element | null, value: string) {
  if (!el) throw new Error("element not found");
  const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const proto = input instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : input instanceof HTMLSelectElement
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

function openNewIdentityDialog() {
  const newButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "New identity");
  click(newButton ?? null);
}

describe("SettingsPage interactions: setup launch", () => {
  it("opens the wizard on the first ('Identity') step when starting a new identity", () => {
    renderSettingsPage();
    openNewIdentityDialog();

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(text()).toContain("Add agent identity");
    // First wizard step indicator should be "Identity" for the default (GitHub) provider.
    expect(text()).toContain("Identity");
    expect(text()).toContain("GitHub App");
  });

  it("switches the wizard step list when the Slack provider is selected", () => {
    renderSettingsPage();
    openNewIdentityDialog();

    const providerSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === SLACK_IDENTITY_PROVIDER_ID),
    );
    setValue(providerSelect ?? null, SLACK_IDENTITY_PROVIDER_ID);

    // Slack's wizard step list ("identity", "slack") replaces GitHub's
    // ("identity", "github", "commit") -- driven by the settings-adapter
    // registry rather than a provider-id branch inside the component. Check
    // the wizard step indicators specifically (the dialog's static intro
    // copy always mentions "GitHub App credential" regardless of provider).
    const stepLabels = Array.from(
      container.querySelectorAll('[aria-label="Identity setup progress"] > div'),
    ).map((el) => el.textContent);
    expect(stepLabels.some((label) => label?.includes("Slack App"))).toBe(true);
    expect(stepLabels.some((label) => label?.includes("GitHub App"))).toBe(false);
  });
});

describe("SettingsPage interactions: outcomes (manifest create success)", () => {
  it("shows the created GitHub App manifest panel after create-github-app-manifest succeeds", async () => {
    actionFor("create-github-app-manifest").mockResolvedValue({
      state: "state-1",
      manifest: '{"name":"demo"}',
      postUrl: "https://github.com/settings/apps/new",
      appName: "demo-app",
    });

    renderSettingsPage();
    openNewIdentityDialog();

    const agentSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "agent-1"),
    );
    setValue(agentSelect ?? null, "agent-1");
    const labelInput = Array.from(container.querySelectorAll("input")).find(
      (i) => i.placeholder?.includes("Cade Riven"),
    );
    setValue(labelInput ?? null, "Release Bot");

    const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
    click(nextButton ?? null);

    const createButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Create GitHub App on GitHub",
    );
    await act(async () => {
      click(createButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("create-github-app-manifest")).toHaveBeenCalled();
    expect(text()).toContain("Manifest ready for demo-app");
  });
});

describe("SettingsPage interactions: reinstall (resume a Slack manifest flow)", () => {
  it("restores an in-progress Slack manifest flow via the resume-state input", async () => {
    actionFor("get-slack-app-manifest-flow").mockResolvedValue({
      state: "resumed-state",
      manifest: '{"name":"slack-demo"}',
      createAppUrl: "https://api.slack.com/apps?new_app=1",
      agentId: "agent-1",
    });

    renderSettingsPage();
    openNewIdentityDialog();

    const agentSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "agent-1"),
    );
    setValue(agentSelect ?? null, "agent-1");
    const providerSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === SLACK_IDENTITY_PROVIDER_ID),
    );
    setValue(providerSelect ?? null, SLACK_IDENTITY_PROVIDER_ID);
    const labelInput = Array.from(container.querySelectorAll("input")).find(
      (i) => i.placeholder?.includes("Cade Riven"),
    );
    setValue(labelInput ?? null, "Release Bot");

    const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
    click(nextButton ?? null);

    const resumeInput = Array.from(container.querySelectorAll("input")).find((i) =>
      i.placeholder?.includes("pc_..."),
    );
    setValue(resumeInput ?? null, "resumed-state");

    const restoreButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Restore flow");
    await act(async () => {
      click(restoreButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("get-slack-app-manifest-flow")).toHaveBeenCalledWith({ state: "resumed-state" });
    expect(text()).toContain("slack-demo");
  });
});

describe("SettingsPage interactions: removal", () => {
  it("calls delete-bot-identity-config when confirming deletion of an existing identity", async () => {
    bridgeData["bot-identity-config"] = {
      identities: [
        {
          id: "id-1",
          agentId: "agent-1",
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
    vi.spyOn(window, "confirm").mockReturnValue(true);
    actionFor("delete-bot-identity-config").mockResolvedValue({});

    renderSettingsPage();

    const deleteButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Delete");
    await act(async () => {
      click(deleteButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("delete-bot-identity-config")).toHaveBeenCalledWith({
      agentId: "agent-1",
      provider: GITHUB_IDENTITY_PROVIDER_ID,
    });
  });
});
