import { useEffect, useRef, useState } from "react";
import type { ProviderSettingsUIAdapter, ProviderSettingsUIHookInput, ProviderSettingsUIHookResult } from "../../core/provider-settings-ui-contract.js";
import {
  GITHUB_IDENTITY_PROVIDER_ID,
  DEFAULT_BOT_IDENTITY_CONFIG,
  type CreateGitHubAppManifestResult,
  type ConvertGitHubAppManifestResult,
  type GetGitHubAppManifestFlowResult,
  type BotIdentitySettingsEntry,
  type PaperclipAgentOption,
} from "../../shared/types.js";
import {
  errorStyle,
  fieldStyle,
  fieldsetStyle,
  formActionsStyle,
  formatSecretOption,
  getFallbackTokenSecretFieldHint,
  getSecretFieldHint,
  hintStyle,
  inlineNoticeStyle,
  inputStyle,
  legendStyle,
  linkStyle,
  manifestPanelStyle,
  secondaryButtonStyle,
  successStyle,
} from "../../ui/SettingsPage.js";

// The GitHub analogue of ./slack/settings-adapter-ui.tsx (see that module's
// header comment for the overall pattern this mirrors). GitHub's credential
// step previously lived inline in src/ui/SettingsPage.tsx, branching on
// config.provider === "github" -- the same architectural gap Copilot flagged
// against #63/#74 for Slack. Moving it here closes that gap for both
// providers: SettingsPage no longer owns any provider-specific manifest
// state, effects, or handlers, only the shared wizard chrome.
//
// Deliberately NOT importing from "./index.js" (the github provider's
// server-side composition, which pulls in app-manifest.ts's `node:crypto`
// usage) -- this module is client code (JSX/hooks are fine to import here,
// unlike settings-adapter.ts), but it must still avoid pulling server-only
// code into the client Settings UI bundle.

export interface GitHubSettingsUIFormConfig {
  agentId: string;
  provider: string;
  label: string;
  previousAgentId: string;
  githubUsername: string;
  commitName: string;
  commitEmail: string;
  githubAppId: string;
  githubInstallationId: string;
  privateKeySecretId: string;
  privateKeyFile: string;
  fallbackTokenSecretId: string;
  tokenFile: string;
  previousGithubAppId: string;
  previousGithubInstallationId: string;
  previousPrivateKeySecretId: string;
  previousPrivateKeyFile: string;
  [key: string]: string;
}

export interface GitHubSettingsUIHookResult extends ProviderSettingsUIHookResult {
  manifestFlow: CreateGitHubAppManifestResult | null;
  manifestBusy: boolean;
  manifestCode: string;
  setManifestCode: (value: string) => void;
  manifestError: string | null;
  manifestResult: ConvertGitHubAppManifestResult | null;
  handleCreateGitHubAppManifest: () => Promise<void>;
  handleConvertGitHubAppManifest: () => Promise<void>;
  updateField: (field: keyof GitHubSettingsUIFormConfig & string, value: string) => void;
  secretOptions: ReadonlyArray<{ id: string; name: string; key?: string; description?: string; provider?: string; status?: string }>;
  secretsLoading: boolean;
  secretsError: string | null;
  companyId: string;
}

const MANIFEST_DRAFT_STORAGE_PREFIX = "paperclip-agent-identities:github-app-manifest-draft:";

function getManifestDraftStorageKey(state: string): string {
  return MANIFEST_DRAFT_STORAGE_PREFIX + state;
}

function writeManifestDraftForm(state: string, formState: GitHubSettingsUIFormConfig): void {
  try {
    window.sessionStorage.setItem(getManifestDraftStorageKey(state), JSON.stringify(formState));
  } catch {
    // Redirect restoration is best-effort; the server-side manifest flow still restores required fields.
  }
}

function readManifestDraftForm(state: string): Partial<GitHubSettingsUIFormConfig> | null {
  try {
    const raw = window.sessionStorage.getItem(getManifestDraftStorageKey(state));
    if (!raw) return null;
    return normalizeManifestDraftForm(JSON.parse(raw));
  } catch {
    return null;
  }
}

