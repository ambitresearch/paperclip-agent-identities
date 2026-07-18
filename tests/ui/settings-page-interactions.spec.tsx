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

const EVENTS_REQUEST_URL = "https://paperclip-test.trycloudflare.com/events";
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
  const newButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add identity");
  click(newButton ?? null);
}

describe("SettingsPage interactions: setup launch", () => {
  it("keeps the settings page focused on configured identities", () => {
    renderSettingsPage();

    expect(text()).toContain("Configured identities");
    expect(text()).not.toContain("GitHub Apps");
    expect(text()).not.toContain("GitHub App setup");
    expect(text()).not.toContain("Environment propagation");
    expect(container.querySelector('nav[aria-label="Agent identity settings sections"]')).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "Add identity")).toHaveLength(1);
    expect(text()).not.toContain("New identity");
  });

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

  it("mounts the active provider's credential-step fieldset from the UI registry, not a provider-id branch (findings #5/#10/#19)", () => {
    renderSettingsPage();
    openNewIdentityDialog();

    const agentSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "agent-1"),
    );
    setValue(agentSelect ?? null, "agent-1");

    // Default (GitHub) provider: advancing to the credential step renders the
    // GitHub-owned fieldset.
    const nextToGitHub = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
    click(nextToGitHub ?? null);
    expect(text()).toContain("GitHub App");

    // Return to the identity step to switch providers.
    const prevButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Previous");
    click(prevButton ?? null);

    // Switch to Slack and advance: the Slack-owned credential fieldset legend
    // ("Slack App setup") is mounted in its place -- proving the shared page
    // selected the step component via the registry keyed off the active
    // provider rather than an `=== SLACK_IDENTITY_PROVIDER_ID` branch.
    const providerSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === SLACK_IDENTITY_PROVIDER_ID),
    );
    setValue(providerSelect ?? null, SLACK_IDENTITY_PROVIDER_ID);
    const nextToSlack = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
    click(nextToSlack ?? null);
    expect(text()).toContain("Slack App setup");
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
      eventsRequestUrl: EVENTS_REQUEST_URL,
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
    expect(fieldByPlaceholder("https://your-public-tunnel.example/events")?.value).toBe(EVENTS_REQUEST_URL);
    expect(text()).toContain("slack-demo");
  });
});

