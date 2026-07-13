// The provider-owned Settings-UI surface for Slack: state, effects, action
// handlers, and rendered JSX for the "slack" wizard step, previously inlined
// in src/ui/SettingsPage.tsx (see DRO-1039). This is a pure extraction --
// behavior is unchanged -- proving a provider can own its full settings-UI
// surface (state + handlers + rendering) rather than the shared SettingsPage
// component branching on provider id strings for JSX and handler bodies.
//
// GitHub's equivalent credential-step logic is NOT migrated here (out of
// scope for DRO-1039, kept low-risk/incremental) but could follow the same
// `useXSettingsPanel()` hook + `<XSettingsPanel />` component shape.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  CreateSlackAppManifestResult,
  GetSlackAppManifestFlowResult,
  SaveSlackInstallMetadataResult,
} from "../../shared/types.js";
import {
  uiBorder,
  uiBorderStrong,
  uiDanger,
  uiInput,
  uiLink,
  uiMutedText,
  uiPanel,
  uiSuccess,
  uiSurface,
  uiText,
} from "../../ui/theme.js";

export type SlackSettingsPanelConfig = {
  agentId: string;
  label: string;
  provider: string;
  previousAgentId: string;
  slackTeamId: string;
  slackAppId: string;
  slackBotUserId: string;
  slackDefaultChannel: string;
  slackBotTokenSecretId: string;
};

export type SlackSecretOption = {
  id: string;
  name: string;
  key?: string;
  description?: string;
  provider?: string;
  status?: string;
};

export interface UseSlackSettingsPanelOptions {
  /** The current form config, or null when no identity is being created/edited. */
  config: SlackSettingsPanelConfig | null;
  /** Called with a field name/value to update the shared form state. */
  updateField: (field: keyof SlackSettingsPanelConfig, value: string) => void;
  /** Called to record the just-saved identity as the form's "previous" identity (rename bookkeeping). */
  setPreviousAgentId: (agentId: string) => void;
  createSlackAppManifest: (input: { agentId: string; provider: string; label: string }) => Promise<unknown>;
  getSlackAppManifestFlow: (input: { state: string; consume?: boolean }) => Promise<unknown>;
  saveSlackInstallMetadata: (input: {
    state: string;
    agentId: string;
    teamId: string;
    appId: string;
    botUserId: string;
    botTokenSecretId: string;
    defaultChannel?: string;
  }) => Promise<unknown>;
  deleteConfig: (input: { agentId: string; provider: string }) => Promise<unknown>;
  refresh: () => void | Promise<unknown>;
}

