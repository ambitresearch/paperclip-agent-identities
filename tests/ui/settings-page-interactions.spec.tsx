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

  actionFor("create-slack-app-manifest").mockResolvedValue({
    agentId: "agent-1",
    provider: SLACK_IDENTITY_PROVIDER_ID,
    state: "state-1",
    manifest: '{"name":"slack-demo"}',
    createAppUrl: "https://api.slack.com/apps?new_app=1",
    label: "Release Bot",
  });
  const createButton = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Create Slack App manifest",
  );
  await act(async () => {
    click(createButton ?? null);
    await Promise.resolve();
    await Promise.resolve();
  });

  setValue(fieldByPlaceholder("T0123456789") ?? null, "T0123456789");
  setValue(fieldByPlaceholder("A0123456789") ?? null, "A0123456789");
  setValue(fieldByPlaceholder("U0123456789") ?? null, "U0123456789");
  const secretInput = fieldByPlaceholder("Company secret UUID containing the Slack bot token");
  setValue(secretInput ?? null, "11111111-1111-4111-8111-111111111111");
}

function slackSaveButton() {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Save Slack install metadata" || b.textContent === "Saving...",
  );
}

describe("SettingsPage interactions: save-slack-install-metadata", () => {
  it("shows the saved confirmation after a successful save", async () => {
    await openSlackWizardOnCredentialStep();
    actionFor("save-slack-install-metadata").mockResolvedValue({
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789",
      botTokenSecretId: "11111111-1111-4111-8111-111111111111",
      status: "saved",
    });

    await act(async () => {
      click(slackSaveButton() ?? null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionFor("save-slack-install-metadata")).toHaveBeenCalled();
    expect(text()).toContain("Slack install metadata saved for team T0123456789");
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
        botTokenSecretId: "11111111-1111-4111-8111-111111111111",
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

    renderSettingsPage();
    const editButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Edit");
    click(editButton ?? null);

    // Rename to a different agent.
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
    });
    const createButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Create Slack App manifest",
    );
    await act(async () => {
      click(createButton ?? null);
      await Promise.resolve();
      await Promise.resolve();
    });

    setValue(fieldByPlaceholder("T0123456789") ?? null, "T0123456789");
    setValue(fieldByPlaceholder("A0123456789") ?? null, "A0123456789");
    setValue(fieldByPlaceholder("U0123456789") ?? null, "U0123456789");
    setValue(
      fieldByPlaceholder("Company secret UUID containing the Slack bot token") ?? null,
      "11111111-1111-4111-8111-111111111111",
    );

    const savedResult = {
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789",
      botTokenSecretId: "11111111-1111-4111-8111-111111111111",
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
