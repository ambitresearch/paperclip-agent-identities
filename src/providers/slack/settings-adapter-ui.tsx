import { useEffect, useRef, useState } from "react";
import type { ProviderSettingsUIAdapter, ProviderSettingsUIHookInput, ProviderSettingsUIHookResult } from "../../core/provider-settings-ui-contract.js";
import {
  SLACK_IDENTITY_PROVIDER_ID,
  type CreateSlackAppManifestResult,
  type DiscoverSlackInstallMetadataResult,
  type GetSlackAppManifestFlowResult,
  type LegacySlackCredentialRebindResult,
  type SaveSlackInstallMetadataResult,
} from "../../shared/types.js";
import { buildSlackEventsRequestUrl } from "../../shared/webhook-endpoints.js";
import {
  errorStyle,
  fieldStyle,
  fieldsetStyle,
  formActionsStyle,
  getMissingSecretIdError,
  hintStyle,
  inlineNoticeStyle,
  inputStyle,
  legendStyle,
  linkStyle,
  manifestPanelStyle,
  RefreshSecretsButton,
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
  slackEventsRequestUrl: string;
  slackBotTokenSecretId: string;
  slackSigningSecretId: string;
  slackLegacyCredentialStatus: string;
  slackLegacySigningSecretRequired: string;
  [key: string]: string;
}

export interface SlackSettingsUIHookResult extends ProviderSettingsUIHookResult {
  slackManifestFlow: CreateSlackAppManifestResult | null;
  slackManifestBusy: boolean;
  slackSaveBusy: boolean;
  slackManifestError: string | null;
  slackSaveResult: SaveSlackInstallMetadataResult | null;
  slackManifestCopied: boolean;
  slackDiscoveryBusy: boolean;
  slackDiscoveryError: string | null;
  setSlackManifestCopied: (value: boolean) => void;
  setSlackManifestError: (value: string | null) => void;
  slackResumeStateInput: string;
  setSlackResumeStateInput: (value: string) => void;
  slackResumeBusy: boolean;
  slackResumeError: string | null;
  handleResumeSlackAppManifestFlow: () => Promise<void>;
  handleCreateSlackAppManifest: () => Promise<void>;
  handleDiscoverSlackInstallMetadata: () => Promise<void>;
  handleSaveSlackInstallMetadata: () => Promise<void>;
  // Retry-only path for finding #2: when save-slack-install-metadata succeeds
  // but the follow-up deleteConfig(previousAgentId) rebind cleanup fails, the
  // new identity is already persisted and the one-time manifest flow is
  // already consumed/deleted -- there is no "state" left to retry the save
  // itself. slackCleanupPendingAgentId names the stale identity that still
  // needs deleting; handleRetrySlackCleanup re-attempts only that delete
  // without touching the (already-saved) install metadata.
  slackCleanupPendingAgentId: string | null;
  slackCleanupBusy: boolean;
  slackCleanupError: string | null;
  handleRetrySlackCleanup: () => Promise<void>;
  // Capability/identity status readout via the credential-free
  // `slack_bot_whoami` tool (DRO-972). Never surfaces the bot token or any
  // other secret -- only the public id/name/status fields the tool itself
  // returns (see src/providers/slack/tools/whoami.ts).
  slackStatus: SlackBotWhoamiData | null;
  slackStatusLoading: boolean;
  slackStatusError: string | null;
  handleCheckSlackStatus: () => Promise<void>;
  // DRO-1161: bounded live Slack "Connection" check (auth.test against the
  // resolved bot credential) -- distinct from slackStatus above, which only
  // reflects saved/configured metadata. Never surfaces the bot token; see
  // src/providers/slack/connection-status.ts.
  slackConnectionStatus: SlackConnectionCheckResult | null;
  slackConnectionStatusLoading: boolean;
  slackConnectionStatusError: string | null;
  // When the last successful check happened, so the UI can mark a
  // previously-good result as stale rather than implying continuous health.
  slackConnectionStatusCheckedAtMs: number | null;
  handleCheckSlackConnection: () => Promise<void>;
  // DRO-1187: read-only bounded Ingress/Delivery telemetry projection --
  // fetched automatically (no manual "check" button, unlike Connection
  // above) since there is no live check to trigger, only a projection of
  // whatever ingress/delivery activity has already been recorded.
  slackTelemetry: SlackTelemetryProjection | null;
  slackTelemetryLoading: boolean;
  slackTelemetryError: string | null;
  slackTelemetryFetchedAtMs: number | null;
  handleRefreshSlackTelemetry: () => Promise<void>;
  hasPersistedIdentity: boolean;
  // Reinstall: re-runs the manifest-assisted setup flow against an existing
  // identity row, confirmation-gated. Reuses handleCreateSlackAppManifest;
  // mirrors GitHub's "Replace this GitHub App" collapsed-details pattern.
  handleReinstallSlackApp: () => Promise<void>;
  legacySlackRebindBusy: boolean;
  legacySlackRebindError: string | null;
  legacySlackRebindResult: LegacySlackCredentialRebindResult | null;
  handleLegacySlackRebind: () => Promise<void>;
  updateField: (field: keyof SlackSettingsUIFormConfig & string, value: string) => void;
  secretOptions: ReadonlyArray<{ id: string; name: string; key?: string; description?: string; provider?: string; status?: string }>;
  secretsLoading: boolean;
  secretsError: string | null;
  companyId: string;
  refreshSecrets: () => void;
  missingSecretIds: ReadonlySet<string>;
  // The Events Request URL this deployment serves for `companyId`, derived from
  // the host's company-scoped webhook route, or null when it cannot be derived
  // (non-HTTPS dev origin). Offered as the default so operators do not have to
  // know the route; see src/shared/webhook-endpoints.ts.
  hostEventsRequestUrl: string | null;
  // What the manifest flow will actually use: the operator's override when they
  // typed one (a dev tunnel), otherwise the derived host URL.
  effectiveEventsRequestUrl: string;
}

// Only the non-secret identity/status fields `slack_bot_whoami` returns (see
// src/providers/slack/tools/whoami.ts's `perform`) -- deliberately excludes
// anything resembling a bot token, signing secret, or other credential.
export interface SlackBotWhoamiData {
  label?: string;
  teamId?: string;
  appId?: string;
  botUserId?: string;
  hasDefaultChannel?: boolean;
}

// Mirrors `SlackConnectionCheckResult`/`SlackConnectionFailureCategory` in
// connection-status.ts, kept as a separate UI-local type (rather than a
// direct import) for the same reason settings-adapter.ts avoids importing
// index.ts -- connection-status.ts pulls in credentials.ts, which is fine
// (fetch-only, no node builtins), but keeping the UI's response shape
// declared locally makes the client/server contract explicit at this
// boundary and matches the existing SlackBotWhoamiData pattern above.
export type SlackConnectionFailureCategory =
  | "credential_missing"
  | "credential_resolution_failed"
  | "auth_test_failed"
  | "workspace_mismatch"
  | "identity_mismatch"
  | "timeout"
  | "unknown";

export interface SlackConnectionCheckResult {
  outcome:
    | { ok: true }
    | { ok: false; category: SlackConnectionFailureCategory; reason: string };
  checkedAt: string;
  nextStep?: string;
}

// Mirrors telemetry.ts's exported types (DRO-1187) -- same reason as above
// for keeping the UI-local declaration rather than importing telemetry.ts
// directly (it is server-only code pulling in @paperclipai/plugin-sdk types
// used only for typing, but keeping the client/server contract explicit and
// consistent with the existing SlackBotWhoamiData/SlackConnectionCheckResult
// pattern above).
export type SlackIngressFailureCategory = "signature_failed" | "routing_failed";
export type SlackDeliveryFailureCategory = "queue_failed" | "session_failed" | "reply_failed" | "action_not_taken";

export interface SlackTelemetryFailure {
  category: SlackIngressFailureCategory | SlackDeliveryFailureCategory;
  nextStep: string;
  at: number;
}

export interface SlackIngressTelemetry {
  lastVerifiedEventAt?: number;
  lastEventType?: "message" | "app_mention" | "other";
  lastRoutingResult?: "routed" | "routing_failed";
  lastFailure?: SlackTelemetryFailure;
}

export interface SlackDeliveryTelemetry {
  lastEnqueuedAt?: number;
  lastDrainStartedAt?: number;
  lastCompletedAt?: number;
  lastFailedAt?: number;
  lastFailure?: SlackTelemetryFailure;
}

export interface SlackTelemetryProjection {
  ingress: SlackIngressTelemetry | null;
  delivery: SlackDeliveryTelemetry | null;
}