function deleteManifestDraftForm(state: string): void {
  try {
    window.sessionStorage.removeItem(getManifestDraftStorageKey(state));
  } catch {
    // Ignore sessionStorage cleanup failures; stale drafts are scoped by opaque manifest state.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeManifestDraftForm(raw: unknown): Partial<GitHubSettingsUIFormConfig> | null {
  if (!isRecord(raw)) return null;
  return {
    agentId: readString(raw.agentId),
    provider: readString(raw.provider) || GITHUB_IDENTITY_PROVIDER_ID,
    label: readString(raw.label),
    githubUsername: readString(raw.githubUsername),
    commitName: readString(raw.commitName),
    commitEmail: readString(raw.commitEmail),
    githubAppId: readString(raw.githubAppId),
    githubInstallationId: readString(raw.githubInstallationId),
    privateKeySecretId: readString(raw.privateKeySecretId),
    privateKeyFile: readString(raw.privateKeyFile),
    fallbackTokenSecretId: readString(raw.fallbackTokenSecretId),
    tokenFile: readString(raw.tokenFile),
    previousAgentId: readString(raw.previousAgentId),
    previousGithubAppId: readString(raw.previousGithubAppId),
    previousGithubInstallationId: readString(raw.previousGithubInstallationId),
    previousPrivateKeySecretId: readString(raw.previousPrivateKeySecretId),
    previousPrivateKeyFile: readString(raw.previousPrivateKeyFile),
  };
}

function submitGitHubAppManifest(flow: CreateGitHubAppManifestResult) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = flow.postUrl;
  form.target = "_blank";
  form.setAttribute("rel", "noopener noreferrer");
  const manifest = document.createElement("input");
  manifest.type = "hidden";
  manifest.name = "manifest";
  manifest.value = flow.manifest;
  form.appendChild(manifest);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function getManifestReturnUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("installation_id");
  url.searchParams.delete("setup_action");
  url.searchParams.delete("state");
  url.searchParams.set("githubAppManifest", "1");
  return url.toString();
}

function getAgentDashboardUrl(agentId: string): string {
  const url = new URL(window.location.href);
  const companySegment = url.pathname.split("/").filter(Boolean)[0];
  const agentSegment = encodeURIComponent(agentId);
  url.pathname = companySegment
    ? `/${encodeURIComponent(companySegment)}/agents/${agentSegment}/dashboard`
    : `/agents/${agentSegment}/dashboard`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function getManifestCallbackParams(): { code?: string; installationId?: string; state: string } | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code")?.trim();
  const installationId = url.searchParams.get("installation_id")?.trim();
  const state = url.searchParams.get("state")?.trim();
  if (!state?.startsWith("pc_") || (!code && !installationId)) return null;
  return { ...(code ? { code } : {}), ...(installationId ? { installationId } : {}), state };
}

function cleanManifestCallbackParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("installation_id");
  url.searchParams.delete("setup_action");
  url.searchParams.delete("state");
  url.searchParams.delete("githubAppManifest");
  window.history.replaceState(window.history.state, document.title, url.toString());
}

export function extractManifestCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    return parsed.searchParams.get("code")?.trim() || trimmed;
  } catch {
    return trimmed.replace(/^code=/i, "").trim();
  }
}

// GitHub's credential step needs its own dedicated worker actions
// (create/get/convert-github-app-manifest), obtained via `usePluginAction`
// -- which must be called at a component's top level, not lazily here.
// SettingsPage calls usePluginAction for these itself and threads the
// resulting callables through the hook input, mirroring Slack's
// SlackSettingsUIActionsInput.
export interface GitHubSettingsUIActionsInput {
  createGitHubAppManifest: (input: Record<string, unknown>) => Promise<unknown>;
  getGitHubAppManifestFlow: (input: Record<string, unknown>) => Promise<unknown>;
  convertGitHubAppManifest: (input: Record<string, unknown>) => Promise<unknown>;
  // GitHub's redirect-restore effect needs to resolve saved-identity and
  // agent-default values, unlike Slack's simpler sessionStorage-only
  // restore -- these are read-only inputs SettingsPage already computes.
  identities: readonly BotIdentitySettingsEntry[];
  agentOptions: readonly PaperclipAgentOption[];
  companyDisplayName: string;
  credentialSidecarPath: string;
  getAgentIdentityDefaults: (
    agent: PaperclipAgentOption,
    companyDisplayName: string,
    credentialSidecarPath: string,
  ) => { label: string; githubUsername: string; commitName: string; commitEmail: string; privateKeyFile: string };
  toFormState: (entry?: BotIdentitySettingsEntry) => GitHubSettingsUIFormConfig;
}

