import { useEffect, useRef, useState } from "react";
import type { ProviderSettingsUIAdapter, ProviderSettingsUIHookInput, ProviderSettingsUIHookResult } from "../../core/provider-settings-ui-contract.js";
import {
  SLACK_IDENTITY_PROVIDER_ID,
  type CreateSlackAppManifestResult,
  type GetSlackAppManifestFlowResult,
  type SaveSlackInstallMetadataResult,
} from "../../shared/types.js";
import {
  errorStyle,
  fieldStyle,
  fieldsetStyle,
  formActionsStyle,
  hintStyle,
  inlineNoticeStyle,
  inputStyle,
  legendStyle,
  linkStyle,
  manifestPanelStyle,
  requiredStyle,
  secondaryButtonStyle,
  successStyle,
  textareaStyle,
  validationNoticeStyle,
} from "../../ui/SettingsPage.js";

// Deliberately NOT importing from "./index.js" (the slack provider's
// server-side composition -- see the matching note in settings-adapter.ts).
// This module is client code (JSX/hooks are fine to import here, unlike
// settings-adapter.ts), but it must still avoid pulling in server-only code
// (node:crypto, app-manifest.ts) into the client Settings UI bundle.

export interface SlackSettingsUIFormConfig {
  agentId: string;
  provider: string;
  label: string;
  previousAgentId: string;
  slackTeamId: string;
  slackAppId: string;
  slackBotUserId: string;
  slackDefaultChannel: string;
  slackBotTokenSecretId: string;
  [key: string]: string;
}

export interface SlackSettingsUIHookResult extends ProviderSettingsUIHookResult {
  slackManifestFlow: CreateSlackAppManifestResult | null;
  slackManifestBusy: boolean;
  slackSaveBusy: boolean;
  slackManifestError: string | null;
  slackSaveResult: SaveSlackInstallMetadataResult | null;
  slackManifestCopied: boolean;
  setSlackManifestCopied: (value: boolean) => void;
  setSlackManifestError: (value: string | null) => void;
  slackResumeStateInput: string;
  setSlackResumeStateInput: (value: string) => void;
  slackResumeBusy: boolean;
  slackResumeError: string | null;
  handleResumeSlackAppManifestFlow: () => Promise<void>;
  handleCreateSlackAppManifest: () => Promise<void>;
  handleSaveSlackInstallMetadata: () => Promise<void>;
  updateField: (field: keyof SlackSettingsUIFormConfig & string, value: string) => void;
  secretOptions: ReadonlyArray<{ id: string; name: string; key?: string; description?: string; provider?: string; status?: string }>;
  secretsLoading: boolean;
  secretsError: string | null;
  companyId: string;
}

const SLACK_MANIFEST_STATE_STORAGE_PREFIX = "paperclip-agent-identities:slack-app-manifest-state:";

function getSlackManifestStateStorageKey(agentId: string): string {
  return SLACK_MANIFEST_STATE_STORAGE_PREFIX + agentId;
}

function writeSlackManifestFlowState(agentId: string, state: string): void {
  try {
    window.sessionStorage.setItem(getSlackManifestStateStorageKey(agentId), state);
  } catch {
    // Persistence is best-effort; losing it only means the operator must
    // paste the state token manually via "Resume an existing manifest flow".
  }
}

function readSlackManifestFlowState(agentId: string): string | null {
  try {
    return window.sessionStorage.getItem(getSlackManifestStateStorageKey(agentId));
  } catch {
    return null;
  }
}

function deleteSlackManifestFlowState(agentId: string): void {
  try {
    window.sessionStorage.removeItem(getSlackManifestStateStorageKey(agentId));
  } catch {
    // Ignore sessionStorage cleanup failures.
  }
}

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall through to the legacy textarea-copy fallback below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("execCommand('copy') was rejected");
    }
  } finally {
    textarea.remove();
  }
}

type SlackCredentialStepInput = ProviderSettingsUIHookInput<SlackSettingsUIFormConfig> & SlackSettingsUIActionsInput;