const SLACK_MANIFEST_STATE_STORAGE_PREFIX = "paperclip-agent-identities:slack-app-manifest-state:";

export function normalizeSlackAppIdInput(value: string): string {
  const trimmed = value.trim();
  if (/^A[A-Z0-9]+$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  try {
    const url = new URL(trimmed);
    const path = url.pathname.split("/").filter(Boolean);
    const appId = path[0] === "apps" ? path[1] : undefined;
    if (url.hostname === "api.slack.com" && appId && /^A[A-Z0-9]+$/i.test(appId)) {
      return appId.toUpperCase();
    }
  } catch {
    // Keep partially typed and non-URL values unchanged.
  }
  return value;
}

function actionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

// The storage key is scoped by both companyId and agentId: sessionStorage is
// shared across the whole origin, and operators can switch between companies
// in the same browser session/tab without a reload. Without the companyId
// segment, an in-progress Slack manifest flow for agent "bot" in company A
// would be silently picked up (and potentially restored/resumed) while
// viewing agent "bot" in company B.
function getSlackManifestStateStorageKey(companyId: string, agentId: string): string {
  return `${SLACK_MANIFEST_STATE_STORAGE_PREFIX}${companyId}:${agentId}`;
}

function writeSlackManifestFlowState(companyId: string, agentId: string, state: string): void {
  try {
    window.sessionStorage.setItem(getSlackManifestStateStorageKey(companyId, agentId), state);
  } catch {
    // Persistence is best-effort; losing it only means the operator must
    // paste the state token manually via "Resume an existing manifest flow".
  }
}

function readSlackManifestFlowState(companyId: string, agentId: string): string | null {
  try {
    return window.sessionStorage.getItem(getSlackManifestStateStorageKey(companyId, agentId));
  } catch {
    return null;
  }
}

function deleteSlackManifestFlowState(companyId: string, agentId: string): void {
  try {
    window.sessionStorage.removeItem(getSlackManifestStateStorageKey(companyId, agentId));
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
  const { config, hasPersistedIdentity, updateField, refresh, deleteConfig, patchFormState, createSlackAppManifest, getSlackAppManifestFlow, discoverSlackInstallMetadata, saveSlackInstallMetadata, rebindLegacySlackCredentials, slackBotWhoami, checkSlackConnection, getSlackTelemetry, companyId } = input;

  // Slack posts events straight at the host's company-scoped webhook route, so
  // in a deployed Paperclip the Request URL is fully derivable and the operator
  // should never have to know it. It is only underivable in local development,
  // where the origin is plain HTTP and a public tunnel in front of
  // scripts/slack-events-adapter.mjs still has to be supplied by hand.
  const hostEventsRequestUrl = buildSlackEventsRequestUrl(
    typeof window === "undefined" ? "" : window.location.origin,
    companyId,
  );
  const effectiveEventsRequestUrl = config?.slackEventsRequestUrl.trim() || hostEventsRequestUrl || "";

  const [slackManifestFlow, setSlackManifestFlow] = useState<CreateSlackAppManifestResult | null>(null);
  const [slackManifestBusy, setSlackManifestBusy] = useState(false);
  const [slackSaveBusy, setSlackSaveBusy] = useState(false);
  const [slackManifestError, setSlackManifestError] = useState<string | null>(null);
  const [slackSaveResult, setSlackSaveResult] = useState<SaveSlackInstallMetadataResult | null>(null);
  const [slackManifestCopied, setSlackManifestCopied] = useState(false);
  const [slackDiscoveryBusy, setSlackDiscoveryBusy] = useState(false);
  const [slackDiscoveryError, setSlackDiscoveryError] = useState<string | null>(null);
  const [slackResumeStateInput, setSlackResumeStateInput] = useState("");
  const [slackResumeBusy, setSlackResumeBusy] = useState(false);
  const [slackResumeError, setSlackResumeError] = useState<string | null>(null);
  const [slackStatus, setSlackStatus] = useState<SlackBotWhoamiData | null>(null);
  const [slackStatusLoading, setSlackStatusLoading] = useState(false);
  const [slackStatusError, setSlackStatusError] = useState<string | null>(null);
  // DRO-1161: bounded live Slack "Connection" check state, kept fully
  // separate from slackStatus/slackStatusLoading/slackStatusError above so
  // Configured and Connection never collapse into one loading/error state.
  const [slackConnectionStatus, setSlackConnectionStatus] = useState<SlackConnectionCheckResult | null>(null);
  const [slackConnectionStatusLoading, setSlackConnectionStatusLoading] = useState(false);
  const [slackConnectionStatusError, setSlackConnectionStatusError] = useState<string | null>(null);
  const [slackConnectionStatusCheckedAtMs, setSlackConnectionStatusCheckedAtMs] = useState<number | null>(null);
  const slackConnectionStatusGenerationRef = useRef(0);
  // DRO-1187: read-only, bounded Ingress/Delivery telemetry projection --
  // fetched (not user-triggered) via get-slack-telemetry alongside the
  // Configured whoami check below. Never contains secrets/bodies; see
  // src/providers/slack/telemetry.ts.
  const [slackTelemetry, setSlackTelemetry] = useState<SlackTelemetryProjection | null>(null);
  const [slackTelemetryLoading, setSlackTelemetryLoading] = useState(false);
  const [slackTelemetryError, setSlackTelemetryError] = useState<string | null>(null);
  const [slackTelemetryFetchedAtMs, setSlackTelemetryFetchedAtMs] = useState<number | null>(null);
  const slackTelemetryGenerationRef = useRef(0);
  const [legacySlackRebindBusy, setLegacySlackRebindBusy] = useState(false);
  const [legacySlackRebindError, setLegacySlackRebindError] = useState<string | null>(null);
  const [legacySlackRebindResult, setLegacySlackRebindResult] = useState<LegacySlackCredentialRebindResult | null>(null);
  const slackStatusGenerationRef = useRef(0);
  const slackDiscoveryGenerationRef = useRef(0);
  // Finding #2: when the post-save rebind cleanup (deleteConfig(previousAgentId))
  // fails, the new identity is already saved and the flow already
  // consumed/deleted -- there is no "state" to retry the save itself. Track
  // just the stale agentId that still needs deleting so the UI can offer a
  // cleanup-only retry instead of telling the operator to redo a save that
  // would fail (the flow is gone) or silently leaving an orphaned identity.
  const [slackCleanupPendingAgentId, setSlackCleanupPendingAgentId] = useState<string | null>(null);
  const [slackCleanupBusy, setSlackCleanupBusy] = useState(false);
  const [slackCleanupError, setSlackCleanupError] = useState<string | null>(null);
  // Holds the save-slack-install-metadata result that succeeded but whose
  // rebind cleanup (deleteConfig(previousAgentId)) failed, so a later
  // successful retry can still mark the save complete (setSlackSaveResult)
  // without re-calling save-slack-install-metadata (whose one-time `state`
  // is already consumed).
  const slackCleanupPendingResultRef = useRef<SaveSlackInstallMetadataResult | null>(null);
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
    setSlackDiscoveryBusy(false);
    setSlackDiscoveryError(null);
    slackDiscoveryGenerationRef.current += 1;
    setSlackResumeStateInput("");
    setSlackResumeError(null);
    // Bump the create/restore generation so any in-flight
    // create-slack-app-manifest / get-slack-app-manifest-flow response
    // started before this reset is discarded when it arrives (finding #4/#8).
    slackManifestFlowGenerationRef.current += 1;
    // Bumping the generation makes the pending create/restore requests'
    // `finally` blocks skip their own busy-flag cleanup (the generation
    // check fails), so this reset must clear those busy flags itself --
    // otherwise an agent/label reset or dialog reopen while a
    // create-slack-app-manifest / get-slack-app-manifest-flow /
    // resume request is in flight would leave the Slack setup controls
    // disabled permanently.
    setSlackManifestBusy(false);
    setSlackResumeBusy(false);
    // Also invalidate an in-flight save-slack-install-metadata request: a
    // reset (e.g. starting a new/different identity, or closing the dialog)
    // means a stale response should never attach to whatever form comes
    // next. Mirrors the same generation-guard pattern used on field edits.
    slackSaveGenerationRef.current += 1;
    setSlackSaveBusy(false);
    // A pending cleanup retry is scoped to the identity that was just being
    // edited when deleteConfig(previousAgentId) failed. Starting a new/
    // different identity or closing the dialog abandons that in-context
    // retry UI; the stale identity itself still exists server-side, but it
    // is no longer this form's concern once the dialog moves on.
    setSlackCleanupPendingAgentId(null);
    setSlackCleanupError(null);
    setSlackCleanupBusy(false);
    slackCleanupPendingResultRef.current = null;
    setSlackStatus(null);
    setSlackStatusError(null);
    setSlackStatusLoading(false);
    slackStatusGenerationRef.current += 1;
    setLegacySlackRebindBusy(false);
    setLegacySlackRebindError(null);
    setLegacySlackRebindResult(null);
    // Cross-identity leak fix (DRO-1161 review): the live Connection check
    // result/error/loading/timestamp are keyed to whichever identity was
    // being viewed when the check ran. Closing/switching identities without
    // clearing this state let a stale "Connected" result from agent A render
    // under agent B's label. Bump the generation so any in-flight check
    // response is discarded, and clear all connection state so a new
    // identity always starts from "never checked".
    slackConnectionStatusGenerationRef.current += 1;
    setSlackConnectionStatus(null);
    setSlackConnectionStatusLoading(false);
    setSlackConnectionStatusError(null);
    setSlackConnectionStatusCheckedAtMs(null);
    // Same cross-identity leak concern applies to the DRO-1187 telemetry
    // projection -- clear it on reset so it never renders under a
    // different identity's label either.
    slackTelemetryGenerationRef.current += 1;
    setSlackTelemetry(null);
    setSlackTelemetryLoading(false);
    setSlackTelemetryError(null);
    setSlackTelemetryFetchedAtMs(null);
  }

  // Any edit to the Slack install fields invalidates a prior successful
  // save-slack-install-metadata result -- it was only valid for the exact
  // field values it was saved with. Watching config's slack* fields (rather
  // than requiring SettingsPage to call back in on every updateField) keeps
  // this entirely provider-owned.
  const slackFieldsSignature = config
    ? `${config.slackTeamId}|${config.slackAppId}|${config.slackBotUserId}|${config.slackDefaultChannel}|${config.slackBotTokenSecretId}|${config.slackSigningSecretId}`
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

  const slackDiscoverySecretSignature = config?.slackBotTokenSecretId ?? "";
  const prevSlackDiscoverySecretSignatureRef = useRef(slackDiscoverySecretSignature);
  useEffect(() => {
    if (prevSlackDiscoverySecretSignatureRef.current === slackDiscoverySecretSignature) return;
    prevSlackDiscoverySecretSignatureRef.current = slackDiscoverySecretSignature;
    slackDiscoveryGenerationRef.current += 1;
    setSlackDiscoveryBusy(false);
    setSlackDiscoveryError(null);
  }, [slackDiscoverySecretSignature]);

  // Check the Slack capability/identity status via slack_bot_whoami whenever
  // this credential step mounts for a saved Slack identity (i.e. there's
  // something to check). Only runs for an already-configured identity --
  // there's nothing to look up yet for a brand-new one still being set up.
  useEffect(() => {
    if (!config || config.provider !== SLACK_IDENTITY_PROVIDER_ID) return;
    if (!hasPersistedIdentity || !config.agentId.trim()) {
      slackStatusGenerationRef.current += 1;
      setSlackStatus(null);
      setSlackStatusError(null);
      setSlackStatusLoading(false);
      return;
    }
    void handleCheckSlackStatus();
    // Re-check when a just-saved identity appears in refreshed settings, when
    // switching to a different persisted agent, or after a label edit resets
    // the provider-owned state. Form-field presence is not evidence that a
    // new wizard row has been saved yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.agentId, config?.label, config?.provider, hasPersistedIdentity]);

  // DRO-1187: fetch the read-only Ingress/Delivery telemetry projection
  // alongside the Configured whoami check above -- there is no live check to
  // trigger (unlike Connection), it's just a projection of what's already
  // been recorded, so it loads whenever the identity changes rather than
  // needing a manual button.
  useEffect(() => {
    if (!config || config.provider !== SLACK_IDENTITY_PROVIDER_ID) return;
    if (!hasPersistedIdentity || !config.agentId.trim()) {
      slackTelemetryGenerationRef.current += 1;
      setSlackTelemetry(null);
      setSlackTelemetryError(null);
      setSlackTelemetryLoading(false);
      setSlackTelemetryFetchedAtMs(null);
      return;
    }
    void handleRefreshSlackTelemetry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.agentId, config?.label, config?.provider, hasPersistedIdentity]);

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
    const storedState = readSlackManifestFlowState(companyId, agentId);
    if (!storedState) return;

    let cancelled = false;
    const generation = slackManifestFlowGenerationRef.current;
    void getSlackAppManifestFlow({ state: storedState })
      .then((result) => {
        if (cancelled || slackManifestFlowGenerationRef.current !== generation) return;
        const flow = result as GetSlackAppManifestFlowResult;
        if (flow.agentId !== agentId) {
          deleteSlackManifestFlowState(companyId, agentId);
          return;
        }
        // The worker persists flow.label alongside flow.agentId (see
        // app-manifest.ts). If the label was edited (or the flow belongs to
        // a differently-labeled setup) since the flow was created, restoring
        // it silently would let the UI show one label while
        // save-slack-install-metadata records another. Reject a
        // label-mismatched flow rather than restoring it.
        if (config.label.trim() && flow.label && flow.label !== config.label.trim()) {
          deleteSlackManifestFlowState(companyId, agentId);
          return;
        }
        if (config.slackEventsRequestUrl.trim() && flow.eventsRequestUrl !== config.slackEventsRequestUrl.trim()) {
          deleteSlackManifestFlowState(companyId, agentId);
          return;
        }
        if (!config.slackEventsRequestUrl.trim()) {
          updateField("slackEventsRequestUrl", flow.eventsRequestUrl);
        }
        setSlackManifestFlow(flow);
        setSlackManifestCopied(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // Only drop the stored state pointer when the server has
        // definitively told us the flow is gone (unknown/expired/consumed --
        // see loadUnexpiredUnconsumedFlow in app-manifest.ts). A transient
        // failure (network error, bridge hiccup, unexpected 5xx) is not
        // proof the flow is invalid; deleting the pointer on those would
        // destroy the operator's only automatic resume path and force them
        // to create a whole new Slack App. Leave the pointer in place and
        // just surface the error so the next mount/retry can try again.
        const message = err instanceof Error ? err.message : String(err);
        const isDefinitivelyGone = /unknown or expired|already been used|has expired/i.test(message);
        if (isDefinitivelyGone) {
          deleteSlackManifestFlowState(companyId, agentId);
        } else {
          setSlackManifestError(
            `Could not restore the in-progress Slack App manifest flow (${message}). It has not been discarded - reload or try again.`,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config, getSlackAppManifestFlow, slackManifestFlow, companyId]);

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
      if (config.slackEventsRequestUrl.trim() && flow.eventsRequestUrl !== config.slackEventsRequestUrl.trim()) {
        throw new Error("This state token belongs to a different Events Request URL than the one currently entered.");
      }
      if (!config.slackEventsRequestUrl.trim()) {
        updateField("slackEventsRequestUrl", flow.eventsRequestUrl);
      }
      setSlackManifestFlow(flow);
      setSlackManifestCopied(false);
      setSlackManifestError(null);
      writeSlackManifestFlowState(companyId, config.agentId.trim(), flow.state);
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
        eventsRequestUrl: effectiveEventsRequestUrl,
      }) as CreateSlackAppManifestResult;
      // Discard this response if the dialog/form that initiated the request
      // is no longer current (finding #4): a reset in between (edit, close,
      // switching identity) must not let a late create response attach to a
      // different form.
      if (slackManifestFlowGenerationRef.current !== generation) return;
      setSlackManifestFlow(result);
      // Echo the URL that actually went into the manifest back into the field.
      // When the operator left it blank we used the derived host route, and the
      // field is the only place they can see (and later verify against Slack)
      // what was embedded -- it also keeps the save-result comparisons in
      // getValidation/credentialComplete matching on a concrete value.
      updateField("slackEventsRequestUrl", result.eventsRequestUrl);
      setSlackManifestCopied(false);
      writeSlackManifestFlowState(companyId, config.agentId.trim(), result.state);
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
      const signingSecretId = config.slackSigningSecretId.trim();
      const result = await saveSlackInstallMetadata({
        state: slackManifestFlow.state,
        agentId: targetAgentId,
        teamId: config.slackTeamId.trim(),
        appId: config.slackAppId.trim(),
        botUserId: config.slackBotUserId.trim(),
        botTokenSecretId,
        signingSecretId,
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
          //
          // Note: the install metadata itself IS already saved and the
          // one-time manifest flow is already consumed/deleted at this
          // point, so re-running handleSaveSlackInstallMetadata is not a
          // valid retry (its `state` no longer exists). Track the stale
          // agentId so the UI can offer a cleanup-only retry
          // (handleRetrySlackCleanup) instead.
          setSlackManifestError(
            `Slack install metadata saved, but could not remove the previous identity for ${previousAgentId}: ${err instanceof Error ? err.message : "unknown error"}. Use "Retry cleanup" below.`
          );
          setSlackCleanupPendingAgentId(previousAgentId);
          setSlackCleanupError(null);
          slackCleanupPendingResultRef.current = result;
          // The manifest's one-time state was already consumed by the
          // successful save above, even though the rebind cleanup failed.
          // Clear the in-memory flow now (not just the sessionStorage
          // pointer) so the credential step can no longer be re-submitted
          // against this already-consumed state -- e.g. by editing a field,
          // which would otherwise clear slackSaveResult and re-enable "Save
          // Slack install metadata" pointed at a flow that is guaranteed to
          // fail (finding: consumed-state resubmission).
          setSlackManifestFlow(null);
          deleteSlackManifestFlowState(companyId, targetAgentId);
          await refresh();
          // The new identity is already persisted even though removing the
          // previous identity failed. Re-check it now so the status panel
          // does not keep the pre-save "identity unavailable" result while
          // the operator uses the cleanup-only retry path.
          await handleCheckSlackStatus();
          return;
        }
      }
      setSlackSaveResult(result);
      // Clear the in-memory manifest flow (not just the sessionStorage
      // pointer) now that its one-time state has been consumed by this
      // successful save. Otherwise editing any Slack field afterward clears
      // slackSaveResult (via the signature effect) and re-enables "Save
      // Slack install metadata" while slackManifestFlow still looks active,
      // guaranteeing the retry fails against an already-consumed state.
      setSlackManifestFlow(null);
      deleteSlackManifestFlowState(companyId, targetAgentId);
      // Record the just-saved identity as the form's "previous" identity before
      // refreshing. Otherwise refresh() adds this identity to `identities`, and
      // duplicateIdentity (which compares against previousAgentId) would then
      // treat the freshly-saved identity as a duplicate of itself and disable
      // the footer's "Save agent" button.
      patchFormState((prev) => ({ ...prev, previousAgentId: result.agentId }));
      await refresh();
      // For an identity that was already persisted, hasPersistedIdentity
      // stays true across this save, so the mount/identity effect above has
      // no dependency transition to trigger a new lookup. Re-read the
      // configured metadata explicitly after the successful update. New
      // identities still use the false -> true persisted-state transition
      // after refresh, avoiding a duplicate lookup on their first save.
      if (hasPersistedIdentity) {
        await handleCheckSlackStatus();
      }
    } catch (err) {
      if (slackSaveGenerationRef.current !== generation) return;
      setSlackManifestError(err instanceof Error ? err.message : "Failed to save Slack install metadata");
    } finally {
      if (slackSaveGenerationRef.current === generation) {
        setSlackSaveBusy(false);
      }
    }
  }

  async function handleDiscoverSlackInstallMetadata() {
    if (!config) return;
    const botTokenSecretId = config.slackBotTokenSecretId.trim();
    if (!botTokenSecretId) return;
    const generation = ++slackDiscoveryGenerationRef.current;
    setSlackDiscoveryBusy(true);
    setSlackDiscoveryError(null);
    try {
      const result = await discoverSlackInstallMetadata({ botTokenSecretId }) as DiscoverSlackInstallMetadataResult;
      if (slackDiscoveryGenerationRef.current !== generation) return;
      const teamId = result.teamId?.trim();
      const botUserId = result.botUserId?.trim();
      const appId = result.appId?.trim();
      if (!teamId || !botUserId || !appId) {
        throw new Error("Slack did not return the workspace ID, App ID, and bot user ID for this token.");
      }
      updateField("slackTeamId", teamId);
      updateField("slackAppId", appId);
      updateField("slackBotUserId", botUserId);
    } catch (err) {
      if (slackDiscoveryGenerationRef.current !== generation) return;
      setSlackDiscoveryError(actionErrorMessage(err, "Could not detect Slack installation metadata"));
    } finally {
      if (slackDiscoveryGenerationRef.current === generation) {
        setSlackDiscoveryBusy(false);
      }
    }
  }

  // Cleanup-only retry for finding #2: re-attempt just the
  // deleteConfig(previousAgentId) rebind cleanup that failed after
  // save-slack-install-metadata already succeeded. Deliberately does not
  // re-call saveSlackInstallMetadata -- the manifest flow's one-time `state`
  // token is already consumed/deleted by the earlier successful save, so
  // retrying the save itself would fail with a stale/expired-flow error.
  async function handleRetrySlackCleanup() {
    const pendingAgentId = slackCleanupPendingAgentId;
    const pendingResult = slackCleanupPendingResultRef.current;
    if (!pendingAgentId || !pendingResult) return;
    // Reuse the save generation counter as a stale-response guard: reset()
    // (dialog close, agent/label/provider change, starting a different
    // identity) bumps it and clears the cleanup-pending state. If that
    // happens while this delete is in flight, the response below must not
    // apply patchFormState/setSlackSaveResult to whatever form is now
    // current (Copilot finding: cleanup retry has no stale-response guard).
    const generation = slackSaveGenerationRef.current;
    setSlackCleanupBusy(true);
    setSlackCleanupError(null);
    try {
      await deleteConfig({ agentId: pendingAgentId, provider: SLACK_IDENTITY_PROVIDER_ID });
      if (slackSaveGenerationRef.current !== generation) return;
      setSlackCleanupPendingAgentId(null);
      slackCleanupPendingResultRef.current = null;
      setSlackManifestError(null);
      // The install metadata was already saved by the original request; now
      // that cleanup has finally succeeded, mark the save complete so
      // credentialComplete/isComplete reflect reality.
      setSlackSaveResult(pendingResult);
      patchFormState((prev) => ({ ...prev, previousAgentId: pendingResult.agentId }));
      await refresh();
    } catch (err) {
      if (slackSaveGenerationRef.current !== generation) return;
      setSlackCleanupError(
        err instanceof Error ? err.message : `Failed to remove the previous identity for ${pendingAgentId}`,
      );
    } finally {
      if (slackSaveGenerationRef.current === generation) {
        setSlackCleanupBusy(false);
      }
    }
  }

  // Capability/identity status readout (DRO-976 increment #2): calls the
  // credential-free `slack_bot_whoami` tool the exact same way SettingsPage
  // obtains any other plugin action (usePluginAction), threaded in here as
  // `slackBotWhoami`. Only ever reads back the non-secret identity/status
  // fields the tool itself returns (see tools/whoami.ts's `perform`). The
  // bot token is resolved only inside the worker and never enters this response.
  async function handleCheckSlackStatus() {
    const agentId = config?.agentId?.trim();
    if (!agentId) return;
    const generation = ++slackStatusGenerationRef.current;
    setSlackStatusLoading(true);
    setSlackStatusError(null);
    try {
      const result = (await slackBotWhoami({ agentId, companyId })) as
        | { data?: SlackBotWhoamiData; error?: string }
        | SlackBotWhoamiData;
      if (slackStatusGenerationRef.current !== generation) return;
      // The action can *resolve* (not reject) with a `{ error }` shape when
      // the tool itself reports a handled failure (e.g. no bound identity).
      // Treat that the same as a thrown error -- never let a resolved
      // `{ error }` fall through to the configured-metadata render.
      const resultError = (result as { error?: unknown })?.error;
      if (resultError) {
        setSlackStatus(null);
        setSlackStatusError(typeof resultError === "string" ? resultError : "Identity metadata unavailable");
        return;
      }
      const data = (result as { data?: SlackBotWhoamiData })?.data ?? (result as SlackBotWhoamiData);
      setSlackStatus(data ?? null);
    } catch (err) {
      if (slackStatusGenerationRef.current !== generation) return;
      setSlackStatus(null);
      // Deliberately surface only the error message (never the raw
      // rejection payload/response), and fall back to a secret-free generic
      // "Identity metadata unavailable" message if the tool didn't provide one.
      setSlackStatusError(err instanceof Error ? err.message : "Identity metadata unavailable");
    } finally {
      if (slackStatusGenerationRef.current === generation) {
        setSlackStatusLoading(false);
      }
    }
  }

  // DRO-1161: bounded live Slack "Connection" check -- calls
  // `check-slack-connection` (a bounded server-side Slack `auth.test`
  // against the resolved bot credential). This is distinct from
  // handleCheckSlackStatus above: that reflects only saved/configured
  // metadata and never verifies the token is still valid, while this
  // actually authenticates. Never receives the token itself; the worker
  // resolves and discards it entirely within the action handler.
  async function handleCheckSlackConnection() {
    const agentId = config?.agentId?.trim();
    if (!agentId) return;
    const generation = ++slackConnectionStatusGenerationRef.current;
    setSlackConnectionStatusLoading(true);
    setSlackConnectionStatusError(null);
    try {
      const result = (await checkSlackConnection({ agentId, companyId })) as SlackConnectionCheckResult;
      if (slackConnectionStatusGenerationRef.current !== generation) return;
      setSlackConnectionStatus(result);
      if (result?.outcome?.ok) {
        setSlackConnectionStatusCheckedAtMs(Date.now());
      }
    } catch (err) {
      if (slackConnectionStatusGenerationRef.current !== generation) return;
      // Preserve the last known result on a refresh failure (per DRO-1161's
      // "UI preserves the last known state on refresh failure and marks it
      // stale" requirement) -- do not clear slackConnectionStatus here.
      setSlackConnectionStatusError(
        err instanceof Error ? err.message : "Slack connection check failed to run.",
      );
    } finally {
      if (slackConnectionStatusGenerationRef.current === generation) {
        setSlackConnectionStatusLoading(false);
      }
    }
  }

  // DRO-1187: read-only Ingress/Delivery telemetry projection. On a refresh
  // failure, preserves the last-known telemetry (does not clear it) so the
  // panels can mark it stale, mirroring handleCheckSlackConnection above.
  async function handleRefreshSlackTelemetry() {
    const agentId = config?.agentId?.trim();
    if (!agentId) return;
    const generation = ++slackTelemetryGenerationRef.current;
    setSlackTelemetryLoading(true);
    setSlackTelemetryError(null);
    try {
      const result = (await getSlackTelemetry({ agentId, companyId })) as SlackTelemetryProjection;
      if (slackTelemetryGenerationRef.current !== generation) return;
      setSlackTelemetry(result);
      setSlackTelemetryFetchedAtMs(Date.now());
    } catch (err) {
      if (slackTelemetryGenerationRef.current !== generation) return;
      setSlackTelemetryError(
        err instanceof Error ? err.message : "Slack ingress/delivery telemetry could not be refreshed.",
      );
    } finally {
      if (slackTelemetryGenerationRef.current === generation) {
        setSlackTelemetryLoading(false);
      }
    }
  }

  // Confirmation-gated reinstall: re-runs the same manifest-assisted setup
  // flow as "Create Slack App manifest" (handleCreateSlackAppManifest),
  // against an already-configured identity row. Mirrors GitHub's "Replace
  // this GitHub App with a new manifest-created app" collapsed-details
  // pattern (settings-adapter-ui.tsx:467-480 in the GitHub adapter).
  async function handleReinstallSlackApp() {
    if (!config) return;
    const confirmed = window.confirm(
      "Reinstall the Slack App for this identity? This creates a new Slack App manifest flow; you'll need to re-create/reinstall the app on Slack and paste back the resulting IDs and bot token secret.",
    );
    if (!confirmed) return;
    await handleCreateSlackAppManifest();
  }

  async function handleLegacySlackRebind() {
    if (!config?.agentId.trim()) return;
    const signingSecretId = config.slackSigningSecretId.trim();
    if (config.slackLegacySigningSecretRequired === "true" && !signingSecretId) {
      setLegacySlackRebindError(
        "Select or enter the Paperclip company secret UUID containing the Slack signing secret before rebinding.",
      );
      return;
    }
    setLegacySlackRebindBusy(true);
    setLegacySlackRebindError(null);
    try {
      const result = await rebindLegacySlackCredentials({
        agentId: config.agentId.trim(),
        ...(signingSecretId ? { signingSecretId } : {}),
      }) as LegacySlackCredentialRebindResult;
      setLegacySlackRebindResult(result);
      await refresh();
    } catch (error) {
      setLegacySlackRebindResult(null);
      setLegacySlackRebindError(actionErrorMessage(error, "Could not rebind released Slack credentials"));
    } finally {
      setLegacySlackRebindBusy(false);
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
    slackDiscoveryBusy,
    slackDiscoveryError,
    setSlackManifestCopied,
    setSlackManifestError,
    slackResumeStateInput,
    setSlackResumeStateInput,
    slackResumeBusy,
    slackResumeError,
    handleResumeSlackAppManifestFlow,
    handleCreateSlackAppManifest,
    handleDiscoverSlackInstallMetadata,
    handleSaveSlackInstallMetadata,
    slackCleanupPendingAgentId,
    slackCleanupBusy,
    slackCleanupError,
    handleRetrySlackCleanup,
    slackStatus,
    slackStatusLoading,
    slackStatusError,
    handleCheckSlackStatus,
    slackConnectionStatus,
    slackConnectionStatusLoading,
    slackConnectionStatusError,
    slackConnectionStatusCheckedAtMs,
    handleCheckSlackConnection,
    slackTelemetry,
    slackTelemetryLoading,
    slackTelemetryError,
    slackTelemetryFetchedAtMs,
    handleRefreshSlackTelemetry,
    hasPersistedIdentity,
    handleReinstallSlackApp,
    legacySlackRebindBusy,
    legacySlackRebindError,
    legacySlackRebindResult,
    handleLegacySlackRebind,
    updateField,
    secretOptions: input.secretOptions,
    secretsLoading: input.secretsLoading,
    secretsError: input.secretsError,
    companyId: input.companyId,
    refreshSecrets: input.refreshSecrets,
    missingSecretIds: input.missingSecretIds,
    hostEventsRequestUrl,
    effectiveEventsRequestUrl,
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
  discoverSlackInstallMetadata: (input: Record<string, unknown>) => Promise<unknown>;
  saveSlackInstallMetadata: (input: Record<string, unknown>) => Promise<unknown>;
  rebindLegacySlackCredentials: (input: Record<string, unknown>) => Promise<unknown>;
  // The credential-free `slack_bot_whoami` tool (DRO-972), invoked identically
  // to the actions above via `usePluginAction` in SettingsPage.
  slackBotWhoami: (input: Record<string, unknown>) => Promise<unknown>;
  // DRO-1161: bounded live Slack "Connection" check (auth.test against the
  // resolved bot credential), distinct from slackBotWhoami above.
  checkSlackConnection: (input: Record<string, unknown>) => Promise<unknown>;
  // DRO-1187: read-only bounded Ingress/Delivery telemetry projection.
  getSlackTelemetry: (input: Record<string, unknown>) => Promise<unknown>;
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
    return "No Paperclip secrets were found; paste the bot token secret UUID manually.";
  }
  return "Saved as a Paperclip secret reference for the Slack bot token. There is no private-key or file fallback for Slack.";
}

function getSigningSecretFieldHint(input: {
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
    return "No Paperclip secrets were found; paste the signing secret UUID manually.";
  }
  return "Saved as a Paperclip secret reference for Slack request signature verification.";
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
    slackDiscoveryBusy,
    slackDiscoveryError,
    setSlackManifestCopied,
    setSlackManifestError,
    slackResumeStateInput,
    setSlackResumeStateInput,
    slackResumeBusy,
    slackResumeError,
    handleResumeSlackAppManifestFlow,
    handleCreateSlackAppManifest,
    handleDiscoverSlackInstallMetadata,
    handleSaveSlackInstallMetadata,
    slackCleanupPendingAgentId,
    slackCleanupBusy,
    slackCleanupError,
    handleRetrySlackCleanup,
    slackStatus,
    slackStatusLoading,
    slackStatusError,
    slackConnectionStatus,
    slackConnectionStatusLoading,
    slackConnectionStatusError,
    slackConnectionStatusCheckedAtMs,
    handleCheckSlackConnection,
    slackTelemetry,
    slackTelemetryLoading,
    slackTelemetryError,
    slackTelemetryFetchedAtMs,
    handleRefreshSlackTelemetry,
    handleReinstallSlackApp,
    legacySlackRebindBusy,
    legacySlackRebindError,
    legacySlackRebindResult,
    handleLegacySlackRebind,
    hasPersistedIdentity,
    validationExtra,
    updateField,
    secretOptions,
    secretsLoading,
    secretsError,
    companyId,
    refreshSecrets,
    missingSecretIds,
    hostEventsRequestUrl,
    effectiveEventsRequestUrl,
  } = state;
  const hasSecretOptions = secretOptions.length > 0;
  const credentialComplete = Boolean(
    slackSaveResult
      && slackSaveResult.teamId === config.slackTeamId.trim()
      && slackSaveResult.appId === config.slackAppId.trim()
      && slackSaveResult.botUserId === config.slackBotUserId.trim()
      && slackSaveResult.eventsRequestUrl === config.slackEventsRequestUrl.trim()
      && slackSaveResult.botTokenSecretId === config.slackBotTokenSecretId.trim()
      && slackSaveResult.signingSecretId === config.slackSigningSecretId.trim()
      && (slackSaveResult.defaultChannel ?? "") === config.slackDefaultChannel.trim()
      && !validationExtra.slackSaveBusy,
  );
  const hasLegacyCredentialRecovery = Boolean(config.slackLegacyCredentialStatus);

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>Slack App setup</legend>
      {hasPersistedIdentity && (
        <SlackStatusPanel
          agentId={config.agentId}
          label={config.label}
          loading={slackStatusLoading}
          status={slackStatus}
          error={slackStatusError}
        />
      )}
      {hasPersistedIdentity && (
        <SlackConnectionStatusPanel
          agentId={config.agentId}
          label={config.label}
          loading={slackConnectionStatusLoading}
          result={slackConnectionStatus}
          error={slackConnectionStatusError}
          lastSuccessAtMs={slackConnectionStatusCheckedAtMs}
          onCheck={handleCheckSlackConnection}
        />
      )}
      {hasPersistedIdentity && (
        <SlackIngressStatusPanel
          agentId={config.agentId}
          label={config.label}
          loading={slackTelemetryLoading}
          telemetry={slackTelemetry?.ingress ?? null}
          error={slackTelemetryError}
          lastFetchedAtMs={slackTelemetryFetchedAtMs}
        />
      )}
      {hasPersistedIdentity && (
        <SlackDeliveryStatusPanel
          agentId={config.agentId}
          label={config.label}
          loading={slackTelemetryLoading}
          telemetry={slackTelemetry?.delivery ?? null}
          error={slackTelemetryError}
          lastFetchedAtMs={slackTelemetryFetchedAtMs}
        />
      )}
      {hasPersistedIdentity && config.slackLegacyCredentialStatus && (
        <LegacySlackCredentialRebindPanel
          status={config.slackLegacyCredentialStatus}
          signingSecretRequired={config.slackLegacySigningSecretRequired === "true"}
          signingSecretReady={Boolean(config.slackSigningSecretId.trim())}
          busy={legacySlackRebindBusy}
          error={legacySlackRebindError}
          result={legacySlackRebindResult}
          onRebind={handleLegacySlackRebind}
        />
      )}
      {!credentialComplete && !hasLegacyCredentialRecovery && (
        <div style={validationNoticeStyle}>
          Create the Slack App manifest, install it, and paste back the team/app/bot IDs plus bot token and signing
          secret references, then save install metadata before this identity can be saved. Do not verify the Request
          URL in Slack yet. Paperclip cannot answer Slack's verification challenge until the signing secret reference
          has been saved.
        </div>
      )}

      {!hasLegacyCredentialRecovery && <div style={inlineNoticeStyle}>
        <strong>Create a Slack App from a manifest.</strong> Slack does not support a prefilled deep link for manifests,
        so Paperclip generates the manifest JSON below for you to copy, then opens the plain Slack "create app" page
        where you paste it in via "From an app manifest".
      </div>}

      {!hasLegacyCredentialRecovery && <label style={fieldStyle}>
        <span>Events Request URL {!hostEventsRequestUrl && <span style={requiredStyle}>*</span>}</span>
        <input
          type="url"
          value={config.slackEventsRequestUrl}
          onChange={(e) => updateField("slackEventsRequestUrl", e.target.value)}
          placeholder={hostEventsRequestUrl ?? "https://your-public-tunnel.example/events"}
          style={inputStyle}
          disabled={slackManifestBusy || slackSaveBusy || Boolean(slackManifestFlow)}
        />
        <span style={hintStyle}>
          {hostEventsRequestUrl
            ? "Leave blank to use this Paperclip deployment's own Slack Events endpoint (shown greyed out in the field) - the host serves it, so no tunnel is needed. Override it only to point Slack somewhere else, such as a public tunnel during local development."
            : "Public HTTPS URL Slack should post events to. This deployment is not served over HTTPS, so paste the public tunnel URL in front of your local Slack Events adapter (its path is /events)."}
        </span>
      </label>}

      {!hasPersistedIdentity && (
        <div style={formActionsStyle}>
          <button
            type="button"
            onClick={() => void handleCreateSlackAppManifest()}
            disabled={
              slackManifestBusy ||
              slackSaveBusy ||
              slackResumeBusy ||
              !config.agentId ||
              !config.label ||
              !effectiveEventsRequestUrl
            }
            style={secondaryButtonStyle}
          >
            {slackManifestBusy ? "Working..." : "Create Slack App manifest"}
          </button>
        </div>
      )}

      {!hasLegacyCredentialRecovery && !slackManifestFlow && (
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
            <textarea
              readOnly
              value={slackManifestFlow.manifest}
              style={{ ...textareaStyle, minHeight: 320, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            />
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
            Slack creates and you install the app, come back and paste the resulting IDs below. Slack may show the
            Request URL as unverified. Leave it unverified until you save the signing secret reference in Paperclip.
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
          disabled={slackSaveBusy}
        />
      </label>

      <label style={fieldStyle}>
        <span>App ID <span style={requiredStyle}>*</span></span>
        <input
          type="text"
          value={config.slackAppId}
          onChange={(e) => updateField("slackAppId", normalizeSlackAppIdInput(e.target.value))}
          placeholder="A0123456789 or https://api.slack.com/apps/A0123456789/general"
          style={inputStyle}
          disabled={slackSaveBusy}
        />
        <span style={hintStyle}>Paste the App ID or the Slack app settings URL. Paperclip extracts the App ID from the URL.</span>
      </label>

      <label style={fieldStyle}>
        <span>Bot User ID <span style={requiredStyle}>*</span></span>
        <input
          type="text"
          value={config.slackBotUserId}
          onChange={(e) => updateField("slackBotUserId", e.target.value)}
          placeholder="e.g. U0123456789"
          style={inputStyle}
          disabled={slackSaveBusy}
        />
      </label>

      {!hasLegacyCredentialRecovery && (
        <RefreshSecretsButton onRefresh={refreshSecrets} secretsLoading={secretsLoading} disabled={!companyId} />
      )}

      {!hasLegacyCredentialRecovery && <label style={fieldStyle}>
        <span>Bot token Paperclip secret UUID <span style={requiredStyle}>*</span></span>
        {hasSecretOptions ? (
          <select
            value={config.slackBotTokenSecretId}
            onChange={(e) => updateField("slackBotTokenSecretId", e.target.value)}
            style={inputStyle}
            disabled={slackSaveBusy || slackDiscoveryBusy}
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
            disabled={slackSaveBusy || slackDiscoveryBusy}
          />
        )}
        <span style={hintStyle}>{getSecretFieldHint({ companyId, secretsLoading, secretsError, hasSecretOptions })} The bot token itself is never stored in this config; only the secret reference is.</span>
        {getMissingSecretIdError(config.slackBotTokenSecretId, missingSecretIds, "bot token") && (
          <span style={errorStyle}>{getMissingSecretIdError(config.slackBotTokenSecretId, missingSecretIds, "bot token")}</span>
        )}
      </label>}


      {!hasLegacyCredentialRecovery && <div style={formActionsStyle}>
        <button
          type="button"
          onClick={() => void handleDiscoverSlackInstallMetadata()}
          disabled={slackSaveBusy || slackDiscoveryBusy || !config.slackBotTokenSecretId.trim()}
          style={secondaryButtonStyle}
        >
          {slackDiscoveryBusy ? "Detecting..." : "Detect Slack installation IDs"}
        </button>
        <span style={hintStyle}>
          Uses the selected bot token secret to fill Team ID, App ID, and Bot User ID.
        </span>
      </div>}
      {!hasLegacyCredentialRecovery && slackDiscoveryError && <span style={errorStyle}>{slackDiscoveryError}</span>}

      {(!hasLegacyCredentialRecovery || config.slackLegacySigningSecretRequired === "true") && <label style={fieldStyle}>
        <span>Signing secret Paperclip secret UUID <span style={requiredStyle}>*</span></span>
        {hasSecretOptions ? (
          <select
            value={config.slackSigningSecretId}
            onChange={(e) => updateField("slackSigningSecretId", e.target.value)}
            style={inputStyle}
            disabled={slackSaveBusy}
          >
            <option value="">No signing secret reference</option>
            {config.slackSigningSecretId && !secretOptions.some((secret) => secret.id === config.slackSigningSecretId) && (
              <option value={config.slackSigningSecretId}>{config.slackSigningSecretId} (saved)</option>
            )}
            {secretOptions.map((secret) => (
              <option key={secret.id} value={secret.id}>{formatSecretOption(secret)}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={config.slackSigningSecretId}
            onChange={(e) => updateField("slackSigningSecretId", e.target.value)}
            placeholder="Company secret UUID containing the Slack signing secret"
            style={inputStyle}
            disabled={slackSaveBusy}
          />
        )}
        <span style={hintStyle}>
          {getSigningSecretFieldHint({ companyId, secretsLoading, secretsError, hasSecretOptions })} The signing secret
          itself is never stored in this config; only the secret reference is.
        </span>
        {getMissingSecretIdError(config.slackSigningSecretId, missingSecretIds, "signing secret") && (
          <span style={errorStyle}>{getMissingSecretIdError(config.slackSigningSecretId, missingSecretIds, "signing secret")}</span>
        )}
      </label>}

      <label style={fieldStyle}>
        <span>Default channel</span>
        <input
          type="text"
          value={config.slackDefaultChannel}
          onChange={(e) => updateField("slackDefaultChannel", e.target.value)}
          placeholder="e.g. C0123456789"
          style={inputStyle}
          disabled={slackSaveBusy}
        />
        <span style={hintStyle}>Optional. Must be a Slack conversation ID starting with C, D, or G.</span>
      </label>

      {!hasLegacyCredentialRecovery && <div style={formActionsStyle}>
        <button
          type="button"
          onClick={() => void handleSaveSlackInstallMetadata()}
          disabled={
            slackManifestBusy ||
            slackSaveBusy ||
            Boolean(slackCleanupPendingAgentId) ||
            !slackManifestFlow ||
            !config.slackTeamId.trim() ||
            !config.slackAppId.trim() ||
            !config.slackBotUserId.trim() ||
            !config.slackBotTokenSecretId.trim() ||
            !config.slackSigningSecretId.trim() ||
            // DRO-1155: a selected bot-token/signing-secret ref that no
            // longer resolves to a real secret must block the save action,
            // matching getValidation's credentialComplete rule -- not just
            // display an error alongside a still-clickable button.
            missingSecretIds.has(config.slackBotTokenSecretId.trim()) ||
            missingSecretIds.has(config.slackSigningSecretId.trim())
          }
          style={secondaryButtonStyle}
        >
          {slackSaveBusy ? "Saving..." : "Save Slack install metadata"}
        </button>
      </div>}

      {!hasLegacyCredentialRecovery && !slackManifestFlow && !slackCleanupPendingAgentId && !slackSaveResult && (
        <span style={hintStyle}>Create the manifest above first; saving install metadata requires an active manifest flow state.</span>
      )}

      {slackCleanupPendingAgentId && (
        <div style={validationNoticeStyle}>
          <div>
            Slack install metadata was saved, but Paperclip could not remove the previous identity for{" "}
            <strong>{slackCleanupPendingAgentId}</strong>. The new identity is safe; retry cleanup below rather than
            saving again (the manifest flow used for this save has already been consumed).
          </div>
          <div style={formActionsStyle}>
            <button
              type="button"
              onClick={() => void handleRetrySlackCleanup()}
              disabled={slackCleanupBusy}
              style={secondaryButtonStyle}
            >
              {slackCleanupBusy ? "Retrying..." : "Retry cleanup"}
            </button>
          </div>
          {slackCleanupError && <span style={errorStyle}>{slackCleanupError}</span>}
        </div>
      )}

      {slackSaveResult && (
        <div style={successStyle}>
          Slack install metadata saved for team {slackSaveResult.teamId}. Return to Slack's App Manifest page now,
          verify the Request URL, and save the manifest changes. If verification failed before this save, retry it now.
        </div>
      )}

      {hasPersistedIdentity && !hasLegacyCredentialRecovery && (
        <details>
          <summary>Reinstall the Slack App for this identity</summary>
          <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}>
            <div style={inlineNoticeStyle}>
              <strong>Reinstall from a manifest.</strong> This re-runs Slack App setup for this identity - creating a
              new manifest flow, requiring you to reinstall the app on Slack and paste back the resulting IDs and bot
              token secret. It does not remove the currently saved install metadata unless you save over it.
            </div>
            <div style={formActionsStyle}>
              <button
                type="button"
                onClick={() => void handleReinstallSlackApp()}
                disabled={
                  slackManifestBusy ||
                  slackSaveBusy ||
                  slackResumeBusy ||
                  !effectiveEventsRequestUrl
                }
                style={secondaryButtonStyle}
              >
                {slackManifestBusy ? "Working..." : "Reinstall"}
              </button>
            </div>
          </div>
        </details>
      )}
    </fieldset>
  );
}

function LegacySlackCredentialRebindPanel(props: {
  status: string;
  signingSecretRequired: boolean;
  signingSecretReady: boolean;
  busy: boolean;
  error: string | null;
  result: LegacySlackCredentialRebindResult | null;
  onRebind: () => Promise<void>;
}) {
  if (props.status === "conflict") {
    return (
      <div style={validationNoticeStyle}>
        <strong>Released Slack credentials need operator review.</strong> The existing company Slack binding conflicts
        with the public identity or released sidecar references. Paperclip will not overwrite it. Remove or correct
        the conflicting host binding, then reopen this identity and rebind; reinstall is not required.
      </div>
    );
  }

  const cleanupPending = props.status === "cleanup-pending" || props.result?.status === "cleanup-pending";
  return (
    <div style={cleanupPending ? inlineNoticeStyle : validationNoticeStyle}>
      <div>
        <strong>{cleanupPending ? "Legacy Slack sidecar cleanup pending." : "Upgrade action required."}</strong>{" "}
        {cleanupPending
          ? "The company host binding is working. Retry to remove only the released Slack sidecar entry."
          : "Slack v0.1.7/v0.1.8 saved credential UUID references in the local sidecar. Rebind copies those references into this company's authorized Slack config without reading either secret value."}
        {!cleanupPending && props.signingSecretRequired
          ? " This released entry has no signing-secret reference; select or enter its Paperclip company secret UUID below first."
          : ""}
      </div>
      <div style={formActionsStyle}>
        <button
          type="button"
          onClick={() => void props.onRebind()}
          disabled={props.busy || (props.signingSecretRequired && !props.signingSecretReady)}
          style={secondaryButtonStyle}
        >
          {props.busy ? "Working..." : cleanupPending ? "Retry legacy cleanup" : "Rebind released credentials"}
        </button>
      </div>
      {props.result?.status === "rebound" && <span style={successStyle}>Released Slack credentials rebound successfully. Close this editor; reinstall is not required.</span>}
      {props.error && <span style={errorStyle}>{props.error}</span>}
    </div>
  );
}

function SlackStatusPanel(props: {
  agentId: string;
  label: string;
  loading: boolean;
  status: SlackBotWhoamiData | null;
  error: string | null;
}) {
  const { agentId, label, loading, status, error } = props;
  if (loading) {
    return <div style={inlineNoticeStyle}>Loading configured Slack identity metadata for {label || agentId}...</div>;
  }
  if (error) {
    // Deliberately renders only the (already-sanitized) error message, never
    // a raw payload -- see handleCheckSlackStatus's catch branch.
    return (
      <div style={validationNoticeStyle}>
        Slack identity metadata unavailable for agent <strong>{label || agentId}</strong> ({error}).
      </div>
    );
  }
  if (!status) {
    return null;
  }
  return (
    <div style={inlineNoticeStyle}>
      <strong>Configured Slack identity.</strong>{" "}
      Saved metadata for agent <strong>{label || agentId}</strong>: workspace {status.teamId ?? "unknown"}, app {status.appId ?? "unknown"},
      bot user {status.botUserId ?? "unknown"}
      {status.hasDefaultChannel ? ", default channel configured" : ", no default channel configured"}.
      {" "}This reflects saved install metadata only - it does not verify the bot token is still valid; a revoked or
      stale token is not detected here. See "Connection" below for a live credential check.
    </div>
  );
}

// DRO-1161: how long a successful live connection check is considered fresh
// before the UI marks it stale. A stale "last known good" result must never
// be presented as current health -- see the module doc on
// runSlackConnectionCheck in connection-status.ts.
const SLACK_CONNECTION_STATUS_STALE_AFTER_MS = 5 * 60 * 1000;

function formatRelativeAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Review finding (DRO-1161): `Date.now()` sampled during render alone means
 * an *open* dialog keeps showing "Connected" forever once it has rendered,
 * because nothing re-renders it at the freshness boundary. This schedules a
 * single one-shot timer for the exact moment the observation goes stale and
 * re-renders then. It arms no timer when there is nothing to age out
 * (`atMs === null`) or when the boundary has already passed, so there is no
 * interval churn, and it clears on unmount / whenever `atMs` changes (a new
 * check or an identity switch), so no timer leaks.
 */
function useStaleAfter(atMs: number | null, staleAfterMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (atMs === null) return;
    const remainingMs = atMs + staleAfterMs - Date.now();
    if (remainingMs <= 0) return;
    const timer = setTimeout(() => setTick((value) => value + 1), remainingMs + 1);
    return () => clearTimeout(timer);
  }, [atMs, staleAfterMs]);
}

function SlackConnectionStatusPanel(props: {
  agentId: string;
  label: string;
  loading: boolean;
  result: SlackConnectionCheckResult | null;
  error: string | null;
  lastSuccessAtMs: number | null;
  onCheck: () => Promise<void>;
}) {
  const { agentId, label, loading, result, error, lastSuccessAtMs, onCheck } = props;
  useStaleAfter(lastSuccessAtMs, SLACK_CONNECTION_STATUS_STALE_AFTER_MS);
  const now = Date.now();
  const ageMs = lastSuccessAtMs !== null ? now - lastSuccessAtMs : null;
  // A refresh failure over a preserved last-known-good result must mark it
  // stale immediately, not just after SLACK_CONNECTION_STATUS_STALE_AFTER_MS
  // elapses -- otherwise a check that failed seconds after a healthy check
  // still renders as plain "Connected" while the surrounding text claims
  // "marked stale" (review finding: refresh failure not actually marked
  // stale until 5 minutes pass).
  const isStale = Boolean(error) || (ageMs !== null && ageMs > SLACK_CONNECTION_STATUS_STALE_AFTER_MS);

  return (
    <div style={inlineNoticeStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
        <strong>Connection.</strong>
        <button type="button" style={secondaryButtonStyle} onClick={() => void onCheck()} disabled={loading}>
          {loading ? "Checking..." : "Check Slack connection"}
        </button>
      </div>
      {!result && !error && !loading && (
        <div>
          Never tested. Run a live check to verify the bot credential for <strong>{label || agentId}</strong> still
          authenticates with Slack -- this never exposes the bot token.
        </div>
      )}
      {loading && <div>Running a bounded live Slack `auth.test` check for {label || agentId}...</div>}
      {error && (
        <div style={errorStyle}>
          Could not refresh the connection check ({error}).
          {result ? " Showing the last known result below, marked stale." : ""}
        </div>
      )}
      {result && result.outcome.ok && (
        <div style={successStyle}>
          Connected. Slack accepted the resolved bot credential at {new Date(result.checkedAt).toLocaleString()}
          {isStale ? ` (stale -- ${formatRelativeAge(ageMs as number)}, re-check to confirm it still holds)` : ""}.
        </div>
      )}
      {result && !result.outcome.ok && (
        <div style={errorStyle}>
          Not connected ({result.outcome.category}): {result.outcome.reason}
          {result.nextStep ? <div style={hintStyle}>Next step: {result.nextStep}</div> : null}
        </div>
      )}
    </div>
  );
}

// DRO-1187: same staleness window as Connection above -- a preserved
// last-known telemetry projection older than this (or shown after a refresh
// failure) is marked stale rather than presented as current.
const SLACK_TELEMETRY_STALE_AFTER_MS = 5 * 60 * 1000;

function SlackIngressStatusPanel(props: {
  agentId: string;
  label: string;
  loading: boolean;
  telemetry: SlackIngressTelemetry | null;
  error: string | null;
  lastFetchedAtMs: number | null;
}) {
  const { agentId, label, loading, telemetry, error, lastFetchedAtMs } = props;
  useStaleAfter(lastFetchedAtMs, SLACK_TELEMETRY_STALE_AFTER_MS);
  const now = Date.now();
  const ageMs = lastFetchedAtMs !== null ? now - lastFetchedAtMs : null;
  const isStale = Boolean(error) || (ageMs !== null && ageMs > SLACK_TELEMETRY_STALE_AFTER_MS);
  const hasObservation = Boolean(telemetry?.lastVerifiedEventAt || telemetry?.lastFailure);

  return (
    <div style={inlineNoticeStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
        <strong>Ingress.</strong>
        {loading && <span>Refreshing...</span>}
      </div>
      {!hasObservation && !error && (
        <div>
          Never observed. No verified Slack event has been recorded yet for <strong>{label || agentId}</strong>.
        </div>
      )}
      {error && (
        <div style={errorStyle}>
          Could not refresh ingress telemetry ({error}).
          {hasObservation ? " Showing the last known result below, marked stale." : ""}
        </div>
      )}
      {telemetry?.lastVerifiedEventAt && telemetry.lastRoutingResult === "routed" && (
        <div style={successStyle}>
          Last verified event ({telemetry.lastEventType ?? "other"}) routed successfully at{" "}
          {new Date(telemetry.lastVerifiedEventAt).toLocaleString()}
          {isStale ? ` (stale -- ${formatRelativeAge(ageMs as number)}, refresh to confirm it still holds)` : ""}.
        </div>
      )}
      {telemetry?.lastFailure && (
        <div style={errorStyle}>
          Last ingress failure ({telemetry.lastFailure.category}) at{" "}
          {new Date(telemetry.lastFailure.at).toLocaleString()}
          <div style={hintStyle}>Next step: {telemetry.lastFailure.nextStep}</div>
        </div>
      )}
    </div>
  );
}

function SlackDeliveryStatusPanel(props: {
  agentId: string;
  label: string;
  loading: boolean;
  telemetry: SlackDeliveryTelemetry | null;
  error: string | null;
  lastFetchedAtMs: number | null;
}) {
  const { agentId, label, loading, telemetry, error, lastFetchedAtMs } = props;
  useStaleAfter(lastFetchedAtMs, SLACK_TELEMETRY_STALE_AFTER_MS);
  const now = Date.now();
  const ageMs = lastFetchedAtMs !== null ? now - lastFetchedAtMs : null;
  const isStale = Boolean(error) || (ageMs !== null && ageMs > SLACK_TELEMETRY_STALE_AFTER_MS);
  const hasObservation = Boolean(
    telemetry?.lastEnqueuedAt || telemetry?.lastDrainStartedAt || telemetry?.lastCompletedAt || telemetry?.lastFailure,
  );

  return (
    <div style={inlineNoticeStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
        <strong>Delivery.</strong>
        {loading && <span>Refreshing...</span>}
      </div>
      {!hasObservation && !error && (
        <div>
          Never observed. No Slack turn has been queued or delivered yet for <strong>{label || agentId}</strong>.
        </div>
      )}
      {error && (
        <div style={errorStyle}>
          Could not refresh delivery telemetry ({error}).
          {hasObservation ? " Showing the last known result below, marked stale." : ""}
        </div>
      )}
      {telemetry?.lastCompletedAt && (
        <div style={successStyle}>
          Last turn completed at {new Date(telemetry.lastCompletedAt).toLocaleString()}
          {isStale ? ` (stale -- ${formatRelativeAge(ageMs as number)}, refresh to confirm it still holds)` : ""}.
        </div>
      )}
      {telemetry?.lastEnqueuedAt && !telemetry.lastCompletedAt && !telemetry.lastFailure && (
        <div>Last turn enqueued at {new Date(telemetry.lastEnqueuedAt).toLocaleString()}.</div>
      )}
      {telemetry?.lastFailure && (
        <div style={errorStyle}>
          Last delivery failure ({telemetry.lastFailure.category}) at{" "}
          {new Date(telemetry.lastFailure.at).toLocaleString()}
          <div style={hintStyle}>Next step: {telemetry.lastFailure.nextStep}</div>
        </div>
      )}
    </div>
  );
}

export const slackSettingsUIAdapter: ProviderSettingsUIAdapter<SlackSettingsUIFormConfig, SlackSettingsUIHookResult, SlackCredentialStepInput> = {
  providerId: SLACK_IDENTITY_PROVIDER_ID,
  useCredentialStep: useSlackCredentialStep,
  CredentialStep: SlackCredentialStep,
  getRemovalConfirmation(entry) {
    return `Delete agent identity mapping for ${entry.label}? This clears saved Slack install metadata; your Slack app and bot token are not deleted, only unlinked from this agent. To reconnect later, create a new Slack mapping with "Add identity".`;
  },
};