export interface SlackSettingsPanelState {
  slackManifestFlow: CreateSlackAppManifestResult | null;
  slackManifestBusy: boolean;
  slackSaveBusy: boolean;
  slackManifestError: string | null;
  slackSaveResult: SaveSlackInstallMetadataResult | null;
  slackManifestCopied: boolean;
  slackResumeStateInput: string;
  slackResumeBusy: boolean;
  slackResumeError: string | null;
  setSlackResumeStateInput: (value: string) => void;
  setSlackManifestCopied: (value: boolean) => void;
  setSlackManifestError: (value: string | null) => void;
  /** Reset the entire Slack manifest/save flow -- call from startCreate/startEdit and whenever agentId/label changes. */
  reset: () => void;
  /** Invalidate a prior successful save (and any in-flight save) -- call whenever a `slack*` field is edited. */
  invalidateSave: () => void;
  handleCreateSlackAppManifest: () => Promise<void>;
  handleResumeSlackAppManifestFlow: () => Promise<void>;
  handleSaveSlackInstallMetadata: () => Promise<void>;
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

export async function copyTextToClipboard(value: string): Promise<void> {
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

export function useSlackSettingsPanel(options: UseSlackSettingsPanelOptions): SlackSettingsPanelState {
  const { config, updateField, setPreviousAgentId, createSlackAppManifest, getSlackAppManifestFlow, saveSlackInstallMetadata, deleteConfig, refresh } = options;

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

  function reset(): void {
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

  function invalidateSave(): void {
    // Any edit to the Slack install fields invalidates a prior successful
    // save-slack-install-metadata result -- it was only valid for the exact
    // field values it was saved with. Also bump the save generation so an
    // in-flight save-slack-install-metadata response (started before this
    // edit) is discarded when it arrives, rather than being applied against
    // fields it no longer reflects.
    setSlackSaveResult(null);
    slackSaveGenerationRef.current += 1;
    // The in-flight save (if any) is now stale and its finally() will no
    // longer match the current generation, so it will never clear
    // slackSaveBusy itself -- clear it here so the wizard doesn't get
    // stuck showing "Saving..." after an edit invalidates the request.
    setSlackSaveBusy(false);
  }

  // Restore an in-progress Slack manifest flow after a reload or editor
  // reopen. Unlike GitHub, Slack has no redirect callback to carry state
  // back in via the URL, so the only place to look is the state token this
  // component persisted to sessionStorage when the flow was created (see
  // writeSlackManifestFlowState). Re-validate against the server (rather
  // than trusting the stored token blindly) since the flow may have expired
  // or been consumed since it was written.
  useEffect(() => {
    if (!config) return;
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

  async function handleResumeSlackAppManifestFlow(): Promise<void> {
    if (!config) return;
    const state = slackResumeStateInput.trim();
    if (!state) return;
    const generation = slackManifestFlowGenerationRef.current;
    setSlackResumeBusy(true);
    setSlackResumeError(null);
    try {
      const flow = (await getSlackAppManifestFlow({ state })) as GetSlackAppManifestFlowResult;
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

  async function handleCreateSlackAppManifest(): Promise<void> {
    if (!config) return;
    const generation = slackManifestFlowGenerationRef.current;
    setSlackManifestBusy(true);
    setSlackManifestError(null);
    setSlackSaveResult(null);
    try {
      const result = (await createSlackAppManifest({
        agentId: config.agentId.trim(),
        provider: config.provider,
        label: config.label.trim(),
      })) as CreateSlackAppManifestResult;
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

  async function handleSaveSlackInstallMetadata(): Promise<void> {
    if (!config || !slackManifestFlow) return;
    const generation = ++slackSaveGenerationRef.current;
    setSlackSaveBusy(true);
    setSlackManifestError(null);
    try {
      const targetAgentId = config.agentId.trim();
      const previousAgentId = config.previousAgentId.trim();
      const botTokenSecretId = config.slackBotTokenSecretId.trim();
      const result = (await saveSlackInstallMetadata({
        state: slackManifestFlow.state,
        agentId: targetAgentId,
        teamId: config.slackTeamId.trim(),
        appId: config.slackAppId.trim(),
        botUserId: config.slackBotUserId.trim(),
        botTokenSecretId,
        ...(config.slackDefaultChannel.trim() ? { defaultChannel: config.slackDefaultChannel.trim() } : {}),
      })) as SaveSlackInstallMetadataResult;
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
          await deleteConfig({ agentId: previousAgentId, provider: "slack" });
        } catch (err) {
          // Do not mark this rebind complete: both the old and new
          // identities now exist server-side, so "Save agent" closing the
          // dialog here would silently leave the stale previousAgentId
          // identity behind with no obvious retry path. Surface the error
          // and leave slackSaveResult unset (credentialComplete stays
          // false) so the operator can retry, keeping the dialog open.
          setSlackManifestError(
            `Slack install metadata saved, but could not remove the previous identity for ${previousAgentId}: ${err instanceof Error ? err.message : "unknown error"}. Please retry.`,
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
      setPreviousAgentId(result.agentId);
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
    slackManifestFlow,
    slackManifestBusy,
    slackSaveBusy,
    slackManifestError,
    slackSaveResult,
    slackManifestCopied,
    slackResumeStateInput,
    slackResumeBusy,
    slackResumeError,
    setSlackResumeStateInput,
    setSlackManifestCopied,
    setSlackManifestError,
    reset,
    invalidateSave,
    handleCreateSlackAppManifest,
    handleResumeSlackAppManifestFlow,
    handleSaveSlackInstallMetadata,
  };
}

export interface SlackSettingsPanelProps {
  panel: SlackSettingsPanelState;
  config: SlackSettingsPanelConfig;
  updateField: (field: keyof SlackSettingsPanelConfig, value: string) => void;
  secretOptions: SlackSecretOption[];
  hasSecretOptions: boolean;
  formatSecretOption: (secret: SlackSecretOption) => string;
  getSecretFieldHint: (args: { companyId: string; secretsLoading: boolean; secretsError: string | null; hasSecretOptions: boolean }) => string;
  companyId: string;
  secretsLoading: boolean;
  secretsError: string | null;
  formValidation: { credentialComplete: boolean; credentialMessage: string } | null;
}

const fieldsetStyle: CSSProperties = {
  border: `1px solid ${uiBorder}`,
  borderRadius: 12,
  padding: "1rem",
  display: "grid",
  gap: "0.75rem",
};

const legendStyle: CSSProperties = {
  padding: "0 0.25rem",
  color: uiText,
  fontSize: "0.875rem",
  fontWeight: 600,
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontSize: "0.875rem",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  minHeight: 38,
  padding: "0.45rem 0.65rem",
  border: `1px solid ${uiBorderStrong}`,
  borderRadius: 8,
  fontSize: "0.875rem",
  backgroundColor: uiInput,
  color: uiText,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

const manifestPanelStyle: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "0.85rem",
  border: `1px dashed ${uiBorderStrong}`,
  borderRadius: 10,
  backgroundColor: uiPanel,
};

const linkStyle: CSSProperties = {
  color: uiLink,
  fontWeight: 600,
};

const inlineNoticeStyle: CSSProperties = {
  padding: "0.75rem 0.9rem",
  border: `1px solid ${uiBorder}`,
  borderRadius: 10,
  backgroundColor: uiPanel,
  color: uiMutedText,
  fontSize: "0.875rem",
};

const hintStyle: CSSProperties = {
  fontSize: "0.8125rem",
  fontWeight: 400,
  color: uiMutedText,
};

const formActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};

const secondaryButtonStyle: CSSProperties = {
  minHeight: 34,
  padding: "0.4rem 0.75rem",
  backgroundColor: uiSurface,
  color: uiText,
  border: `1px solid ${uiBorderStrong}`,
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
};

const requiredStyle: CSSProperties = {
  color: uiDanger,
};

const successStyle: CSSProperties = {
  color: uiSuccess,
};

const errorStyle: CSSProperties = {
  color: uiDanger,
};

const validationNoticeStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  border: "1px solid color-mix(in srgb, var(--agent-identities-warning) 36%, transparent)",
  borderRadius: 8,
  backgroundColor: "color-mix(in srgb, var(--agent-identities-warning) 8%, transparent)",
  color: uiText,
  fontSize: "0.875rem",
};

export function SlackSettingsPanel(props: SlackSettingsPanelProps) {
  const { panel, config, updateField, secretOptions, hasSecretOptions, formatSecretOption, getSecretFieldHint, companyId, secretsLoading, secretsError, formValidation } = props;

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>Slack App setup</legend>
      {formValidation && !formValidation.credentialComplete && <div style={validationNoticeStyle}>{formValidation.credentialMessage}</div>}

      <div style={inlineNoticeStyle}>
        <strong>Create a Slack App from a manifest.</strong> Slack does not support a prefilled deep link for manifests, so Paperclip generates the manifest JSON below for you to copy, then opens the plain Slack "create app" page where you paste it in via "From an app manifest".
      </div>

      <div style={formActionsStyle}>
        <button
          type="button"
          onClick={() => void panel.handleCreateSlackAppManifest()}
          disabled={panel.slackManifestBusy || panel.slackSaveBusy || panel.slackResumeBusy || !config.agentId || !config.label}
          style={secondaryButtonStyle}
        >
          {panel.slackManifestBusy ? "Working..." : "Create Slack App manifest"}
        </button>
      </div>

      {!panel.slackManifestFlow && (
        <div style={formActionsStyle}>
          <label style={fieldStyle}>
            <span>Resume an existing manifest flow</span>
            <input
              type="text"
              value={panel.slackResumeStateInput}
              onChange={(e) => panel.setSlackResumeStateInput(e.target.value)}
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
            onClick={() => void panel.handleResumeSlackAppManifestFlow()}
            disabled={panel.slackResumeBusy || panel.slackManifestBusy || panel.slackSaveBusy || !panel.slackResumeStateInput.trim()}
            style={secondaryButtonStyle}
          >
            {panel.slackResumeBusy ? "Restoring..." : "Restore flow"}
          </button>
        </div>
      )}

      {panel.slackResumeError && <span style={errorStyle}>{panel.slackResumeError}</span>}

      {panel.slackManifestFlow && (
        <div style={manifestPanelStyle}>
          <label style={fieldStyle}>
            <span>Manifest JSON</span>
            <textarea readOnly value={panel.slackManifestFlow.manifest} style={{ ...textareaStyle, minHeight: 140 }} />
          </label>
          <div style={formActionsStyle}>
            <button
              type="button"
              onClick={() =>
                void copyTextToClipboard(panel.slackManifestFlow!.manifest)
                  .then(() => {
                    panel.setSlackManifestCopied(true);
                    panel.setSlackManifestError(null);
                  })
                  .catch(() => {
                    panel.setSlackManifestCopied(false);
                    panel.setSlackManifestError("Could not copy the manifest JSON to the clipboard. Select the text above and copy it manually.");
                  })
              }
              style={secondaryButtonStyle}
            >
              {panel.slackManifestCopied ? "Copied!" : "Copy manifest JSON"}
            </button>
            <a href={panel.slackManifestFlow.createAppUrl} target="_blank" rel="noreferrer" style={linkStyle}>Open Slack "Create an app" page</a>
          </div>
          <span style={hintStyle}>
            On the Slack page, choose "From an app manifest," select the workspace, then paste the copied JSON. After Slack creates and you install the app, come back and paste the resulting IDs below.
          </span>
          <label style={fieldStyle}>
            <span>Flow state token</span>
            <input type="text" readOnly value={panel.slackManifestFlow.state} style={inputStyle} />
            <span style={hintStyle}>
              Save this token if you might reload settings or close this editor before finishing setup. Paste it
              into "Resume an existing manifest flow" above to restore this in-progress flow within its
              30-minute window.
            </span>
          </label>
        </div>
      )}

      {panel.slackManifestError && <span style={errorStyle}>{panel.slackManifestError}</span>}

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
          onClick={() => void panel.handleSaveSlackInstallMetadata()}
          disabled={
            panel.slackManifestBusy ||
            panel.slackSaveBusy ||
            !panel.slackManifestFlow ||
            !config.slackTeamId.trim() ||
            !config.slackAppId.trim() ||
            !config.slackBotUserId.trim() ||
            !config.slackBotTokenSecretId.trim()
          }
          style={secondaryButtonStyle}
        >
          {panel.slackSaveBusy ? "Saving..." : "Save Slack install metadata"}
        </button>
      </div>

      {!panel.slackManifestFlow && (
        <span style={hintStyle}>Create the manifest above first; saving install metadata requires an active manifest flow state.</span>
      )}

      {panel.slackSaveResult && <span style={successStyle}>Slack install metadata saved for team {panel.slackSaveResult.teamId}.</span>}
    </fieldset>
  );
}