describe("SettingsPage interactions: GitHub OAuth callback restore (DRO-1025)", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("reopens the wizard and restores the form when the dialog was closed on callback page load (finding: patchFormState silent no-op)", async () => {
    // Simulate a fresh page load: no dialog open (formState is null), and the
    // browser landed on GitHub's manifest callback URL.
    window.history.pushState(null, "", "/?code=abc123&installation_id=999&state=pc_test-state");

    actionFor("get-github-app-manifest-flow").mockResolvedValue({
      state: "pc_test-state",
      agentId: "agent-1",
      provider: GITHUB_IDENTITY_PROVIDER_ID,
      manifest: '{"name":"demo"}',
      postUrl: "https://github.com/settings/apps/new",
      setupUrl: "https://github.com/settings/apps/demo",
      createdAt: new Date().toISOString(),
      label: "Release Bot",
      appName: "demo-app",
      conversion: {
        agentId: "agent-1",
        provider: GITHUB_IDENTITY_PROVIDER_ID,
        appId: "app-123",
        appSlug: "demo-app",
        appName: "demo-app",
        githubUsername: "demo-app[bot]",
        privateKeyFile: "/tmp/private-key.pem",
        installUrl: "https://github.com/apps/demo-app/installations/new",
      },
    });

    renderSettingsPage();

    // No dialog should be open yet (formState starts null).
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("get-github-app-manifest-flow")).toHaveBeenCalledWith({ state: "pc_test-state" });
    // The wizard must reopen with the restored state -- previously
    // patchFormState's `prev ? patch(prev) : prev` silently no-op'd here
    // because formState was null, so the dialog never appeared.
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    // Restored conversion data (appId) should already be prefilled on the
    // GitHub credential step.
    const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
    click(nextButton ?? null);
    const appIdInput = Array.from(container.querySelectorAll("input")).find((i) => i.value === "app-123");
    expect(appIdInput).not.toBeUndefined();
  });

  it("preserves fallbackTokenSecretId and tokenFile from the sessionStorage draft through the manifest restore (finding: normalizer dropped fallback fields)", async () => {
    window.sessionStorage.setItem(
      "paperclip-agent-identities:github-app-manifest-draft:pc_test-state-2",
      JSON.stringify({
        agentId: "agent-1",
        provider: GITHUB_IDENTITY_PROVIDER_ID,
        label: "Release Bot",
        githubUsername: "",
        commitName: "",
        commitEmail: "",
        githubAppId: "",
        githubInstallationId: "",
        privateKeySecretId: "",
        privateKeyFile: "",
        fallbackTokenSecretId: "fallback-secret-uuid",
        tokenFile: "/tmp/fallback.token",
        previousAgentId: "",
        previousGithubAppId: "",
        previousGithubInstallationId: "",
        previousPrivateKeySecretId: "",
        previousPrivateKeyFile: "",
      }),
    );
    window.history.pushState(null, "", "/?installation_id=999&state=pc_test-state-2");

    actionFor("get-github-app-manifest-flow").mockResolvedValue({
      state: "pc_test-state-2",
      agentId: "agent-1",
      provider: GITHUB_IDENTITY_PROVIDER_ID,
      manifest: '{"name":"demo"}',
      postUrl: "https://github.com/settings/apps/new",
      setupUrl: "https://github.com/settings/apps/demo",
      createdAt: new Date().toISOString(),
      label: "Release Bot",
      appName: "demo-app",
    });

    renderSettingsPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Advance to the GitHub credential step to read back the restored fields.
    const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
    click(nextButton ?? null);

    const fallbackSecretInput = Array.from(container.querySelectorAll("input")).find(
      (i) => i.value === "fallback-secret-uuid",
    );
    const tokenFileInput = Array.from(container.querySelectorAll("input")).find(
      (i) => i.value === "/tmp/fallback.token",
    );
    expect(fallbackSecretInput).not.toBeUndefined();
    expect(tokenFileInput).not.toBeUndefined();
  });
});

function fieldByPlaceholder(placeholder: string): HTMLInputElement | undefined {
  return Array.from(container.querySelectorAll("input")).find(
    (i) => i.placeholder?.includes(placeholder),
  ) as HTMLInputElement | undefined;
}

async function openSlackWizardOnCredentialStep() {
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
  const labelInput = fieldByPlaceholder("Cade Riven");
  setValue(labelInput ?? null, "Release Bot");

  const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
  click(nextButton ?? null);

  setValue(fieldByPlaceholder("https://your-public-tunnel.example/events") ?? null, EVENTS_REQUEST_URL);

  actionFor("create-slack-app-manifest").mockResolvedValue({
    agentId: "agent-1",
    provider: SLACK_IDENTITY_PROVIDER_ID,
    state: "state-1",
    manifest: '{"name":"slack-demo"}',
    createAppUrl: "https://api.slack.com/apps?new_app=1",
    label: "Release Bot",
    eventsRequestUrl: EVENTS_REQUEST_URL,
  });
  const createButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Create Slack App manifest",
  );
  await act(async () => {
    click(createButton ?? null);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(actionFor("create-slack-app-manifest")).toHaveBeenCalledWith({
    agentId: "agent-1",
    provider: SLACK_IDENTITY_PROVIDER_ID,
    label: "Release Bot",
    eventsRequestUrl: EVENTS_REQUEST_URL,
  });

  setValue(fieldByPlaceholder("T0123456789") ?? null, "T0123456789");
  setValue(fieldByPlaceholder("A0123456789") ?? null, "A0123456789");
  setValue(fieldByPlaceholder("U0123456789") ?? null, "U0123456789");
  const secretInput = fieldByPlaceholder("Company secret UUID containing the Slack bot token");
  setValue(secretInput ?? null, BOT_TOKEN_SECRET_ID);
  const signingSecretInput = fieldByPlaceholder("Company secret UUID containing the Slack signing secret");
  setValue(signingSecretInput ?? null, SIGNING_SECRET_ID);
}

function slackSaveButton() {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Save Slack install metadata" || b.textContent === "Saving...",
  );
}