function useSlackCredentialStep(input: SlackCredentialStepInput): SlackSettingsUIHookResult {
  const { config, updateField, refresh, deleteConfig, patchFormState, createSlackAppManifest, getSlackAppManifestFlow, saveSlackInstallMetadata } = input;

  const [slackManifestFlow, setSlackManifestFlow] = useState<CreateSlackAppManifestResult | null>(null);
  const [slackManifestBusy, setSlackManifestBusy] = useState(false);
  const [slackSaveBusy, setSlackSaveBusy] = useState(false);
  const [slackManifestError, setSlackManifestError] = useState<string | null>(null);
  const [slackSaveResult, setSlackSaveResult] = useState<SaveSlackInstallMetadataResult | null>(null);
  const [slackManifestCopied, setSlackManifestCopied] = useState(false);
  const [slackResumeStateInput, setSlackResumeStateInput] = useState("");
  const [slackResumeBusy, setSlackResumeBusy] = useState(false);
  const [slackResumeError, setSlackResumeError] = useState<string | null>(null);
  const slackSaveGenerationRef = useRef(0);
  // Guards the Slack manifest-flow lifecycle (automatic restore-on-mount,
  // manual "Restore flow", and "Create Slack App manifest") the same way
  // slackSaveGenerationRef guards save-slack-install-metadata: any reset
  // (edit invalidation, dialog close/reopen, provider/agent switch) bumps
  // this so a stale create/restore response that arrives afterward is
  // discarded instead of being applied to a form it no longer matches.
  const slackManifestFlowGenerationRef = useRef(0);

  function reset() {
    setSlackManifestFlow(null);
    setSlackManifestError(null);
    setSlackSaveResult(null);
    setSlackManifestCopied(false);
    setSlackResumeStateInput("");
    setSlackResumeError(null);
    // Bump the create/restore generation so any in-flight
    // create-slack-app-manifest / get-slack-app-manifest-flow response
    // started before this reset is discarded when it arrives (finding #4/#8).
    slackManifestFlowGenerationRef.current += 1;
    // Also invalidate an in-flight save-slack-install-metadata request: a
    // reset (e.g. starting a new/different identity, or closing the dialog)
    // means a stale response should never attach to whatever form comes
    // next. Mirrors the same generation-guard pattern used on field edits.
    slackSaveGenerationRef.current += 1;
    setSlackSaveBusy(false);
  }

  // Any edit to the Slack install fields invalidates a prior successful
  // save-slack-install-metadata result -- it was only valid for the exact
  // field values it was saved with. Watching config's slack* fields (rather
  // than requiring SettingsPage to call back in on every updateField) keeps
  // this entirely provider-owned.
  const slackFieldsSignature = config
    ? `${config.slackTeamId}|${config.slackAppId}|${config.slackBotUserId}|${config.slackDefaultChannel}|${config.slackBotTokenSecretId}`
    : "";
  const prevSlackFieldsSignatureRef = useRef(slackFieldsSignature);
  useEffect(() => {
    if (prevSlackFieldsSignatureRef.current !== slackFieldsSignature) {
      prevSlackFieldsSignatureRef.current = slackFieldsSignature;
      setSlackSaveResult(null);
      slackSaveGenerationRef.current += 1;
      // The in-flight save (if any) is now stale and its finally() will no
      // longer match the current generation, so it will never clear
      // slackSaveBusy itself -- clear it here so the wizard doesn't get
      // stuck showing "Saving..." after an edit invalidates the request.
      setSlackSaveBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slackFieldsSignature]);

  // Restore an in-progress Slack manifest flow after a reload or editor
  // reopen. Unlike GitHub, Slack has no redirect callback to carry state
  // back in via the URL, so the only place to look is the state token this
  // component persisted to sessionStorage when the flow was created (see
  // writeSlackManifestFlowState). Re-validate against the server (rather
  // than trusting the stored token blindly) since the flow may have expired
  // or been consumed since it was written.
  useEffect(() => {
    if (!config || config.provider !== SLACK_IDENTITY_PROVIDER_ID) return;
    if (slackManifestFlow) return;
    const agentId = config.agentId.trim();
    if (!agentId) return;
    const storedState = readSlackManifestFlowState(agentId);
    if (!storedState) return;

    let cancelled = false;
    const generation = slackManifestFlowGenerationRef.current;
    void getSlackAppManifestFlow({ state: storedState })
      .then((result) => {
        if (cancelled || slackManifestFlowGenerationRef.current !== generation) return;
        const flow = result as GetSlackAppManifestFlowResult;
        if (flow.agentId !== agentId) {
          deleteSlackManifestFlowState(agentId);
          return;
        }
        // The worker persists flow.label alongside flow.agentId (see
        // app-manifest.ts). If the label was edited (or the flow belongs to
        // a differently-labeled setup) since the flow was created, restoring
        // it silently would let the UI show one label while
        // save-slack-install-metadata records another. Reject a
        // label-mismatched flow rather than restoring it.
        if (config.label.trim() && flow.label && flow.label !== config.label.trim()) {
          deleteSlackManifestFlowState(agentId);
          return;
        }
        setSlackManifestFlow(flow);
        setSlackManifestCopied(false);
      })
      .catch(() => {
        // Flow expired, was consumed, or no longer exists -- drop the
        // stale pointer so we don't keep retrying every render.
        if (!cancelled) {
          deleteSlackManifestFlowState(agentId);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config, getSlackAppManifestFlow, slackManifestFlow]);

  async function handleResumeSlackAppManifestFlow() {
    if (!config) return;
    const state = slackResumeStateInput.trim();
    if (!state) return;
    const generation = slackManifestFlowGenerationRef.current;
    setSlackResumeBusy(true);
    setSlackResumeError(null);
    try {
      const flow = await getSlackAppManifestFlow({ state }) as GetSlackAppManifestFlowResult;
      // Discard this response if the dialog/form is no longer the one that
      // initiated the request (e.g. reset via a field edit, closing the
      // dialog, or starting a different identity while this was in flight).
      if (slackManifestFlowGenerationRef.current !== generation) return;
      if (flow.agentId !== config.agentId.trim()) {
        throw new Error("This state token belongs to a different agent than the one currently selected.");
      }
      // Reconcile the flow's persisted label against the current form the
      // same way as the automatic-restore path: a mismatched label means
      // this flow was created for a different setup, so reject it rather
      // than silently binding a save to the wrong label.
      if (config.label.trim() && flow.label && flow.label !== config.label.trim()) {
        throw new Error("This state token belongs to a different label than the one currently entered.");
      }
      setSlackManifestFlow(flow);
      setSlackManifestCopied(false);
      setSlackManifestError(null);
      writeSlackManifestFlowState(config.agentId.trim(), flow.state);
    } catch (err) {
      if (slackManifestFlowGenerationRef.current !== generation) return;
      setSlackResumeError(err instanceof Error ? err.message : "Could not restore the Slack App manifest flow for that state token.");
    } finally {
      if (slackManifestFlowGenerationRef.current === generation) {
        setSlackResumeBusy(false);
      }
    }
  }

  async function handleCreateSlackAppManifest() {
    if (!config) return;
    if (config.provider !== SLACK_IDENTITY_PROVIDER_ID) {
      setSlackManifestError("Slack App setup is only available for the Slack provider.");
      return;
    }
    const generation = slackManifestFlowGenerationRef.current;
    setSlackManifestBusy(true);
    setSlackManifestError(null);
    setSlackSaveResult(null);
    try {
      const result = await createSlackAppManifest({
        agentId: config.agentId.trim(),
        provider: config.provider,
        label: config.label.trim(),
      }) as CreateSlackAppManifestResult;
      // Discard this response if the dialog/form that initiated the request
      // is no longer current (finding #4): a reset in between (edit, close,
      // switching identity) must not let a late create response attach to a
      // different form.
      if (slackManifestFlowGenerationRef.current !== generation) return;
      setSlackManifestFlow(result);
      setSlackManifestCopied(false);
      writeSlackManifestFlowState(config.agentId.trim(), result.state);
    } catch (err) {
      if (slackManifestFlowGenerationRef.current !== generation) return;
      setSlackManifestError(err instanceof Error ? err.message : "Failed to create Slack App manifest");
    } finally {
      if (slackManifestFlowGenerationRef.current === generation) {
        setSlackManifestBusy(false);
      }
    }
  }

  async function handleSaveSlackInstallMetadata() {
    if (!config || !slackManifestFlow) return;
    const generation = ++slackSaveGenerationRef.current;
    setSlackSaveBusy(true);
    setSlackManifestError(null);
    try {
      const targetAgentId = config.agentId.trim();
      const previousAgentId = config.previousAgentId.trim();
      const botTokenSecretId = config.slackBotTokenSecretId.trim();
      const result = await saveSlackInstallMetadata({
        state: slackManifestFlow.state,
        agentId: targetAgentId,
        teamId: config.slackTeamId.trim(),
        appId: config.slackAppId.trim(),
        botUserId: config.slackBotUserId.trim(),
        botTokenSecretId,
        ...(config.slackDefaultChannel.trim() ? { defaultChannel: config.slackDefaultChannel.trim() } : {}),
      }) as SaveSlackInstallMetadataResult;
      // Stale-response guard: if another save started (or the fields were
      // edited, invalidating slackSaveResult) after this request was sent,
      // a newer generation has already been assigned. Applying this result
      // anyway would let a late/aborted-in-spirit response silently mark
      // the (now different) form values as saved when the fields underneath
      // it may no longer match what was actually persisted server-side.
      if (slackSaveGenerationRef.current !== generation) {
        return;
      }
      // save-slack-install-metadata only upserts `${agentId}:slack`; it has
      // no knowledge of a rename. If the Agent field was changed while
      // editing an existing Slack identity, the old `${previousAgentId}:slack`
      // identity + credential would otherwise be orphaned, so clean it up
      // explicitly via the existing delete action.
      if (previousAgentId && previousAgentId !== targetAgentId) {
        try {
          await deleteConfig({ agentId: previousAgentId, provider: SLACK_IDENTITY_PROVIDER_ID });
        } catch (err) {
          // Do not mark this rebind complete: both the old and new
          // identities now exist server-side, so "Save agent" closing the
          // dialog here would silently leave the stale previousAgentId
          // identity behind with no obvious retry path. Surface the error
          // and leave slackSaveResult unset (credentialComplete stays
          // false) so the operator can retry, keeping the dialog open.
          setSlackManifestError(
            `Slack install metadata saved, but could not remove the previous identity for ${previousAgentId}: ${err instanceof Error ? err.message : "unknown error"}. Please retry.`
          );
          await refresh();
          return;
        }
      }
      setSlackSaveResult(result);
      deleteSlackManifestFlowState(targetAgentId);
      // Record the just-saved identity as the form's "previous" identity before
      // refreshing. Otherwise refresh() adds this identity to `identities`, and
      // duplicateIdentity (which compares against previousAgentId) would then
      // treat the freshly-saved identity as a duplicate of itself and disable
      // the footer's "Save agent" button.
      patchFormState((prev) => ({ ...prev, previousAgentId: result.agentId }));
      await refresh();
    } catch (err) {
      if (slackSaveGenerationRef.current !== generation) return;
      setSlackManifestError(err instanceof Error ? err.message : "Failed to save Slack install metadata");
    } finally {
      if (slackSaveGenerationRef.current === generation) {
        setSlackSaveBusy(false);
      }
    }
  }

  return {
    validationExtra: { slackSaveResult, slackSaveBusy },
    reset,
    slackManifestFlow,
    slackManifestBusy,
    slackSaveBusy,
    slackManifestError,
    slackSaveResult,
    slackManifestCopied,
    setSlackManifestCopied,
    setSlackManifestError,
    slackResumeStateInput,
    setSlackResumeStateInput,
    slackResumeBusy,
    slackResumeError,
    handleResumeSlackAppManifestFlow,
    handleCreateSlackAppManifest,
    handleSaveSlackInstallMetadata,
    updateField,
    secretOptions: input.secretOptions,
    secretsLoading: input.secretsLoading,
    secretsError: input.secretsError,
    companyId: input.companyId,
  };
}

// Slack's worker actions (create-slack-app-manifest, get-slack-app-manifest-flow,
// save-slack-install-metadata) are obtained via `usePluginAction`, which must be
// called at the top of a component -- not lazily inside this module. SettingsPage
// calls usePluginAction for these three actions itself and threads the resulting
// callables through the hook input so this file never has to import plugin-sdk
// directly for actions it doesn't own the lifecycle of.
export interface SlackSettingsUIActionsInput {
  createSlackAppManifest: (input: Record<string, unknown>) => Promise<unknown>;
  getSlackAppManifestFlow: (input: Record<string, unknown>) => Promise<unknown>;
  saveSlackInstallMetadata: (input: Record<string, unknown>) => Promise<unknown>;
}

function getSecretFieldHint(input: {
  companyId: string;
  secretsLoading: boolean;
  secretsError: string | null;
  hasSecretOptions: boolean;
}): string {
  if (!input.companyId) {
    return "No company context is available, so paste the Paperclip secret UUID manually.";
  }
  if (input.secretsLoading) {
    return "Loading Paperclip secrets...";
  }
  if (input.secretsError) {
    return `Could not load Paperclip secrets (${input.secretsError}); paste the secret UUID manually.`;
  }
  if (!input.hasSecretOptions) {
    return "No Paperclip secrets were found; paste the private key secret UUID manually or use a private key file fallback.";
  }
  return "Saved as a Paperclip secret reference for the GitHub App private key and optionally propagated to agent environments.";
}

function formatSecretOption(secret: { id: string; name: string; key?: string; description?: string; provider?: string; status?: string }): string {
  const label = secret.name || secret.key || secret.id;
  const details = [secret.key && secret.key !== label ? secret.key : null, secret.status, secret.provider]
    .filter(Boolean)
    .join(" - ");
  return details ? `${label} (${details})` : label;
}

function SlackCredentialStep(props: { state: SlackSettingsUIHookResult; config: SlackSettingsUIFormConfig }) {
  const { state, config } = props;
  const {
    slackManifestFlow,
    slackManifestBusy,
    slackSaveBusy,
    slackManifestError,
    slackSaveResult,
    slackManifestCopied,
    setSlackManifestCopied,
    setSlackManifestError,
    slackResumeStateInput,
    setSlackResumeStateInput,
    slackResumeBusy,
    slackResumeError,
    handleResumeSlackAppManifestFlow,
    handleCreateSlackAppManifest,
    handleSaveSlackInstallMetadata,
    validationExtra,
    updateField,
    secretOptions,
    secretsLoading,
    secretsError,
    companyId,
  } = state;
  const hasSecretOptions = secretOptions.length > 0;
  const credentialComplete = Boolean(
    slackSaveResult &&
      slackSaveResult.teamId === config.slackTeamId.trim() &&
      slackSaveResult.appId === config.slackAppId.trim() &&
      slackSaveResult.botUserId === config.slackBotUserId.trim() &&
      slackSaveResult.botTokenSecretId === config.slackBotTokenSecretId.trim() &&
      (slackSaveResult.defaultChannel ?? "") === config.slackDefaultChannel.trim() &&
      !validationExtra.slackSaveBusy,
  );

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>Slack App setup</legend>
      {!credentialComplete && (
        <div style={validationNoticeStyle}>
          Create the Slack App manifest, install it, and paste back the team/app/bot IDs and bot token secret, then save
          install metadata before this identity can be saved.
        </div>
      )}

      <div style={inlineNoticeStyle}>
        <strong>Create a Slack App from a manifest.</strong> Slack does not support a prefilled deep link for manifests,
        so Paperclip generates the manifest JSON below for you to copy, then opens the plain Slack "create app" page
        where you paste it in via "From an app manifest".
      </div>

      <div style={formActionsStyle}>
        <button
          type="button"
          onClick={() => void handleCreateSlackAppManifest()}
          disabled={slackManifestBusy || slackSaveBusy || slackResumeBusy || !config.agentId || !config.label}
          style={secondaryButtonStyle}
        >
          {slackManifestBusy ? "Working..." : "Create Slack App manifest"}
        </button>
      </div>

      {!slackManifestFlow && (
        <div style={formActionsStyle}>
          <label style={fieldStyle}>
            <span>Resume an existing manifest flow</span>
            <input
              type="text"
              value={slackResumeStateInput}
              onChange={(e) => setSlackResumeStateInput(e.target.value)}
              placeholder="Paste the pc_... state token from a previous session"
              style={inputStyle}
            />
            <span style={hintStyle}>
              Reloading settings or closing this editor loses the in-progress manifest flow from local state.
              If you saved the state token from when the manifest was created, paste it here to resume within
              its 30-minute server-side window instead of creating a new Slack App.
            </span>
          </label>
          <button
            type="button"
            onClick={() => void handleResumeSlackAppManifestFlow()}
            disabled={slackResumeBusy || slackManifestBusy || slackSaveBusy || !slackResumeStateInput.trim()}
            style={secondaryButtonStyle}
          >
            {slackResumeBusy ? "Restoring..." : "Restore flow"}
          </button>
        </div>
      )}

      {slackResumeError && <span style={errorStyle}>{slackResumeError}</span>}

      {slackManifestFlow && (
        <div style={manifestPanelStyle}>
          <label style={fieldStyle}>
            <span>Manifest JSON</span>
            <textarea readOnly value={slackManifestFlow.manifest} style={{ ...textareaStyle, minHeight: 140 }} />
          </label>
          <div style={formActionsStyle}>
            <button
              type="button"
              onClick={() =>
                void copyTextToClipboard(slackManifestFlow.manifest)
                  .then(() => {
                    setSlackManifestCopied(true);
                    setSlackManifestError(null);
                  })
                  .catch(() => {
                    setSlackManifestCopied(false);
                    setSlackManifestError("Could not copy the manifest JSON to the clipboard. Select the text above and copy it manually.");
                  })
              }
              style={secondaryButtonStyle}
            >
              {slackManifestCopied ? "Copied!" : "Copy manifest JSON"}
            </button>
            <a href={slackManifestFlow.createAppUrl} target="_blank" rel="noreferrer" style={linkStyle}>Open Slack "Create an app" page</a>
          </div>
          <span style={hintStyle}>
            On the Slack page, choose "From an app manifest," select the workspace, then paste the copied JSON. After
            Slack creates and you install the app, come back and paste the resulting IDs below.
          </span>
          <label style={fieldStyle}>
            <span>Flow state token</span>
            <input type="text" readOnly value={slackManifestFlow.state} style={inputStyle} />
            <span style={hintStyle}>
              Save this token if you might reload settings or close this editor before finishing setup. Paste it
              into "Resume an existing manifest flow" above to restore this in-progress flow within its
              30-minute window.
            </span>
          </label>
        </div>
      )}

      {slackManifestError && <span style={errorStyle}>{slackManifestError}</span>}

      <label style={fieldStyle}>
        <span>Team ID <span style={requiredStyle}>*</span></span>
        <input
          type="text"
          value={config.slackTeamId}
          onChange={(e) => updateField("slackTeamId", e.target.value)}
          placeholder="e.g. T0123456789"
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span>App ID <span style={requiredStyle}>*</span></span>
        <input
          type="text"
          value={config.slackAppId}
          onChange={(e) => updateField("slackAppId", e.target.value)}
          placeholder="e.g. A0123456789"
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span>Bot User ID <span style={requiredStyle}>*</span></span>
        <input
          type="text"
          value={config.slackBotUserId}
          onChange={(e) => updateField("slackBotUserId", e.target.value)}
          placeholder="e.g. U0123456789"
          style={inputStyle}
        />
      </label>

      <label style={fieldStyle}>
        <span>Bot token Paperclip secret UUID <span style={requiredStyle}>*</span></span>
        {hasSecretOptions ? (
          <select
            value={config.slackBotTokenSecretId}
            onChange={(e) => updateField("slackBotTokenSecretId", e.target.value)}
            style={inputStyle}
          >
            <option value="">No bot token secret reference</option>
            {config.slackBotTokenSecretId && !secretOptions.some((secret) => secret.id === config.slackBotTokenSecretId) && (
              <option value={config.slackBotTokenSecretId}>{config.slackBotTokenSecretId} (saved)</option>
            )}
            {secretOptions.map((secret) => (
              <option key={secret.id} value={secret.id}>{formatSecretOption(secret)}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={config.slackBotTokenSecretId}
            onChange={(e) => updateField("slackBotTokenSecretId", e.target.value)}
            placeholder="Company secret UUID containing the Slack bot token"
            style={inputStyle}
          />
        )}
        <span style={hintStyle}>{getSecretFieldHint({ companyId, secretsLoading, secretsError, hasSecretOptions })} The bot token itself is never stored in this config; only the secret reference is.</span>
      </label>

      <label style={fieldStyle}>
        <span>Default channel</span>
        <input
          type="text"
          value={config.slackDefaultChannel}
          onChange={(e) => updateField("slackDefaultChannel", e.target.value)}
          placeholder="e.g. C0123456789"
          style={inputStyle}
        />
        <span style={hintStyle}>Optional. Must match the Slack channel ID pattern (starts with C or G).</span>
      </label>

      <div style={formActionsStyle}>
        <button
          type="button"
          onClick={() => void handleSaveSlackInstallMetadata()}
          disabled={
            slackManifestBusy ||
            slackSaveBusy ||
            !slackManifestFlow ||
            !config.slackTeamId.trim() ||
            !config.slackAppId.trim() ||
            !config.slackBotUserId.trim() ||
            !config.slackBotTokenSecretId.trim()
          }
          style={secondaryButtonStyle}
        >
          {slackSaveBusy ? "Saving..." : "Save Slack install metadata"}
        </button>
      </div>

      {!slackManifestFlow && (
        <span style={hintStyle}>Create the manifest above first; saving install metadata requires an active manifest flow state.</span>
      )}

      {slackSaveResult && <span style={successStyle}>Slack install metadata saved for team {slackSaveResult.teamId}.</span>}
    </fieldset>
  );
}

export const slackSettingsUIAdapter: ProviderSettingsUIAdapter<SlackSettingsUIFormConfig, SlackSettingsUIHookResult, SlackCredentialStepInput> = {
  providerId: SLACK_IDENTITY_PROVIDER_ID,
  useCredentialStep: useSlackCredentialStep,
  CredentialStep: SlackCredentialStep,
};