type GitHubCredentialStepInput = ProviderSettingsUIHookInput<GitHubSettingsUIFormConfig> & GitHubSettingsUIActionsInput;

function useGitHubCredentialStep(input: GitHubCredentialStepInput): GitHubSettingsUIHookResult {
  const {
    config,
    updateField,
    createGitHubAppManifest,
    getGitHubAppManifestFlow,
    convertGitHubAppManifest,
    identities,
    agentOptions,
    companyDisplayName,
    credentialSidecarPath,
    getAgentIdentityDefaults,
    toFormState,
    patchFormState,
  } = input;

  const [manifestFlow, setManifestFlow] = useState<CreateGitHubAppManifestResult | null>(null);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [manifestCode, setManifestCode] = useState("");
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestResult, setManifestResult] = useState<ConvertGitHubAppManifestResult | null>(null);

  function reset() {
    setManifestFlow(null);
    setManifestCode("");
    setManifestError(null);
    setManifestResult(null);
  }

  // Restore an in-progress GitHub App manifest flow after GitHub redirects
  // back to the callback URL with ?code=/&installation_id=&state=. Unlike
  // Slack (which has no redirect callback and relies on sessionStorage
  // alone), GitHub's flow is driven by the URL the browser lands on after
  // leaving the page entirely, so this runs once on mount rather than
  // being generation-guarded the way Slack's local-state resets are.
  useEffect(() => {
    const callback = getManifestCallbackParams();
    if (!callback) return;

    let cancelled = false;
    setManifestBusy(true);
    setManifestError(null);
    setManifestResult(null);
    void getGitHubAppManifestFlow({ state: callback.state })
      .then((result) => {
        if (cancelled) return;
        const flow = result as GetGitHubAppManifestFlowResult;
        const savedIdentity = identities.find((entry) => entry.agentId === flow.agentId && entry.provider === flow.provider);
        const selectedAgent = agentOptions.find((agent) => agent.id === flow.agentId);
        const defaults = selectedAgent
          ? getAgentIdentityDefaults(selectedAgent, companyDisplayName, credentialSidecarPath)
          : null;
        const restoredForm = toFormState(savedIdentity);
        const draftForm = readManifestDraftForm(callback.state);
        const conversion = flow.conversion;
        patchFormState(() => ({
          ...restoredForm,
          ...draftForm,
          agentId: flow.agentId,
          provider: flow.provider,
          label: draftForm?.label || restoredForm.label || flow.label,
          githubUsername: conversion?.githubUsername || draftForm?.githubUsername || restoredForm.githubUsername || defaults?.githubUsername || DEFAULT_BOT_IDENTITY_CONFIG.github.username,
          commitName: draftForm?.commitName || restoredForm.commitName || defaults?.commitName || "",
          commitEmail: draftForm?.commitEmail || restoredForm.commitEmail || defaults?.commitEmail || "",
          githubAppId: conversion?.appId || draftForm?.githubAppId || restoredForm.githubAppId,
          githubInstallationId: callback.installationId || restoredForm.githubInstallationId,
          privateKeyFile: conversion?.privateKeyFile || draftForm?.privateKeyFile || restoredForm.privateKeyFile || defaults?.privateKeyFile || "",
        }));
        setManifestFlow(flow);
        setManifestCode(callback.code ?? "");
        if (callback.installationId) {
          setManifestResult(conversion ?? null);
          deleteManifestDraftForm(callback.state);
          void getGitHubAppManifestFlow({ state: callback.state, consume: true }).catch(() => undefined);
        }
        cleanManifestCallbackParams();
      })
      .catch((err) => {
        if (!cancelled) {
          setManifestError(err instanceof Error ? err.message : "Could not restore GitHub App manifest flow");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setManifestBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentOptions, companyDisplayName, credentialSidecarPath, getGitHubAppManifestFlow, identities]);

  async function handleCreateGitHubAppManifest() {
    if (!config) return;
    if (config.provider !== GITHUB_IDENTITY_PROVIDER_ID) {
      setManifestError("GitHub App setup is only available for the GitHub provider.");
      return;
    }
    setManifestBusy(true);
    setManifestError(null);
    setManifestResult(null);
    try {
      const result = await createGitHubAppManifest({
        agentId: config.agentId.trim(),
        provider: config.provider,
        label: config.label.trim(),
        homepageUrl: getAgentDashboardUrl(config.agentId.trim()),
        callbackUrl: getManifestReturnUrl(),
      }) as CreateGitHubAppManifestResult;
      setManifestFlow(result);
      writeManifestDraftForm(result.state, config);
      submitGitHubAppManifest(result);
    } catch (err) {
      setManifestError(err instanceof Error ? err.message : "Failed to create GitHub App manifest");
    } finally {
      setManifestBusy(false);
    }
  }

  async function handleConvertGitHubAppManifest() {
    if (!manifestFlow || !config) return;
    setManifestBusy(true);
    setManifestError(null);
    try {
      const result = await convertGitHubAppManifest({
        state: manifestFlow.state,
        code: manifestCode.trim(),
      }) as ConvertGitHubAppManifestResult;
      const nextFormState = {
        ...config,
        githubAppId: result.appId,
        privateKeyFile: result.privateKeyFile,
        githubUsername: result.githubUsername,
      };
      writeManifestDraftForm(manifestFlow.state, nextFormState);
      setManifestResult(result);
      updateField("githubAppId", result.appId);
      updateField("privateKeyFile", result.privateKeyFile);
      updateField("githubUsername", result.githubUsername);
      window.location.assign(result.installUrl);
    } catch (err) {
      setManifestError(err instanceof Error ? err.message : "Failed to convert GitHub App manifest");
    } finally {
      setManifestBusy(false);
    }
  }

  return {
    validationExtra: {},
    reset,
    manifestFlow,
    manifestBusy,
    manifestCode,
    setManifestCode,
    manifestError,
    manifestResult,
    handleCreateGitHubAppManifest,
    handleConvertGitHubAppManifest,
    updateField,
    secretOptions: input.secretOptions,
    secretsLoading: input.secretsLoading,
    secretsError: input.secretsError,
    companyId: input.companyId,
  };
}

function GitHubAppManifestCreateIntro() {
  return (
    <div style={inlineNoticeStyle}>
      <strong>Create a GitHub App with a manifest.</strong> This opens GitHub with the required app permissions prefilled. After GitHub creates the app, Paperclip saves the generated private key file, preloads the App ID, opens the install flow, and restores the form with the Installation ID when GitHub redirects back.
    </div>
  );
}

function GitHubAppManifestActions(props: {
  manifestBusy: boolean;
  disabled: boolean;
  manifestFlow: CreateGitHubAppManifestResult | null;
  onCreate: () => void;
  buttonLabel: string;
}) {
  return (
    <div style={formActionsStyle}>
      <button
        type="button"
        onClick={props.onCreate}
        disabled={props.manifestBusy || props.disabled}
        style={secondaryButtonStyle}
      >
        {props.manifestBusy ? "Working..." : props.buttonLabel}
      </button>
      {props.manifestFlow && <span style={hintStyle}>Manifest ready for {props.manifestFlow.appName}. GitHub should be open in a new tab.</span>}
    </div>
  );
}

function GitHubCredentialStep(props: { state: GitHubSettingsUIHookResult; config: GitHubSettingsUIFormConfig }) {
  const { state, config } = props;
  const { manifestFlow, manifestBusy, manifestCode, setManifestCode, manifestError, manifestResult, handleCreateGitHubAppManifest, handleConvertGitHubAppManifest } = state;
  const hasExistingGitHubAppCredential = Boolean(
    config.previousGithubAppId ||
    config.previousGithubInstallationId ||
    config.previousPrivateKeySecretId ||
    config.previousPrivateKeyFile
  );
  const hasSecretOptions = state.secretOptions.length > 0;
  const hasSavedSecretOutsideOptions = Boolean(
    config.privateKeySecretId && !state.secretOptions.some((secret) => secret.id === config.privateKeySecretId)
  );
  const hasSavedFallbackSecretOutsideOptions = Boolean(
    config.fallbackTokenSecretId && !state.secretOptions.some((secret) => secret.id === config.fallbackTokenSecretId)
  );

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>GitHub App credential source</legend>

      {hasExistingGitHubAppCredential ? (
        <div style={inlineNoticeStyle}>
          <strong>GitHub App already configured.</strong> Edit the fields below to update the saved App ID, Installation ID, or private key source. Creating another manifest is a replacement/rotation flow; it creates a new GitHub App and does not update the existing app in GitHub.
        </div>
      ) : (
        <GitHubAppManifestCreateIntro />
      )}

      {hasExistingGitHubAppCredential ? (
        <details>
          <summary>Replace this GitHub App with a new manifest-created app</summary>
          <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}>
            <GitHubAppManifestCreateIntro />
            <GitHubAppManifestActions
              manifestBusy={manifestBusy}
              disabled={!config.agentId || !config.label}
              manifestFlow={manifestFlow}
              onCreate={() => void handleCreateGitHubAppManifest()}
              buttonLabel="Create replacement GitHub App on GitHub"
            />
          </div>
        </details>
      ) : (
        <GitHubAppManifestActions
          manifestBusy={manifestBusy}
          disabled={!config.agentId || !config.label}
          manifestFlow={manifestFlow}
          onCreate={() => void handleCreateGitHubAppManifest()}
          buttonLabel="Create GitHub App on GitHub"
        />
      )}

      {manifestFlow && (
        <div style={manifestPanelStyle}>
          <div style={fieldStyle}>
            <span style={hintStyle}>If a popup was blocked, use this manual form:</span>
            <form action={manifestFlow.postUrl} method="post" target="_blank">
              <input type="hidden" name="manifest" value={manifestFlow.manifest} />
              <button type="submit" style={secondaryButtonStyle}>Open GitHub manifest form</button>
            </form>
          </div>
          <label style={fieldStyle}>
            <span>Callback code</span>
            <input
              type="text"
              value={manifestCode}
              onChange={(e) => setManifestCode(extractManifestCode(e.target.value))}
              placeholder="Paste GitHub's callback URL or just the code=... value"
              style={inputStyle}
            />
          </label>
          <div style={formActionsStyle}>
            <button
              type="button"
              onClick={() => void handleConvertGitHubAppManifest()}
              disabled={manifestBusy || !manifestCode.trim()}
              style={secondaryButtonStyle}
            >
              Save generated private key and prefill fields
            </button>
            {manifestResult && <a href={manifestResult.installUrl} target="_blank" rel="noreferrer" style={linkStyle}>Install GitHub App</a>}
          </div>
        </div>
      )}

      {manifestError && <span style={errorStyle}>{manifestError}</span>}
      {manifestResult && config.githubInstallationId ? (
        <span style={successStyle}>GitHub App {manifestResult.appName} installed. Review the prefilled Installation ID, then save this identity.</span>
      ) : manifestResult ? (
        <span style={successStyle}>GitHub App {manifestResult.appName} created. Install it on GitHub; Paperclip will prefill the Installation ID when GitHub redirects back.</span>
      ) : null}

      {hasExistingGitHubAppCredential && (
        <div style={formActionsStyle}>
          <a href="https://github.com/settings/apps" target="_blank" rel="noreferrer" style={linkStyle}>Manage GitHub Apps</a>
          <a href="https://github.com/settings/installations" target="_blank" rel="noreferrer" style={linkStyle}>Manage GitHub App installations</a>
        </div>
      )}

      <label style={fieldStyle}>
        <span>GitHub App ID</span>
        <input
          type="text"
          value={config.githubAppId}
          onChange={(e) => state.updateField("githubAppId", e.target.value)}
          placeholder="GitHub App ID"
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span>Installation ID</span>
        <input
          type="text"
          value={config.githubInstallationId}
          onChange={(e) => state.updateField("githubInstallationId", e.target.value)}
          placeholder="GitHub App installation ID"
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span>Private key Paperclip secret UUID</span>
        {hasSecretOptions ? (
          <select
            value={config.privateKeySecretId}
            onChange={(e) => state.updateField("privateKeySecretId", e.target.value)}
            style={inputStyle}
          >
            <option value="">No private key secret reference</option>
            {hasSavedSecretOutsideOptions && <option value={config.privateKeySecretId}>{config.privateKeySecretId} (saved)</option>}
            {state.secretOptions.map((secret) => (
              <option key={secret.id} value={secret.id}>{formatSecretOption(secret)}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={config.privateKeySecretId}
            onChange={(e) => state.updateField("privateKeySecretId", e.target.value)}
            placeholder="Company secret UUID containing the GitHub App private key"
            style={inputStyle}
          />
        )}
        <span style={hintStyle}>{getSecretFieldHint({ companyId: state.companyId, secretsLoading: state.secretsLoading, secretsError: state.secretsError, hasSecretOptions })}</span>
      </label>

      <label style={fieldStyle}>
        <span>Private key file fallback</span>
        <input
          type="text"
          value={config.privateKeyFile}
          onChange={(e) => state.updateField("privateKeyFile", e.target.value)}
          placeholder="<runtime-home>/.paperclip/agent-identities/github-apps/<agent>/private-key.pem"
          style={inputStyle}
        />
        <span style={hintStyle}>Used by plugin tools while a secret UUID is not configured or cannot be resolved. The plugin mints short-lived installation tokens from this private key; it does not store generated tokens.</span>
      </label>

      <details>
        <summary>Fallback token source</summary>
        <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}>
          <label style={fieldStyle}>
            <span>Fallback token secret UUID</span>
            {hasSecretOptions ? (
              <select
                value={config.fallbackTokenSecretId}
                onChange={(e) => state.updateField("fallbackTokenSecretId", e.target.value)}
                style={inputStyle}
              >
                <option value="">No fallback token secret reference</option>
                {hasSavedFallbackSecretOutsideOptions && <option value={config.fallbackTokenSecretId}>{config.fallbackTokenSecretId} (saved)</option>}
                {state.secretOptions.map((secret) => (
                  <option key={secret.id} value={secret.id}>{formatSecretOption(secret)}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.fallbackTokenSecretId}
                onChange={(e) => state.updateField("fallbackTokenSecretId", e.target.value)}
                placeholder="Company secret UUID containing a GitHub token"
                style={inputStyle}
              />
            )}
            <span style={hintStyle}>{getFallbackTokenSecretFieldHint({ companyId: state.companyId, secretsLoading: state.secretsLoading, secretsError: state.secretsError, hasSecretOptions })}</span>
          </label>
          <label style={fieldStyle}>
            <span>Fallback token file</span>
            <input
              type="text"
              value={config.tokenFile}
              onChange={(e) => state.updateField("tokenFile", e.target.value)}
              placeholder="<runtime-home>/.paperclip/agent-identities/tokens/<agent-id>.token"
              style={inputStyle}
            />
            <span style={hintStyle}>Fallback token files are available for dev and recovery flows. Prefer GitHub App credentials above.</span>
          </label>
        </div>
      </details>
    </fieldset>
  );
}

export const githubSettingsUIAdapter: ProviderSettingsUIAdapter<GitHubSettingsUIFormConfig, GitHubSettingsUIHookResult, GitHubCredentialStepInput> = {
  providerId: GITHUB_IDENTITY_PROVIDER_ID,
  useCredentialStep: useGitHubCredentialStep,
  CredentialStep: GitHubCredentialStep,
  getRemovalConfirmation(entry) {
    return `Delete agent identity mapping for ${entry.label}? This clears the saved GitHub App binding for this agent; the GitHub App itself and its installation are not deleted, only unlinked from this agent. You can reconnect it (or install a different GitHub App) by editing this identity again.`;
  },
};