describe("SettingsPage interactions: save-slack-install-metadata", () => {
  it("detects workspace, app, and bot IDs from the selected bot token secret", async () => {
    await openSlackWizardOnCredentialStep();
    actionFor("discover-slack-install-metadata").mockResolvedValue({
      teamId: "T0DETECTED",
      appId: "A0DETECTED",
      botUserId: "U0DETECTED",
    });

    const detectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Detect Slack installation IDs",
    );
    await act(async () => {
      click(detectButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("discover-slack-install-metadata")).toHaveBeenCalledWith({
      botTokenSecretId: BOT_TOKEN_SECRET_ID,
    });
    expect(fieldByPlaceholder("T0123456789")?.value).toBe("T0DETECTED");
    expect(fieldByPlaceholder("https://api.slack.com/apps/")?.value).toBe("A0DETECTED");
    expect(fieldByPlaceholder("U0123456789")?.value).toBe("U0DETECTED");
  });

  it("surfaces an actionable Slack bridge error when metadata discovery needs a reinstall", async () => {
    await openSlackWizardOnCredentialStep();
    actionFor("discover-slack-install-metadata").mockRejectedValue({
      code: "WORKER_ERROR",
      message: "Slack App ID discovery failed: missing_scope. Apply the latest generated manifest, reinstall the app to grant users:read, then retry.",
    });

    const detectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Detect Slack installation IDs",
    );
    await act(async () => {
      click(detectButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text()).toContain("Apply the latest generated manifest, reinstall the app to grant users:read, then retry.");
  });

  it("extracts the App ID when the Slack app settings URL is pasted", async () => {
    await openSlackWizardOnCredentialStep();
    const appIdInput = fieldByPlaceholder("https://api.slack.com/apps/");
    setValue(appIdInput ?? null, "https://api.slack.com/apps/A0BHV2SA8E6/general?");
    expect(appIdInput?.value).toBe("A0BHV2SA8E6");
  });

  it("shows the saved confirmation after a successful save", async () => {
    await openSlackWizardOnCredentialStep();
    expect(text()).toContain("Do not verify the Request URL in Slack yet");
    actionFor("save-slack-install-metadata").mockResolvedValue({
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789",
      eventsRequestUrl: EVENTS_REQUEST_URL,
      botTokenSecretId: BOT_TOKEN_SECRET_ID,
      signingSecretId: SIGNING_SECRET_ID,
      status: "saved",
    });

    await act(async () => {
      click(slackSaveButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("save-slack-install-metadata")).toHaveBeenCalledWith(expect.objectContaining({
      botTokenSecretId: BOT_TOKEN_SECRET_ID,
      signingSecretId: SIGNING_SECRET_ID,
    }));
    expect(text()).toContain("Slack install metadata saved for team T0123456789");
    expect(text()).toContain("Return to Slack's App Manifest page now");
    expect(text()).not.toContain("Create the manifest above first");
  });

  it("shows an error when save-slack-install-metadata fails", async () => {
    await openSlackWizardOnCredentialStep();
    actionFor("save-slack-install-metadata").mockRejectedValue(new Error("boom"));

    await act(async () => {
      click(slackSaveButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text()).toContain("boom");
    expect(text()).not.toContain("Slack install metadata saved for team");
  });

  it("does not falsely mark the flow complete when a field is edited while a save is in-flight", async () => {
    await openSlackWizardOnCredentialStep();
    let resolveSave!: (value: unknown) => void;
    actionFor("save-slack-install-metadata").mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    act(() => {
      click(slackSaveButton() ?? null);
    });
    expect(text()).toContain("Saving...");

    // Edit a Slack field while the save is still in flight -- this must
    // invalidate the pending save so its (still unresolved) response can
    // never be applied against the now-different field value.
    setValue(fieldByPlaceholder("T0123456789") ?? null, "T_DIFFERENT_TEAM");

    await act(async () => {
      resolveSave({
        agentId: "agent-1",
        provider: SLACK_IDENTITY_PROVIDER_ID,
        teamId: "T0123456789",
        appId: "A0123456789",
        botUserId: "U0123456789",
        eventsRequestUrl: EVENTS_REQUEST_URL,
        botTokenSecretId: BOT_TOKEN_SECRET_ID,
        signingSecretId: SIGNING_SECRET_ID,
        status: "saved",
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The edit already cleared slackSaveBusy synchronously; the late
    // response resolving afterward must not resurrect a "saved" state for
    // the edited (now-different) team ID.
    expect(text()).not.toContain("Slack install metadata saved for team T0123456789.");
    expect(text()).not.toContain("Saving...");
  });
});

describe("SettingsPage interactions: retry safety while save-slack-install-metadata is in flight (DRO-1053 finding #1)", () => {
  it("disables Slack field inputs, provider/agent/label fields, and dialog navigation while a save is in flight", async () => {
    await openSlackWizardOnCredentialStep();
    actionFor("save-slack-install-metadata").mockReturnValue(new Promise(() => {
      // Never resolves for this test -- we only assert on the disabled state
      // while the save is in flight.
    }));

    act(() => {
      click(slackSaveButton() ?? null);
    });
    expect(text()).toContain("Saving...");

    // Slack credential-step fields must be locked so an edit can't
    // invalidate the in-flight save's result once it comes back.
    expect(fieldByPlaceholder("T0123456789")?.disabled).toBe(true);
    expect(fieldByPlaceholder("A0123456789")?.disabled).toBe(true);
    expect(fieldByPlaceholder("U0123456789")?.disabled).toBe(true);
    expect(fieldByPlaceholder("Company secret UUID containing the Slack bot token")?.disabled).toBe(true);
    expect(fieldByPlaceholder("Company secret UUID containing the Slack signing secret")?.disabled).toBe(true);

    // Navigation that would let the operator leave/alter the identity while
    // the save is still resolving must also be locked.
    const previousButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Previous");
    const cancelButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Cancel");
    const closeButton = container.querySelector('[aria-label="Close identity editor"]') as HTMLButtonElement | null;
    expect((previousButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
    expect((cancelButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
    expect(closeButton?.disabled).toBe(true);
  });
});

describe("SettingsPage interactions: cleanup-only retry after a failed rename rebind (DRO-1053 finding #2)", () => {
  it("offers a cleanup-only retry (not a re-save) when deleteConfig(previousAgentId) fails after a successful save, and completes without re-calling save-slack-install-metadata", async () => {
    // Simulate editing an existing Slack identity (rename): previousAgentId
    // differs from the current agentId, so a successful save triggers the
    // rebind-cleanup deleteConfig call.
    bridgeData["bot-identity-config"] = {
      identities: [
        {
          id: "id-1",
          agentId: "agent-0",
          provider: SLACK_IDENTITY_PROVIDER_ID,
          label: "Release Bot",
          slack: { teamId: "T0123456789", appId: "A0123456789", botUserId: "U0123456789" },
          credential: {},
          credentialStatus: "ok",
        },
      ],
      providers,
      companyName: "Acme",
      credentialSidecarPath: "",
      credentialSidecarError: null,
    };
    bridgeData["paperclip-agents"] = {
      agents: [
        { id: "agent-0", role: "Engineer", status: "active" },
        { id: "agent-1", role: "Engineer", status: "active" },
      ],
    };
    let targetAgentStatusChecks = 0;
    actionFor("slack_bot_whoami").mockImplementation(async ({ agentId }: { agentId: string }) => {
      if (agentId !== "agent-1") return { error: "No Slack identity bound for this agent." };
      targetAgentStatusChecks += 1;
      if (targetAgentStatusChecks === 1) {
        return { error: "No Slack identity bound for this agent." };
      }
      return {
        data: {
          label: "Release Bot",
          teamId: "T0123456789",
          appId: "A0123456789",
          botUserId: "U0123456789",
          hasDefaultChannel: false,
        },
      };
    });

    renderSettingsPage();
    const editButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Edit");
    click(editButton ?? null);

    // Rename to a different agent.
    const agentSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "agent-1"),
    );
    setValue(agentSelect ?? null, "agent-1");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(targetAgentStatusChecks).toBe(1);

    const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
    click(nextButton ?? null);
    expect(text()).toContain("Slack identity metadata unavailable");

    actionFor("create-slack-app-manifest").mockResolvedValue({
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      state: "state-1",
      manifest: '{"name":"slack-demo"}',
      createAppUrl: "https://api.slack.com/apps?new_app=1",
      label: "Release Bot",
      eventsRequestUrl: EVENTS_REQUEST_URL,
    });
    setValue(fieldByPlaceholder("https://your-public-tunnel.example/events") ?? null, EVENTS_REQUEST_URL);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const reinstallSummary = Array.from(container.querySelectorAll("summary")).find(
      (summary) => summary.textContent?.match(/reinstall/i),
    );
    click(reinstallSummary ?? null);
    const reinstallButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reinstall",
    );
    await act(async () => {
      click(reinstallButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    setValue(fieldByPlaceholder("T0123456789") ?? null, "T0123456789");
    setValue(fieldByPlaceholder("A0123456789") ?? null, "A0123456789");
    setValue(fieldByPlaceholder("U0123456789") ?? null, "U0123456789");
    setValue(
      fieldByPlaceholder("Company secret UUID containing the Slack bot token") ?? null,
      BOT_TOKEN_SECRET_ID,
    );
    setValue(
      fieldByPlaceholder("Company secret UUID containing the Slack signing secret") ?? null,
      SIGNING_SECRET_ID,
    );

    const savedResult = {
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789",
      eventsRequestUrl: EVENTS_REQUEST_URL,
      botTokenSecretId: BOT_TOKEN_SECRET_ID,
      signingSecretId: SIGNING_SECRET_ID,
      status: "saved",
    };
    actionFor("save-slack-install-metadata").mockResolvedValue(savedResult);
    actionFor("delete-bot-identity-config").mockRejectedValueOnce(new Error("network blip"));

    await act(async () => {
      click(slackSaveButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The save succeeded, but the rename cleanup failed: the UI must offer a
    // cleanup-only retry rather than telling the operator to redo the save
    // (whose one-time manifest `state` is already consumed).
    expect(actionFor("save-slack-install-metadata")).toHaveBeenCalledTimes(1);
    expect(actionFor("delete-bot-identity-config")).toHaveBeenCalledWith({
      agentId: "agent-0",
      provider: SLACK_IDENTITY_PROVIDER_ID,
    });
    expect(targetAgentStatusChecks).toBe(2);
    expect(actionFor("slack_bot_whoami")).toHaveBeenLastCalledWith({ agentId: "agent-1", companyId: "" });
    expect(text()).toContain("Configured Slack identity");
    expect(text()).not.toContain("Slack identity metadata unavailable");
    expect(text()).toContain("Retry cleanup");
    expect(text()).not.toContain("Slack install metadata saved for team T0123456789.");

    // Retry the cleanup only -- this must not re-invoke save-slack-install-metadata.
    actionFor("delete-bot-identity-config").mockResolvedValueOnce({});
    const retryButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Retry cleanup");
    await act(async () => {
      click(retryButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("save-slack-install-metadata")).toHaveBeenCalledTimes(1);
    expect(actionFor("delete-bot-identity-config")).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Slack install metadata saved for team T0123456789.");
    expect(text()).not.toContain("Retry cleanup");
  });

  it("locks dialog navigation while a cleanup-only retry is in flight (Copilot finding on settings-adapter-ui.tsx:454)", async () => {
    bridgeData["bot-identity-config"] = {
      identities: [
        {
          id: "id-1",
          agentId: "agent-0",
          provider: SLACK_IDENTITY_PROVIDER_ID,
          label: "Release Bot",
          slack: { teamId: "T0123456789", appId: "A0123456789", botUserId: "U0123456789" },
          credential: {},
          credentialStatus: "ok",
        },
      ],
      providers,
      companyName: "Acme",
      credentialSidecarPath: "",
      credentialSidecarError: null,
    };
    bridgeData["paperclip-agents"] = {
      agents: [
        { id: "agent-0", role: "Engineer", status: "active" },
        { id: "agent-1", role: "Engineer", status: "active" },
      ],
    };

    renderSettingsPage();
    const editButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Edit");
    click(editButton ?? null);

    const agentSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "agent-1"),
    );
    setValue(agentSelect ?? null, "agent-1");

    const nextButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next");
    click(nextButton ?? null);

    actionFor("create-slack-app-manifest").mockResolvedValue({
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      state: "state-1",
      manifest: '{"name":"slack-demo"}',
      createAppUrl: "https://api.slack.com/apps?new_app=1",
      label: "Release Bot",
      eventsRequestUrl: EVENTS_REQUEST_URL,
    });
    setValue(fieldByPlaceholder("https://your-public-tunnel.example/events") ?? null, EVENTS_REQUEST_URL);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const reinstallSummary = Array.from(container.querySelectorAll("summary")).find(
      (summary) => summary.textContent?.match(/reinstall/i),
    );
    click(reinstallSummary ?? null);
    const reinstallButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reinstall",
    );
    await act(async () => {
      click(reinstallButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    setValue(fieldByPlaceholder("T0123456789") ?? null, "T0123456789");
    setValue(fieldByPlaceholder("A0123456789") ?? null, "A0123456789");
    setValue(fieldByPlaceholder("U0123456789") ?? null, "U0123456789");
    setValue(
      fieldByPlaceholder("Company secret UUID containing the Slack bot token") ?? null,
      BOT_TOKEN_SECRET_ID,
    );
    setValue(
      fieldByPlaceholder("Company secret UUID containing the Slack signing secret") ?? null,
      SIGNING_SECRET_ID,
    );

    actionFor("save-slack-install-metadata").mockResolvedValue({
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789",
      eventsRequestUrl: EVENTS_REQUEST_URL,
      botTokenSecretId: BOT_TOKEN_SECRET_ID,
      signingSecretId: SIGNING_SECRET_ID,
      status: "saved",
    });
    actionFor("delete-bot-identity-config").mockRejectedValueOnce(new Error("network blip"));

    await act(async () => {
      click(slackSaveButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text()).toContain("Retry cleanup");

    // Start a never-resolving cleanup retry and assert that dialog
    // navigation is locked for its duration, the same way it is locked
    // during save-slack-install-metadata itself -- otherwise the operator
    // could navigate/edit the identity mid-retry and have its eventual
    // response land on a different form.
    actionFor("delete-bot-identity-config").mockReturnValue(new Promise(() => {}));
    const retryButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Retry cleanup");
    act(() => {
      click(retryButton ?? null);
    });
    expect(text()).toContain("Retrying...");

    const previousButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Previous");
    const cancelButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Cancel");
    const closeButton = container.querySelector('[aria-label="Close identity editor"]') as HTMLButtonElement | null;
    expect((previousButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
    expect((cancelButton as HTMLButtonElement | undefined)?.disabled).toBe(true);
    expect(closeButton?.disabled).toBe(true);
  });
});

describe("SettingsPage interactions: consumed manifest flow after a successful save (Copilot finding on settings-adapter-ui.tsx:423/439)", () => {
  it("does not allow re-submitting a save against an already-consumed manifest flow after a field edit", async () => {
    await openSlackWizardOnCredentialStep();
    actionFor("save-slack-install-metadata").mockResolvedValue({
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789",
      eventsRequestUrl: EVENTS_REQUEST_URL,
      botTokenSecretId: BOT_TOKEN_SECRET_ID,
      signingSecretId: SIGNING_SECRET_ID,
      status: "saved",
    });

    await act(async () => {
      click(slackSaveButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text()).toContain("Slack install metadata saved for team T0123456789.");

    // Editing a field after a successful save clears slackSaveResult (the
    // signature-invalidation effect) and re-enables the save button, but the
    // manifest flow's one-time `state` was already consumed by the save
    // above. The credential step must not present a submittable save button
    // pointed at that consumed flow -- it must require creating/restoring a
    // new manifest flow first.
    setValue(fieldByPlaceholder("T0123456789") ?? null, "T_DIFFERENT_TEAM");
    expect(text()).not.toContain("Slack install metadata saved for team");

    const saveButtonAfterEdit = slackSaveButton();
    expect((saveButtonAfterEdit as HTMLButtonElement | undefined)?.disabled).toBe(true);
    expect(text()).toContain("Create the manifest above first");
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
