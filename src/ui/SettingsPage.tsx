import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePluginData, usePluginAction, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { DEFAULT_BOT_IDENTITY_CONFIG, GITHUB_IDENTITY_PROVIDER_ID, SLACK_IDENTITY_PROVIDER_ID, isIdentityProviderId } from "../shared/types.js";
import {
  createPaperclipThemeStyle,
  uiBorder,
  uiBorderStrong,
  uiCanvas,
  uiDanger,
  uiInput,
  uiLink,
  uiMutedPanel,
  uiMutedText,
  uiOverlay,
  uiPanel,
  uiPrimary,
  uiPrimaryText,
  uiShadow,
  uiSuccess,
  uiSurface,
  uiText,
  uiWarning,
  usePaperclipThemeMode,
} from "./theme.js";
import type {
  BotIdentitySettingsData,
  BotIdentitySettingsEntry,
  PaperclipAgentOption,
  PaperclipAgentsData,
  SaveBotIdentityConfigInput,
  CreateGitHubAppManifestResult,
  ConvertGitHubAppManifestResult,
  GetGitHubAppManifestFlowResult,
  CreateSlackAppManifestResult,
  GetSlackAppManifestFlowResult,
  SaveSlackInstallMetadataResult
} from "../shared/types.js";

type PaperclipSecretOption = {
  id: string;
  name: string;
  key?: string;
  description?: string;
  provider?: string;
  status?: string;
};

export type IdentityFormState = {
  agentId: string;
  provider: string;
  label: string;
  githubUsername: string;
  commitName: string;
  commitEmail: string;
  githubAppId: string;
  githubInstallationId: string;
  privateKeySecretId: string;
  privateKeyFile: string;
  fallbackTokenSecretId: string;
  tokenFile: string;
  previousAgentId: string;
  previousGithubAppId: string;
  previousGithubInstallationId: string;
  previousPrivateKeySecretId: string;
  previousPrivateKeyFile: string;
  slackTeamId: string;
  slackAppId: string;
  slackBotUserId: string;
  slackDefaultChannel: string;
  slackBotTokenSecretId: string;
};

type SettingsSection = "identities" | "setup" | "environment";
type IdentityFormSection = "identity" | "github" | "slack" | "commit";
type IdentityFormValidation = {
  identityComplete: boolean;
  credentialComplete: boolean;
  isComplete: boolean;
  identityMessage: string;
  credentialMessage: string;
  saveMessage: string;
};
type IdentityTone = "good" | "warn" | "neutral";

export function SettingsPage(props: PluginSettingsPageProps) {
  const companyId = props.context.companyId ?? "";
  const themeMode = usePaperclipThemeMode();
  const { data, loading, error, refresh } = usePluginData<BotIdentitySettingsData>("bot-identity-config", { companyId });
  const companyDisplayName = getCompanyDisplayName(data?.companyName, props.context.companyPrefix, companyId);
  const { data: agentsData, loading: agentsLoading, error: agentsError } = usePluginData<PaperclipAgentsData>("paperclip-agents", { companyId });
  const saveConfig = usePluginAction("save-bot-identity-config");
  const deleteConfig = usePluginAction("delete-bot-identity-config");
  const createGitHubAppManifest = usePluginAction("create-github-app-manifest");
  const getGitHubAppManifestFlow = usePluginAction("get-github-app-manifest-flow");
  const convertGitHubAppManifest = usePluginAction("convert-github-app-manifest");
  const createSlackAppManifest = usePluginAction("create-slack-app-manifest");
  const getSlackAppManifestFlow = usePluginAction("get-slack-app-manifest-flow");
  const saveSlackInstallMetadata = usePluginAction("save-slack-install-metadata");

  const [formState, setFormState] = useState<IdentityFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [secretOptions, setSecretOptions] = useState<PaperclipSecretOption[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [manifestFlow, setManifestFlow] = useState<CreateGitHubAppManifestResult | null>(null);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [manifestCode, setManifestCode] = useState("");
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestResult, setManifestResult] = useState<ConvertGitHubAppManifestResult | null>(null);
  const [slackManifestFlow, setSlackManifestFlow] = useState<CreateSlackAppManifestResult | null>(null);
  const [slackManifestBusy, setSlackManifestBusy] = useState(false);
  const [slackManifestError, setSlackManifestError] = useState<string | null>(null);
  const [slackSaveResult, setSlackSaveResult] = useState<SaveSlackInstallMetadataResult | null>(null);
  const [slackManifestCopied, setSlackManifestCopied] = useState(false);
  const [slackResumeStateInput, setSlackResumeStateInput] = useState("");
  const [slackResumeBusy, setSlackResumeBusy] = useState(false);
  const [slackResumeError, setSlackResumeError] = useState<string | null>(null);
  const slackSaveGenerationRef = useRef(0);
  const [activeSection, setActiveSection] = useState<SettingsSection>("identities");
  const [activeFormSection, setActiveFormSection] = useState<IdentityFormSection>("identity");
  const identities = data?.identities ?? [];
  const agentOptions = agentsData?.agents ?? [];
  const summary = summarizeIdentitySettings(identities, Boolean(data?.credentialSidecarError));

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
          ? getAgentIdentityDefaults(selectedAgent, companyDisplayName, data?.credentialSidecarPath ?? "")
          : null;
        const restoredForm = toFormState(savedIdentity);
        const draftForm = readManifestDraftForm(callback.state);
        const conversion = flow.conversion;
        setActiveFormSection("github");
        setFormState({
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
        });
        setManifestFlow(flow);
        setManifestCode(callback.code ?? "");
        if (callback.installationId) {
          setManifestResult(conversion ?? null);
          deleteManifestDraftForm(callback.state);
          void getGitHubAppManifestFlow({ state: callback.state, consume: true }).catch(() => undefined);
        }
        setSaveError(null);
        setSaveSuccess(false);
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
  }, [agentOptions, companyDisplayName, data?.credentialSidecarPath, getGitHubAppManifestFlow, identities]);

  useEffect(() => {
    if (!companyId) {
      setSecretOptions([]);
      setSecretsError(null);
      setSecretsLoading(false);
      return;
    }

    let cancelled = false;
    setSecretsLoading(true);
    setSecretsError(null);
    void loadSecretOptions(companyId)
      .then((secrets) => {
        if (!cancelled) {
          setSecretOptions(secrets);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSecretOptions([]);
          setSecretsError(err instanceof Error ? err.message : "Could not load Paperclip secrets");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSecretsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const hasAgentOptions = agentOptions.length > 0;
  const config = formState;

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
    void getSlackAppManifestFlow({ state: storedState })
      .then((result) => {
        if (cancelled) return;
        const flow = result as GetSlackAppManifestFlowResult;
        if (flow.agentId !== agentId) {
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

  const hasSavedAgentOutsideOptions = Boolean(
    config?.agentId && !agentOptions.some((agent) => agent.id === config.agentId)
  );
  const hasSecretOptions = secretOptions.length > 0;
  const hasSavedSecretOutsideOptions = Boolean(
    config?.privateKeySecretId && !secretOptions.some((secret) => secret.id === config.privateKeySecretId)
  );
  const hasSavedFallbackSecretOutsideOptions = Boolean(
    config?.fallbackTokenSecretId && !secretOptions.some((secret) => secret.id === config.fallbackTokenSecretId)
  );
  const isEditingExistingIdentity = Boolean(config && identities.some((entry) => entry.agentId === config.agentId && entry.provider === config.provider));
  const duplicateIdentity = config ? identities.find((entry) => entry.agentId === config.agentId && entry.provider === config.provider && !(config.previousAgentId === entry.agentId && config.provider === entry.provider)) : undefined;
  const hasExistingGitHubAppCredential = Boolean(
    config?.previousGithubAppId ||
    config?.previousGithubInstallationId ||
    config?.previousPrivateKeySecretId ||
    config?.previousPrivateKeyFile
  );
  const formValidation = config
    ? getIdentityFormValidation(config, Boolean(duplicateIdentity), slackSaveResult, slackManifestBusy)
    : null;
  const activeFormSteps = getFormSteps(config?.provider ?? GITHUB_IDENTITY_PROVIDER_ID);
  const activeFormStepIndex = getFormStepIndex(activeFormSection, config?.provider ?? GITHUB_IDENTITY_PROVIDER_ID);
  const isLastFormStep = activeFormStepIndex === activeFormSteps.length - 1;
  const canGoNext = formValidation ? canAdvanceFromStep(activeFormSection, formValidation) : false;
  const canSave = Boolean(formValidation?.isComplete && isLastFormStep && !saving);

  if (loading) return <div>Loading settings...</div>;
  if (error) return <div>Error loading settings: {error.message}</div>;

  function startCreate() {
    setActiveFormSection("identity");
    setFormState(toFormState());
    setSaveError(null);
    setSaveSuccess(false);
    resetManifestFlow();
    resetSlackManifestFlow();
  }

  function startEdit(entry: BotIdentitySettingsEntry) {
    setActiveFormSection("identity");
    setFormState(toFormState(entry));
    setSaveError(null);
    setSaveSuccess(false);
    resetManifestFlow();
    resetSlackManifestFlow();
  }

  function updateField(field: keyof IdentityFormState, value: string) {
    if (field === "agentId") {
      updateAgentSelection(value);
    } else {
      setFormState((prev) => ({
        ...(prev ?? toFormState()),
        [field]: value,
      }));
    }
    setSaveSuccess(false);
    setSaveError(null);
    if ((field === "agentId" || field === "label") && config?.[field] !== value) {
      resetManifestFlow();
      resetSlackManifestFlow();
    } else if (field.startsWith("slack") && config?.[field] !== value) {
      // Any edit to the Slack install fields invalidates a prior successful
      // save-slack-install-metadata result -- it was only valid for the
      // exact field values it was saved with. Also bump the save
      // generation so an in-flight save-slack-install-metadata response
      // (started before this edit) is discarded when it arrives, rather
      // than being applied against fields it no longer reflects.
      setSlackSaveResult(null);
      slackSaveGenerationRef.current += 1;
    }
  }

  function updateAgentSelection(agentId: string) {
    setFormState((prev) => {
      const base = prev ?? toFormState();
      const selectedAgent = agentOptions.find((agent) => agent.id === agentId);
      if (!selectedAgent || base.previousAgentId || base.agentId === agentId) {
        return { ...base, agentId };
      }
      const defaults = getAgentIdentityDefaults(
        selectedAgent,
        companyDisplayName,
        data?.credentialSidecarPath ?? "",
      );
      return {
        ...base,
        agentId,
        label: shouldPrefillIdentityField(base.label, DEFAULT_BOT_IDENTITY_CONFIG.label) ? defaults.label : base.label,
        githubUsername: shouldPrefillIdentityField(base.githubUsername, DEFAULT_BOT_IDENTITY_CONFIG.github.username) ? defaults.githubUsername : base.githubUsername,
        commitName: shouldPrefillIdentityField(base.commitName, "") ? defaults.commitName : base.commitName,
        commitEmail: shouldPrefillIdentityField(base.commitEmail, "") ? defaults.commitEmail : base.commitEmail,
        privateKeyFile: shouldPrefillIdentityField(base.privateKeyFile, "") ? defaults.privateKeyFile : base.privateKeyFile,
      };
    });
  }

  function resetManifestFlow() {
    setManifestFlow(null);
    setManifestCode("");
    setManifestError(null);
    setManifestResult(null);
  }

  function resetSlackManifestFlow() {
    setSlackManifestFlow(null);
    setSlackManifestError(null);
    setSlackSaveResult(null);
    setSlackManifestCopied(false);
    setSlackResumeStateInput("");
    setSlackResumeError(null);
  }

  async function handleResumeSlackAppManifestFlow() {
    if (!config) return;
    const state = slackResumeStateInput.trim();
    if (!state) return;
    setSlackResumeBusy(true);
    setSlackResumeError(null);
    try {
      const flow = await getSlackAppManifestFlow({ state }) as GetSlackAppManifestFlowResult;
      if (flow.agentId !== config.agentId.trim()) {
        throw new Error("This state token belongs to a different agent than the one currently selected.");
      }
      setSlackManifestFlow(flow);
      setSlackManifestCopied(false);
      setSlackManifestError(null);
      writeSlackManifestFlowState(config.agentId.trim(), flow.state);
    } catch (err) {
      setSlackResumeError(err instanceof Error ? err.message : "Could not restore the Slack App manifest flow for that state token.");
    } finally {
      setSlackResumeBusy(false);
    }
  }

  async function handleCreateSlackAppManifest() {
    if (!config) return;
    if (config.provider !== SLACK_IDENTITY_PROVIDER_ID) {
      setSlackManifestError("Slack App setup is only available for the Slack provider.");
      return;
    }
    setSlackManifestBusy(true);
    setSlackManifestError(null);
    setSlackSaveResult(null);
    try {
      const result = await createSlackAppManifest({
        agentId: config.agentId.trim(),
        provider: config.provider,
        label: config.label.trim(),
      }) as CreateSlackAppManifestResult;
      setSlackManifestFlow(result);
      setSlackManifestCopied(false);
      writeSlackManifestFlowState(config.agentId.trim(), result.state);
    } catch (err) {
      setSlackManifestError(err instanceof Error ? err.message : "Failed to create Slack App manifest");
    } finally {
      setSlackManifestBusy(false);
    }
  }

  async function handleSaveSlackInstallMetadata() {
    if (!config || !slackManifestFlow) return;
    const generation = ++slackSaveGenerationRef.current;
    setSlackManifestBusy(true);
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
          setSlackManifestError(
            `Slack install metadata saved, but could not remove the previous identity for ${previousAgentId}: ${err instanceof Error ? err.message : "unknown error"}`
          );
        }
      }
      setSlackSaveResult(result);
      deleteSlackManifestFlowState(targetAgentId);
      // Record the just-saved identity as the form's "previous" identity before
      // refreshing. Otherwise refresh() adds this identity to `identities`, and
      // duplicateIdentity (which compares against previousAgentId) would then
      // treat the freshly-saved identity as a duplicate of itself and disable
      // the footer's "Save agent" button.
      setFormState((prev) => (prev ? { ...prev, previousAgentId: result.agentId } : prev));
      await refresh();
    } catch (err) {
      if (slackSaveGenerationRef.current !== generation) return;
      setSlackManifestError(err instanceof Error ? err.message : "Failed to save Slack install metadata");
    } finally {
      if (slackSaveGenerationRef.current === generation) {
        setSlackManifestBusy(false);
      }
    }
  }

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

  async function handleSave() {
    if (!config) return;
    const validation = getIdentityFormValidation(config, Boolean(duplicateIdentity), slackSaveResult, slackManifestBusy);
    if (!validation.isComplete) {
      setSaveSuccess(false);
      setSaveError(validation.saveMessage);
      setActiveFormSection(validation.identityComplete ? (config.provider === SLACK_IDENTITY_PROVIDER_ID ? "slack" : "github") : "identity");
      return;
    }
    if (config.provider === SLACK_IDENTITY_PROVIDER_ID) {
      // Slack identities are persisted by save-slack-install-metadata itself
      // (see handleSaveSlackInstallMetadata); there is no separate
      // save-bot-identity-config call for Slack. Reaching this step with a
      // complete validation means that action already ran successfully.
      setSaveSuccess(true);
      setFormState(null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      if (!isIdentityProviderId(config.provider)) {
        throw new Error("Choose a supported identity provider before saving.");
      }
      const targetAgentId = config.agentId.trim();
      const previousAgentIds = config.previousAgentId && config.previousAgentId !== targetAgentId ? [config.previousAgentId] : [];
      const payload: SaveBotIdentityConfigInput = {
        agentId: config.agentId.trim(),
        previousAgentId: config.previousAgentId.trim() || undefined,
        provider: "github",
        label: config.label.trim(),
        github: {
          username: config.githubUsername.trim(),
          ...(config.commitName.trim() ? { commitName: config.commitName.trim() } : {}),
          ...(config.commitEmail.trim() ? { commitEmail: config.commitEmail.trim() } : {}),
        },
        credential: {
          secretId: config.fallbackTokenSecretId.trim() || undefined,
          tokenFile: config.tokenFile.trim() || undefined,
          githubApp: {
            appId: config.githubAppId.trim() || undefined,
            installationId: config.githubInstallationId.trim() || undefined,
            privateKeySecretId: config.privateKeySecretId.trim() || undefined,
            privateKeyFile: config.privateKeyFile.trim() || undefined,
          },
        },
      };
      const saved = await saveConfig(payload as unknown as Record<string, unknown>);
      await syncGitHubAppCredentialPropagationForAgents({
        selectedAgentIds: targetAgentId ? [targetAgentId] : [],
        previousAgentIds,
        githubAppId: config.githubAppId.trim() || undefined,
        githubInstallationId: config.githubInstallationId.trim() || undefined,
        privateKeySecretRef: config.privateKeySecretId.trim() || undefined,
        privateKeyFile: config.privateKeyFile.trim() || undefined,
        previousGithubAppId: config.previousGithubAppId || undefined,
        previousGithubInstallationId: config.previousGithubInstallationId || undefined,
        previousPrivateKeySecretRef: config.previousPrivateKeySecretId || undefined,
        previousPrivateKeyFile: config.previousPrivateKeyFile || undefined,
      });
      setSaveSuccess(true);
      await refresh();
      const savedEntry = (saved as BotIdentitySettingsEntry | undefined)?.agentId ? saved as BotIdentitySettingsEntry : null;
      setFormState(savedEntry ? toFormState(savedEntry) : null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(entry: BotIdentitySettingsEntry) {
    const confirmed = window.confirm(`Delete agent identity mapping for ${entry.label}?`);
    if (!confirmed) return;
    setDeletingAgentId(entry.agentId);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await deleteConfig({ agentId: entry.agentId, provider: entry.provider });
      if (formState?.agentId === entry.agentId && formState.provider === entry.provider) {
        setFormState(null);
      }
      await refresh();

      if (hasGitHubAppPropagationValues(entry)) {
        try {
          await syncGitHubAppCredentialPropagationForAgents({
            selectedAgentIds: [],
            previousAgentIds: [entry.agentId],
            previousGithubAppId: entry.credential?.githubApp?.appId,
            previousGithubInstallationId: entry.credential?.githubApp?.installationId,
            previousPrivateKeySecretRef: entry.credential?.githubApp?.privateKeySecretId,
            previousPrivateKeyFile: entry.credential?.githubApp?.privateKeyFile,
          });
        } catch (err) {
          setSaveError(`Deleted identity, but could not clean the agent environment: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeletingAgentId(null);
    }
  }

  return (
    <div
      className="agent-identities-settings"
      style={{ ...createPaperclipThemeStyle(themeMode), ...pageStyle }}
      data-agent-identities-theme={themeMode}
    >
      <style>{responsiveSettingsStyle}</style>
      <div className="agent-identities-header" style={headerStyle}>
        <div>
          <h2 style={pageTitleStyle}>Agent Identities</h2>
          <p style={descriptionStyle}>
            Connect agents in {companyDisplayName || "this company"} to service-specific identity providers. GitHub is the first provider.
          </p>
        </div>
        <button
          onClick={startCreate}
          style={primaryButtonStyle}
          title="Add identity"
          aria-label="Add identity"
        >
          New identity
        </button>
      </div>

      <div className="agent-identities-summary-grid" style={summaryGridStyle}>
        <SummaryTile label="Identities" value={summary.total} />
        <SummaryTile label="GitHub Apps" value={summary.githubApps} tone="good" />
        <SummaryTile label="Need setup" value={summary.needsSetup} tone={summary.needsSetup > 0 ? "warn" : "good"} />
      </div>

      {data?.credentialSidecarError && (
        <div style={credentialErrorStyle}>
          Credential source unavailable: {data.credentialSidecarError}
        </div>
      )}

      <div className="agent-identities-settings-shell" style={settingsShellStyle}>
        <nav className="agent-identities-sidebar" style={sidebarStyle} aria-label="Agent identity settings sections">
          <SidebarButton
            active={activeSection === "identities"}
            title="Identities"
            detail={`${identities.length} configured`}
            onClick={() => setActiveSection("identities")}
          />
          <SidebarButton
            active={activeSection === "setup"}
            title="GitHub App setup"
            detail="Create and install apps"
            onClick={() => setActiveSection("setup")}
          />
          <SidebarButton
            active={activeSection === "environment"}
            title="Environment"
            detail="Credential propagation"
            onClick={() => setActiveSection("environment")}
          />
        </nav>

        <main style={workspaceStyle}>
          {activeSection === "identities" && (
            <section style={sectionStyle}>
              <div className="agent-identities-section-header" style={sectionHeaderStyle}>
                <div>
                  <h3 style={sectionTitleStyle}>Configured identities</h3>
                  <p style={sectionDescriptionStyle}>Each row maps one Paperclip agent to a provider account and credential source.</p>
                </div>
                <button onClick={startCreate} style={secondaryButtonStyle}>Add identity</button>
              </div>
              {saveError && !formState && <div style={errorStyle}>{saveError}</div>}
              {saveSuccess && !formState && <div style={successStyle}>Saved successfully.</div>}
              {identities.length === 0 ? (
                <div style={emptyStateStyle}>
                  <strong>No identities configured</strong>
                  <span>Pick an agent, connect its first provider account, then save. Defaults are filled from the selected agent and company.</span>
                  <button onClick={startCreate} style={primaryButtonStyle}>Create first identity</button>
                </div>
              ) : (
                <div style={listStyle}>
                  <div className="agent-identities-list-header" style={listHeaderStyle}>
                    <span>Agent</span>
                    <span>Provider identity</span>
                    <span>Status</span>
                    <span />
                  </div>
                  {identities.map((entry) => (
                    <div key={entry.id} className="agent-identities-list-row" style={rowStyle}>
                      <div style={{ minWidth: 0 }}>
                        <div style={rowTitleStyle}>{entry.label}</div>
                        <div style={rowMetaStyle}>{formatAgentName(entry.agentId, agentOptions)}</div>
                      </div>
                      <div style={rowMetaStyle}>{entry.provider === "github" ? entry.github.username : entry.provider === "slack" ? `Team ${entry.slack.teamId}` : ""}</div>
                      <span style={statusBadgeStyle(getIdentityTone(entry))}>{formatCredentialStatus(entry.credentialStatus)}</span>
                      <div className="agent-identities-row-actions" style={rowActionsStyle}>
                        <button onClick={() => startEdit(entry)} style={secondaryButtonStyle}>Edit</button>
                        <button
                          onClick={() => void handleDelete(entry)}
                          disabled={deletingAgentId === entry.agentId}
                          style={dangerButtonStyle}
                        >
                          {deletingAgentId === entry.agentId ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeSection === "setup" && (
            <section style={sectionStyle}>
              <h3 style={sectionTitleStyle}>GitHub App setup</h3>
              <div style={setupStepsStyle}>
                <SetupStep index="1" title="Select the Paperclip agent" text="The label, GitHub login, commit name, and private-key file path are prefilled from the agent and company." />
                <SetupStep index="2" title="Create the GitHub App" text="Paperclip opens GitHub with the required permissions and stores the generated private key in the sidecar path." />
                <SetupStep index="3" title="Install, return, save" text="GitHub redirects back with the installation ID. Save the identity to propagate the environment values." />
              </div>
              <button onClick={startCreate} style={primaryButtonStyle}>Start setup</button>
            </section>
          )}

          {activeSection === "environment" && (
            <section style={sectionStyle}>
              <h3 style={sectionTitleStyle}>Environment propagation</h3>
              <div style={inlineNoticeStyle}>
                Saving an identity updates the selected agent environment with <code>GITHUB_APP_ID</code>, <code>GITHUB_INSTALLATION_ID</code>, and either <code>GITHUB_APP_PRIVATE_KEY</code> or <code>GITHUB_APP_PRIVATE_KEY_FILE</code>.
              </div>
              <div style={setupStepsStyle}>
                <SetupStep index="A" title="Secret first" text="When a Paperclip secret is selected, the agent gets a secret reference instead of a raw private key." />
                <SetupStep index="B" title="File fallback" text="If secrets are not available, the generated private-key file path keeps the tools working." />
                <SetupStep index="C" title="Safe removal" text="Deleting an identity removes only matching GitHub App values from that agent." />
              </div>
            </section>
          )}
        </main>
      </div>

      {config && (
        <div style={dialogBackdropStyle} role="presentation">
          <section
            className="agent-identities-dialog"
            style={dialogStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-identity-dialog-title"
          >
          <header className="agent-identities-dialog-header" style={dialogHeaderStyle}>
            <div>
              <h3 id="agent-identity-dialog-title" style={dialogTitleStyle}>{isEditingExistingIdentity ? "Edit agent identity" : "Add agent identity"}</h3>
              <p style={sectionDescriptionStyle}>Configure the agent, GitHub App credential, and optional commit metadata.</p>
            </div>
            <button onClick={() => setFormState(null)} disabled={saving} style={closeButtonStyle} aria-label="Close identity editor">x</button>
          </header>

          <div style={dialogBodyStyle}>
            <div className="agent-identities-wizard-steps" aria-label="Identity setup progress" style={wizardStepListStyle}>
              {activeFormSteps.map((step, index) => (
                <WizardStepIndicator
                  key={step.id}
                  index={index + 1}
                  label={step.label}
                  active={step.id === activeFormSection}
                  complete={formValidation ? isWizardStepComplete(step.id, formValidation) : false}
                />
              ))}
            </div>

          {activeFormSection === "identity" && (
          <>
          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>Identity</legend>
            {formValidation && !formValidation.identityComplete && <div style={validationNoticeStyle}>{formValidation.identityMessage}</div>}

            <label style={fieldStyle}>
              <span>Agent <span style={requiredStyle}>*</span></span>
              {hasAgentOptions ? (
                <select
                  value={config.agentId}
                  onChange={(e) => updateField("agentId", e.target.value)}
                  style={inputStyle}
                >
                  <option value="" disabled>Select a Paperclip agent</option>
                  {hasSavedAgentOutsideOptions && <option value={config.agentId}>{config.agentId} (saved)</option>}
                  {agentOptions.map((agent) => (
                    <option key={agent.id} value={agent.id}>{formatAgentOption(agent)}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={config.agentId}
                  onChange={(e) => updateField("agentId", e.target.value)}
                  placeholder="UUID of the Paperclip agent"
                  style={inputStyle}
                />
              )}
              <span style={hintStyle}>{getAgentFieldHint({ companyId, agentsLoading, agentsError, hasAgentOptions })}</span>
            </label>

            <label style={fieldStyle}>
              <span>Provider <span style={requiredStyle}>*</span></span>
              <select value={config.provider} onChange={(e) => updateField("provider", e.target.value)} style={inputStyle} disabled={isEditingExistingIdentity}>
                {(data?.providers ?? []).map((provider) => (
                  <option
                    key={provider.id}
                    value={provider.id}
                    disabled={provider.status !== "enabled" && provider.id !== SLACK_IDENTITY_PROVIDER_ID}
                  >
                    {provider.name}{provider.status === "coming-soon" ? (provider.id === SLACK_IDENTITY_PROVIDER_ID ? " (setup only — tools coming soon)" : " (coming soon)") : ""}
                  </option>
                ))}
              </select>
              <span style={hintStyle}>Each agent can have one identity per provider. GitHub is fully available; Slack setup can be completed now, but Slack agent tools ship separately.</span>
            </label>

            {duplicateIdentity && <div style={validationNoticeStyle}>This agent already has a {getProviderDisplayName(config.provider, data?.providers)} identity. Edit the existing row instead.</div>}

            <label style={fieldStyle}>
              <span>Label <span style={requiredStyle}>*</span></span>
              <input
                type="text"
                value={config.label}
                onChange={(e) => updateField("label", e.target.value)}
                placeholder="e.g. Cade Riven [Droidshop]"
                style={inputStyle}
              />
            </label>
          </fieldset>

          {config.provider !== SLACK_IDENTITY_PROVIDER_ID && (
          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>Provider account</legend>

            <label style={fieldStyle}>
              <span>GitHub Username <span style={requiredStyle}>*</span></span>
              <input
                type="text"
                value={config.githubUsername}
                onChange={(e) => updateField("githubUsername", e.target.value)}
                placeholder="e.g. ouroboros-paperclip-agent[bot]"
                style={inputStyle}
              />
              <span style={hintStyle}>Public GitHub App login for this agent. GitHub appends [bot] to app account logins. Repository access is controlled by the GitHub App installation and provider permissions.</span>
            </label>
          </fieldset>
          )}
          </>
          )}

          {activeFormSection === "github" && (
          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>GitHub App credential source</legend>
            {formValidation && !formValidation.credentialComplete && <div style={validationNoticeStyle}>{formValidation.credentialMessage}</div>}

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
                <div style={detailsBodyStyle}>
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
                onChange={(e) => updateField("githubAppId", e.target.value)}
                placeholder="GitHub App ID"
                style={inputStyle}
              />
            </label>

            <label style={fieldStyle}>
              <span>Installation ID</span>
              <input
                type="text"
                value={config.githubInstallationId}
                onChange={(e) => updateField("githubInstallationId", e.target.value)}
                placeholder="GitHub App installation ID"
                style={inputStyle}
              />
            </label>

            <label style={fieldStyle}>
              <span>Private key Paperclip secret UUID</span>
              {hasSecretOptions ? (
                <select
                  value={config.privateKeySecretId}
                  onChange={(e) => updateField("privateKeySecretId", e.target.value)}
                  style={inputStyle}
                >
                  <option value="">No private key secret reference</option>
                  {hasSavedSecretOutsideOptions && <option value={config.privateKeySecretId}>{config.privateKeySecretId} (saved)</option>}
                  {secretOptions.map((secret) => (
                    <option key={secret.id} value={secret.id}>{formatSecretOption(secret)}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={config.privateKeySecretId}
                  onChange={(e) => updateField("privateKeySecretId", e.target.value)}
                  placeholder="Company secret UUID containing the GitHub App private key"
                  style={inputStyle}
                />
              )}
              <span style={hintStyle}>{getSecretFieldHint({ companyId, secretsLoading, secretsError, hasSecretOptions })}</span>
            </label>

            <label style={fieldStyle}>
              <span>Private key file fallback</span>
              <input
                type="text"
                value={config.privateKeyFile}
                onChange={(e) => updateField("privateKeyFile", e.target.value)}
                placeholder="<runtime-home>/.paperclip/agent-identities/github-apps/<agent>/private-key.pem"
                style={inputStyle}
              />
              <span style={hintStyle}>Used by plugin tools while a secret UUID is not configured or cannot be resolved. The plugin mints short-lived installation tokens from this private key; it does not store generated tokens.</span>
            </label>

            <details>
              <summary>Fallback token source</summary>
              <div style={detailsBodyStyle}>
                <label style={fieldStyle}>
                  <span>Fallback token secret UUID</span>
                  {hasSecretOptions ? (
                    <select
                      value={config.fallbackTokenSecretId}
                      onChange={(e) => updateField("fallbackTokenSecretId", e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">No fallback token secret reference</option>
                      {hasSavedFallbackSecretOutsideOptions && <option value={config.fallbackTokenSecretId}>{config.fallbackTokenSecretId} (saved)</option>}
                      {secretOptions.map((secret) => (
                        <option key={secret.id} value={secret.id}>{formatSecretOption(secret)}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={config.fallbackTokenSecretId}
                      onChange={(e) => updateField("fallbackTokenSecretId", e.target.value)}
                      placeholder="Company secret UUID containing a GitHub token"
                      style={inputStyle}
                    />
                  )}
                  <span style={hintStyle}>{getFallbackTokenSecretFieldHint({ companyId, secretsLoading, secretsError, hasSecretOptions })}</span>
                </label>
                <label style={fieldStyle}>
                  <span>Fallback token file</span>
                  <input
                    type="text"
                    value={config.tokenFile}
                    onChange={(e) => updateField("tokenFile", e.target.value)}
                    placeholder="<runtime-home>/.paperclip/agent-identities/tokens/<agent-id>.token"
                    style={inputStyle}
                  />
                  <span style={hintStyle}>Fallback token files are available for dev and recovery flows. Prefer GitHub App credentials above.</span>
                </label>
              </div>
            </details>
          </fieldset>
          )}

          {activeFormSection === "slack" && (
          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>Slack App setup</legend>
            {formValidation && !formValidation.credentialComplete && <div style={validationNoticeStyle}>{formValidation.credentialMessage}</div>}

            <div style={inlineNoticeStyle}>
              <strong>Create a Slack App from a manifest.</strong> Slack does not support a prefilled deep link for manifests, so Paperclip generates the manifest JSON below for you to copy, then opens the plain Slack "create app" page where you paste it in via "From an app manifest".
            </div>

            <div style={formActionsStyle}>
              <button
                type="button"
                onClick={() => void handleCreateSlackAppManifest()}
                disabled={slackManifestBusy || slackResumeBusy || !config.agentId || !config.label}
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
                  disabled={slackResumeBusy || slackManifestBusy || !slackResumeStateInput.trim()}
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
                  On the Slack page, choose "From an app manifest," select the workspace, then paste the copied JSON. After Slack creates and you install the app, come back and paste the resulting IDs below.
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
                  !slackManifestFlow ||
                  !config.slackTeamId.trim() ||
                  !config.slackAppId.trim() ||
                  !config.slackBotUserId.trim() ||
                  !config.slackBotTokenSecretId.trim()
                }
                style={secondaryButtonStyle}
              >
                {slackManifestBusy ? "Working..." : "Save Slack install metadata"}
              </button>
            </div>

            {!slackManifestFlow && (
              <span style={hintStyle}>Create the manifest above first; saving install metadata requires an active manifest flow state.</span>
            )}

            {slackSaveResult && <span style={successStyle}>Slack install metadata saved for team {slackSaveResult.teamId}.</span>}
          </fieldset>
          )}

          {activeFormSection === "commit" && (
          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>Commit identity (optional)</legend>
            <div style={inlineNoticeStyle}>These fields are optional. Save is available because the required identity and credential steps are complete.</div>

            <label style={fieldStyle}>
              <span>Commit Name</span>
              <input
                type="text"
                value={config.commitName}
                onChange={(e) => updateField("commitName", e.target.value)}
                placeholder="e.g. Ouroboros Paperclip Agent"
                style={inputStyle}
              />
            </label>

            <label style={fieldStyle}>
              <span>Commit Email</span>
              <input
                type="text"
                value={config.commitEmail}
                onChange={(e) => updateField("commitEmail", e.target.value)}
                placeholder="e.g. agent@example.com"
                style={inputStyle}
              />
            </label>
          </fieldset>
          )}

          </div>

          <footer className="agent-identities-dialog-footer" style={dialogFooterStyle}>
            <div style={saveStatusStyle}>
              {saveSuccess && <span style={successStyle}>Saved successfully.</span>}
              {saveError && <span style={errorStyle}>{saveError}</span>}
              {!saveSuccess && !saveError && formValidation && !isLastFormStep && <span style={hintStyle}>{formValidation.saveMessage}</span>}
              {!saveSuccess && !saveError && formValidation && isLastFormStep && !formValidation.isComplete && <span style={hintStyle}>{formValidation.saveMessage}</span>}
            </div>
            <button
              type="button"
              onClick={() => setActiveFormSection(getPreviousFormStep(activeFormSection, config.provider))}
              disabled={saving || activeFormStepIndex === 0}
              style={buttonStyle(secondaryButtonStyle, saving || activeFormStepIndex === 0)}
            >
              Previous
            </button>
            {!isLastFormStep ? (
              <button
                type="button"
                onClick={() => setActiveFormSection(getNextFormStep(activeFormSection, config.provider))}
                disabled={saving || !canGoNext}
                style={buttonStyle(primaryButtonStyle, saving || !canGoNext)}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!canSave}
                style={buttonStyle(primaryButtonStyle, !canSave)}
              >
                {saving ? "Saving..." : "Save agent"}
              </button>
            )}
            <button type="button" onClick={() => setFormState(null)} disabled={saving} style={secondaryButtonStyle}>Cancel</button>
          </footer>
          </section>
        </div>
      )}
    </div>
  );
}


function SummaryTile(props: { label: string; value: number; tone?: IdentityTone }) {
  return (
    <div style={summaryTileStyle(props.tone ?? "neutral")}>
      <span style={summaryValueStyle}>{props.value}</span>
      <span style={summaryLabelStyle}>{props.label}</span>
    </div>
  );
}

function SidebarButton(props: { active: boolean; title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={props.onClick} style={sidebarButtonStyle(props.active)}>
      <span style={sidebarTitleStyle}>{props.title}</span>
      <span style={sidebarDetailStyle}>{props.detail}</span>
    </button>
  );
}

function SetupStep(props: { index: string; title: string; text: string }) {
  return (
    <div style={setupStepStyle}>
      <span style={setupStepIndexStyle}>{props.index}</span>
      <div>
        <strong>{props.title}</strong>
        <p style={setupStepTextStyle}>{props.text}</p>
      </div>
    </div>
  );
}

function WizardStepIndicator(props: { index: number; label: string; active: boolean; complete: boolean }) {
  return (
    <div style={wizardStepStyle(props.active)}>
      <span style={wizardStepNumberStyle(props.active, props.complete)}>{props.complete ? "✓" : props.index}</span>
      <span>{props.label}</span>
    </div>
  );
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

function getManifestCallbackParams(): { code?: string; installationId?: string; state: string } | null {
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

function extractManifestCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    return parsed.searchParams.get("code")?.trim() || trimmed;
  } catch {
    return trimmed.replace(/^code=/i, "").trim();
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

function getAgentIdentityDefaults(
  agent: PaperclipAgentOption,
  companyDisplayName: string,
  credentialSidecarPath: string,
): Pick<IdentityFormState, "label" | "githubUsername" | "commitName" | "commitEmail" | "privateKeyFile"> {
  const displayName = getAgentDisplayName(agent);
  const slug = slugifyGitHubAppName(displayName);
  return {
    label: formatIdentityLabel(displayName, companyDisplayName),
    githubUsername: `${slug}[bot]`,
    commitName: `${displayName} Paperclip Agent`,
    commitEmail: `${slug}[bot]@users.noreply.github.com`,
    privateKeyFile: getGitHubAppPrivateKeyFile(credentialSidecarPath, agent.id),
  };
}

export function getGitHubAppPrivateKeyFile(credentialSidecarPath: string, agentId: string): string {
  const lastSeparator = Math.max(
    credentialSidecarPath.lastIndexOf("/"),
    credentialSidecarPath.lastIndexOf("\\"),
  );
  if (lastSeparator < 0) return "";
  const separator = credentialSidecarPath[lastSeparator];
  const directory = credentialSidecarPath.slice(0, lastSeparator);
  return `${directory}${separator}github-apps${separator}${agentId}${separator}private-key.pem`;
}

function shouldPrefillIdentityField(value: string, defaultValue: string): boolean {
  return value.trim() === defaultValue.trim();
}

function formatIdentityLabel(agentName: string, companyDisplayName: string): string {
  const companySuffix = companyDisplayName.trim();
  return companySuffix ? agentName + " [" + companySuffix + "]" : agentName;
}

function getAgentDisplayName(agent: PaperclipAgentOption): string {
  return (agent.name || agent.title || agent.role || agent.id).trim();
}

function getCompanyDisplayName(companyName: string | null | undefined, companyPrefix: string | null | undefined, companyId: string): string {
  const resolvedName = (companyName ?? "").trim();
  if (resolvedName) return resolvedName;

  const displayName = titleCaseSlug(companyPrefix ?? "");
  return displayName || companyId.trim();
}

function titleCaseSlug(value: string): string {
  return value
    .trim()
    .replace(/[ _-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function slugifyGitHubAppName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "paperclip-agent";
}

export function toFormState(entry?: BotIdentitySettingsEntry): IdentityFormState {
  return {
    agentId: entry?.agentId ?? DEFAULT_BOT_IDENTITY_CONFIG.agentId,
    provider: entry?.provider ?? DEFAULT_BOT_IDENTITY_CONFIG.provider,
    label: entry?.label ?? DEFAULT_BOT_IDENTITY_CONFIG.label,
    githubUsername: entry?.provider === "github" ? entry.github.username : DEFAULT_BOT_IDENTITY_CONFIG.github.username,
    commitName: entry?.provider === "github" ? entry.github.commitName ?? "" : "",
    commitEmail: entry?.provider === "github" ? entry.github.commitEmail ?? "" : "",
    githubAppId: entry?.credential?.githubApp?.appId ?? "",
    githubInstallationId: entry?.credential?.githubApp?.installationId ?? "",
    privateKeySecretId: entry?.credential?.githubApp?.privateKeySecretId ?? "",
    privateKeyFile: entry?.credential?.githubApp?.privateKeyFile ?? "",
    fallbackTokenSecretId: entry?.credential?.secretId ?? "",
    tokenFile: entry?.credential?.tokenFile ?? "",
    previousAgentId: entry?.agentId ?? "",
    previousGithubAppId: entry?.credential?.githubApp?.appId ?? "",
    previousGithubInstallationId: entry?.credential?.githubApp?.installationId ?? "",
    previousPrivateKeySecretId: entry?.credential?.githubApp?.privateKeySecretId ?? "",
    previousPrivateKeyFile: entry?.credential?.githubApp?.privateKeyFile ?? "",
    slackTeamId: entry?.provider === "slack" ? entry.slack.teamId : "",
    slackAppId: entry?.provider === "slack" ? entry.slack.appId : "",
    slackBotUserId: entry?.provider === "slack" ? entry.slack.botUserId : "",
    slackDefaultChannel: entry?.provider === "slack" ? entry.slack.defaultChannel ?? "" : "",
    slackBotTokenSecretId: "",
  };
}

const MANIFEST_DRAFT_STORAGE_PREFIX = "paperclip-agent-identities:github-app-manifest-draft:";

function getManifestDraftStorageKey(state: string): string {
  return MANIFEST_DRAFT_STORAGE_PREFIX + state;
}

function writeManifestDraftForm(state: string, formState: IdentityFormState): void {
  try {
    window.sessionStorage.setItem(getManifestDraftStorageKey(state), JSON.stringify(formState));
  } catch {
    // Redirect restoration is best-effort; the server-side manifest flow still restores required fields.
  }
}

function readManifestDraftForm(state: string): IdentityFormState | null {
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

// Slack has no redirect/callback leg (the operator manually pastes install
// IDs back in after creating the app in a separate Slack tab), so unlike the
// GitHub draft above there is no page navigation to survive. But reloading
// settings or closing/reopening the editor still loses `slackManifestFlow`
// from React state alone. Persist just the opaque state token (not the
// manifest/fields) per identity so it can be handed to
// get-slack-app-manifest-flow to restore the flow within its 30-minute
// server-side window.
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

function normalizeManifestDraftForm(raw: unknown): IdentityFormState | null {
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
    slackTeamId: readString(raw.slackTeamId),
    slackAppId: readString(raw.slackAppId),
    slackBotUserId: readString(raw.slackBotUserId),
    slackDefaultChannel: readString(raw.slackDefaultChannel),
    slackBotTokenSecretId: readString(raw.slackBotTokenSecretId),
  };
}

const GITHUB_FORM_STEPS: Array<{ id: IdentityFormSection; label: string }> = [
  { id: "identity", label: "Identity" },
  { id: "github", label: "GitHub App" },
  { id: "commit", label: "Commit" },
];

const SLACK_FORM_STEPS: Array<{ id: IdentityFormSection; label: string }> = [
  { id: "identity", label: "Identity" },
  { id: "slack", label: "Slack App" },
];

export function getFormSteps(provider: string): Array<{ id: IdentityFormSection; label: string }> {
  return provider === SLACK_IDENTITY_PROVIDER_ID ? SLACK_FORM_STEPS : GITHUB_FORM_STEPS;
}

export function getIdentityFormValidation(
  config: IdentityFormState,
  hasDuplicate = false,
  slackSaveResult: SaveSlackInstallMetadataResult | null = null,
  slackManifestBusy = false,
): IdentityFormValidation {
  if (config.provider === SLACK_IDENTITY_PROVIDER_ID) {
    const hasIdentity = Boolean(config.agentId.trim() && config.provider.trim() && config.label.trim()) && !hasDuplicate;
    const hasSlackInstallFields = Boolean(
      config.slackTeamId.trim() &&
      config.slackAppId.trim() &&
      config.slackBotUserId.trim() &&
      config.slackBotTokenSecretId.trim()
    );
    // The install metadata is only considered saved when save-slack-install-metadata
    // has actually completed for the CURRENT field values -- editing any Slack field
    // after a successful save invalidates that prior result (see updateField), and a
    // save still in flight must not let the footer report completion early.
    const slackSaveMatchesCurrentFields = Boolean(
      slackSaveResult &&
      slackSaveResult.teamId === config.slackTeamId.trim() &&
      slackSaveResult.appId === config.slackAppId.trim() &&
      slackSaveResult.botUserId === config.slackBotUserId.trim() &&
      slackSaveResult.botTokenSecretId === config.slackBotTokenSecretId.trim() &&
      (slackSaveResult.defaultChannel ?? "") === config.slackDefaultChannel.trim()
    );
    const hasSlackInstall = hasSlackInstallFields && slackSaveMatchesCurrentFields && !slackManifestBusy;
    const identityComplete = hasIdentity;
    const credentialComplete = hasSlackInstall;
    const identityMessage = hasDuplicate
      ? "This agent already has an identity for the selected provider. Edit the existing identity instead."
      : !hasIdentity
        ? "Choose an agent, provider, and label before continuing."
      : "Identity details are complete.";
    const credentialMessage = credentialComplete
      ? "Slack install metadata is complete."
      : slackManifestBusy
        ? "Saving Slack install metadata..."
        : "Create the Slack App manifest, install it, and paste back the team/app/bot IDs and bot token secret, then save install metadata before this identity can be saved.";
    const saveMessage = !identityComplete
      ? identityMessage
      : !credentialComplete
        ? credentialMessage
        : "Required setup is complete.";
    return {
      identityComplete,
      credentialComplete,
      isComplete: identityComplete && credentialComplete,
      identityMessage,
      credentialMessage,
      saveMessage,
    };
  }
  const hasIdentity = Boolean(config.agentId.trim() && config.provider.trim() && config.label.trim() && config.githubUsername.trim()) && !hasDuplicate;
  const hasGitHubAppCredential = Boolean(
    config.githubAppId.trim() &&
    config.githubInstallationId.trim() &&
    (config.privateKeySecretId.trim() || config.privateKeyFile.trim())
  );
  const hasFallbackCredential = Boolean(config.fallbackTokenSecretId.trim() || config.tokenFile.trim());
  const identityComplete = hasIdentity;
  const credentialComplete = hasGitHubAppCredential || hasFallbackCredential;
  const identityMessage = hasDuplicate
    ? "This agent already has an identity for the selected provider. Edit the existing identity instead."
    : !hasIdentity
      ? "Choose an agent, provider, label, and provider username before continuing."
    : "Identity details are complete.";
  const credentialMessage = credentialComplete
    ? "Credential source is complete."
    : "Add a complete GitHub App credential, or choose a fallback token source, before this identity can be saved.";
  const saveMessage = !identityComplete
    ? identityMessage
    : !credentialComplete
      ? credentialMessage
      : "Required setup is complete. Review optional commit metadata, then save.";
  return {
    identityComplete,
    credentialComplete,
    isComplete: identityComplete && credentialComplete,
    identityMessage,
    credentialMessage,
    saveMessage,
  };
}

function getFormStepIndex(step: IdentityFormSection, provider: string): number {
  return getFormSteps(provider).findIndex((entry) => entry.id === step);
}

function getNextFormStep(step: IdentityFormSection, provider: string): IdentityFormSection {
  const steps = getFormSteps(provider);
  return steps[Math.min(getFormStepIndex(step, provider) + 1, steps.length - 1)]?.id ?? step;
}

function getPreviousFormStep(step: IdentityFormSection, provider: string): IdentityFormSection {
  const steps = getFormSteps(provider);
  return steps[Math.max(getFormStepIndex(step, provider) - 1, 0)]?.id ?? step;
}

function canAdvanceFromStep(step: IdentityFormSection, validation: IdentityFormValidation): boolean {
  if (step === "identity") return validation.identityComplete;
  if (step === "github" || step === "slack") return validation.credentialComplete;
  return validation.isComplete;
}

function isWizardStepComplete(step: IdentityFormSection, validation: IdentityFormValidation): boolean {
  if (step === "identity") return validation.identityComplete;
  if (step === "github" || step === "slack") return validation.credentialComplete;
  return validation.isComplete;
}

function formatAgentOption(agent: PaperclipAgentOption): string {
  const details = [agent.role, agent.status].filter(Boolean).join(" - ");
  return details ? `${getAgentDisplayName(agent)} (${details})` : getAgentDisplayName(agent);
}

function formatAgentName(agentId: string, agents: PaperclipAgentOption[]): string {
  const agent = agents.find((entry) => entry.id === agentId);
  return agent ? getAgentDisplayName(agent) : agentId;
}

function getProviderDisplayName(providerId: string, providers: BotIdentitySettingsData["providers"] | undefined): string {
  return providers?.find((provider) => provider.id === providerId)?.name ?? providerId;
}

function formatSecretOption(secret: PaperclipSecretOption): string {
  const label = secret.name || secret.key || secret.id;
  const details = [secret.key && secret.key !== label ? secret.key : null, secret.status, secret.provider]
    .filter(Boolean)
    .join(" - ");
  return details ? `${label} (${details})` : label;
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

function getFallbackTokenSecretFieldHint(input: {
  companyId: string;
  secretsLoading: boolean;
  secretsError: string | null;
  hasSecretOptions: boolean;
}): string {
  if (!input.companyId) {
    return "No company context is available, so paste the fallback token secret UUID manually.";
  }
  if (input.secretsLoading) {
    return "Loading Paperclip secrets...";
  }
  if (input.secretsError) {
    return `Could not load Paperclip secrets (${input.secretsError}); paste the fallback token secret UUID manually.`;
  }
  if (!input.hasSecretOptions) {
    return "No Paperclip secrets were found; paste the fallback token secret UUID manually or use a fallback token file.";
  }
  return "Optional fallback token secret. Prefer GitHub App credentials above.";
}


async function loadSecretOptions(companyId: string): Promise<PaperclipSecretOption[]> {
  const encodedCompanyId = encodeURIComponent(companyId);
  const paths = [
    `/api/companies/${encodedCompanyId}/secrets`,
    `/api/companies/${encodedCompanyId}/me/user-secrets`,
  ];

  let lastError: Error | null = null;
  for (const path of paths) {
    try {
      const response = await fetch(path, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        lastError = new Error(`${response.status} ${response.statusText}`.trim());
        continue;
      }
      return normalizeSecretOptions(await response.json());
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("Paperclip secrets API unavailable");
}

function normalizeSecretOptions(raw: unknown): PaperclipSecretOption[] {
  const candidates = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.secrets)
      ? raw.secrets
      : isRecord(raw) && Array.isArray(raw.userSecrets)
        ? raw.userSecrets
        : isRecord(raw) && Array.isArray(raw.companySecrets)
          ? raw.companySecrets
          : isRecord(raw) && Array.isArray(raw.items)
            ? raw.items
            : isRecord(raw) && Array.isArray(raw.results)
              ? raw.results
              : isRecord(raw) && Array.isArray(raw.data)
                ? raw.data
                : [];

  return candidates
    .map((entry) => normalizeSecretOption(entry))
    .filter((entry): entry is PaperclipSecretOption => Boolean(entry))
    .filter((entry) => !entry.status || entry.status === "active")
    .sort((left, right) => (left.name || left.key || left.id).localeCompare(right.name || right.key || right.id));
}

function normalizeSecretOption(raw: unknown): PaperclipSecretOption | null {
  const entry = isRecord(raw) && isRecord(raw.secret) ? raw.secret : raw;
  if (!isRecord(entry)) return null;
  const id = readString(entry.id) || readString(entry.secretId);
  if (!id) return null;

  return {
    id,
    name: readString(entry.name) || readString(entry.label) || readString(entry.key) || id,
    key: readString(entry.key) || undefined,
    description: readString(entry.description) || undefined,
    provider: readString(entry.provider) || undefined,
    status: readString(entry.status) || undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatCredentialStatus(status: BotIdentitySettingsEntry["credentialStatus"]): string {
  if (status === "configured") return "Configured";
  if (status === "sidecar-unavailable") return "Unavailable";
  return "Missing";
}

function getIdentityTone(entry: BotIdentitySettingsEntry): IdentityTone {
  if (entry.credentialStatus === "configured") return "good";
  if (entry.credentialStatus === "sidecar-unavailable") return "warn";
  return "neutral";
}

function summarizeIdentitySettings(identities: BotIdentitySettingsEntry[], sidecarUnavailable: boolean) {
  const githubApps = identities.filter((identity) => {
    const githubApp = identity.credential?.githubApp;
    return Boolean(githubApp?.appId && githubApp.installationId && (githubApp.privateKeySecretId || githubApp.privateKeyFile));
  }).length;
  return {
    total: identities.length,
    githubApps,
    needsSetup: sidecarUnavailable ? identities.length : identities.filter((identity) => identity.credentialStatus !== "configured").length,
  };
}

function hasGitHubAppPropagationValues(entry: BotIdentitySettingsEntry): boolean {
  const githubApp = entry.credential?.githubApp;
  return Boolean(githubApp?.appId && githubApp.installationId && (githubApp.privateKeySecretId || githubApp.privateKeyFile));
}

type AgentAdapterConfig = Record<string, unknown> & { env?: Record<string, unknown> };

type AgentPropagationMode = "ensure" | "remove";

type GitHubAppPropagationConfig = {
  appId: string;
  installationId: string;
  privateKeySecretRef?: string;
  privateKeyFile?: string;
};

type AgentPropagationPatchInput = {
  adapterConfig: unknown;
  githubApp: GitHubAppPropagationConfig;
  mode: AgentPropagationMode;
};

const GITHUB_APP_PROPAGATION_CONCURRENCY_LIMIT = 4;

async function syncGitHubAppCredentialPropagationForAgents(input: {
  selectedAgentIds: string[];
  previousAgentIds: string[];
  githubAppId?: string;
  githubInstallationId?: string;
  privateKeySecretRef?: string;
  privateKeyFile?: string;
  previousGithubAppId?: string;
  previousGithubInstallationId?: string;
  previousPrivateKeySecretRef?: string;
  previousPrivateKeyFile?: string;
}): Promise<void> {
  const selectedAgentIds = normalizeAgentIds(input.selectedAgentIds);
  const previousAgentIds = normalizeAgentIds(input.previousAgentIds);
  const selectedAgentIdSet = new Set(selectedAgentIds);
  const removeAgentIds = previousAgentIds.filter((agentId) => !selectedAgentIdSet.has(agentId));
  const operations: Array<{ agentId: string; mode: AgentPropagationMode; githubApp: GitHubAppPropagationConfig }> = [];

  if (selectedAgentIds.length > 0) {
    const selectedConfig = {
      appId: input.githubAppId,
      installationId: input.githubInstallationId,
      privateKeySecretRef: input.privateKeySecretRef,
      privateKeyFile: input.privateKeyFile,
    };
    if (hasCompleteGitHubAppValues(selectedConfig)) {
      const githubApp = buildGitHubAppPropagationConfig(selectedConfig);
      operations.push(...selectedAgentIds.map((agentId) => ({ agentId, mode: "ensure" as const, githubApp })));
    }
  }

  if (removeAgentIds.length > 0) {
    const removeConfig = {
      appId: input.previousGithubAppId ?? input.githubAppId,
      installationId: input.previousGithubInstallationId ?? input.githubInstallationId,
      privateKeySecretRef: input.previousPrivateKeySecretRef ?? input.privateKeySecretRef,
      privateKeyFile: input.previousPrivateKeyFile ?? input.privateKeyFile,
    };
    if (hasCompleteGitHubAppValues(removeConfig)) {
      const githubApp = buildGitHubAppPropagationConfig(removeConfig);
      operations.push(...removeAgentIds.map((agentId) => ({ agentId, mode: "remove" as const, githubApp })));
    }
  }

  const failures = new Set<string>();
  await runWithConcurrencyLimit(operations, GITHUB_APP_PROPAGATION_CONCURRENCY_LIMIT, async (operation) => {
    try {
      await applyGitHubAppPropagationUpdate(operation);
    } catch {
      failures.add(operation.agentId);
    }
  });

  if (failures.size > 0) {
    throw new Error(`GitHub App credential propagation could not update these agents: ${[...failures].join(", ")}.`);
  }
}

function hasCompleteGitHubAppValues(input: { appId?: string; installationId?: string; privateKeySecretRef?: string; privateKeyFile?: string }): boolean {
  const appId = input.appId?.trim();
  const installationId = input.installationId?.trim();
  const privateKeySecretRef = input.privateKeySecretRef?.trim();
  const privateKeyFile = input.privateKeyFile?.trim();
  return Boolean(appId && installationId && (privateKeySecretRef || privateKeyFile));
}

function buildGitHubAppPropagationConfig(
  input: {
    appId?: string;
    installationId?: string;
    privateKeySecretRef?: string;
    privateKeyFile?: string;
  }
): GitHubAppPropagationConfig {
  const appId = input.appId?.trim();
  const installationId = input.installationId?.trim();
  const privateKeySecretRef = input.privateKeySecretRef?.trim();
  const privateKeyFile = input.privateKeyFile?.trim();
  if (!appId || !installationId || (!privateKeySecretRef && !privateKeyFile)) {
    throw new Error("GitHub App credential propagation requires app ID, installation ID, and a private key secret or file.");
  }
  return {
    appId,
    installationId,
    ...(privateKeySecretRef ? { privateKeySecretRef } : {}),
    ...(privateKeyFile ? { privateKeyFile } : {}),
  };
}

function normalizeAgentIds(value: string[]): string[] {
  return value
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

async function runWithConcurrencyLimit<T>(
  items: T[],
  concurrencyLimit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const runnerCount = Math.min(concurrencyLimit, items.length);
  await Promise.all(Array.from({ length: runnerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex]);
    }
  }));
}

async function applyGitHubAppPropagationUpdate(input: {
  agentId: string;
  mode: AgentPropagationMode;
  githubApp: GitHubAppPropagationConfig;
}): Promise<void> {
  const agent = await fetchJson(`/api/agents/${encodeURIComponent(input.agentId)}`);
  const nextAdapterConfig = getAgentPropagationPatch({
    adapterConfig: isRecord(agent) ? agent.adapterConfig : undefined,
    githubApp: input.githubApp,
    mode: input.mode,
  });

  if (!nextAdapterConfig) {
    return;
  }

  await fetchJson(`/api/agents/${encodeURIComponent(input.agentId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      adapterConfig: nextAdapterConfig,
      replaceAdapterConfig: true,
    }),
  });
}

function getAgentPropagationPatch(input: AgentPropagationPatchInput): AgentAdapterConfig | null {
  const adapterConfig = isRecord(input.adapterConfig) ? { ...input.adapterConfig } as AgentAdapterConfig : {};
  const currentEnv = isRecord(adapterConfig.env) ? { ...adapterConfig.env } : {};

  if (input.mode === "ensure") {
    const nextEnv: Record<string, unknown> = {
      ...currentEnv,
      GITHUB_APP_ID: input.githubApp.appId,
      GITHUB_INSTALLATION_ID: input.githubApp.installationId,
    };
    if (input.githubApp.privateKeySecretRef) {
      nextEnv.GITHUB_APP_PRIVATE_KEY = {
        type: "secret_ref",
        secretId: input.githubApp.privateKeySecretRef,
        version: "latest",
      };
      delete nextEnv.GITHUB_APP_PRIVATE_KEY_FILE;
    } else if (input.githubApp.privateKeyFile) {
      nextEnv.GITHUB_APP_PRIVATE_KEY_FILE = input.githubApp.privateKeyFile;
      delete nextEnv.GITHUB_APP_PRIVATE_KEY;
    }
    if (JSON.stringify(nextEnv) === JSON.stringify(currentEnv)) {
      return null;
    }
    return { ...adapterConfig, env: nextEnv };
  }

  if (!isMatchingGitHubAppEnvBindings(currentEnv, input.githubApp)) {
    return null;
  }

  const nextEnv = { ...currentEnv };
  delete nextEnv.GITHUB_APP_ID;
  delete nextEnv.GITHUB_INSTALLATION_ID;
  delete nextEnv.GITHUB_APP_PRIVATE_KEY;
  delete nextEnv.GITHUB_APP_PRIVATE_KEY_FILE;
  const nextAdapterConfig = { ...adapterConfig };
  if (Object.keys(nextEnv).length > 0) {
    nextAdapterConfig.env = nextEnv;
  } else {
    delete nextAdapterConfig.env;
  }
  return nextAdapterConfig;
}

function isMatchingGitHubAppEnvBindings(env: Record<string, unknown>, githubApp: GitHubAppPropagationConfig): boolean {
  if (env.GITHUB_APP_ID !== githubApp.appId || env.GITHUB_INSTALLATION_ID !== githubApp.installationId) {
    return false;
  }
  if (githubApp.privateKeySecretRef) {
    return isMatchingSecretRefEnvBinding(env.GITHUB_APP_PRIVATE_KEY, githubApp.privateKeySecretRef);
  }
  return Boolean(githubApp.privateKeyFile && env.GITHUB_APP_PRIVATE_KEY_FILE === githubApp.privateKeyFile);
}

function isMatchingSecretRefEnvBinding(value: unknown, secretId: string): boolean {
  return isRecord(value) && value.type === "secret_ref" && value.secretId === secretId;
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }
  return await response.json();
}

function getAgentFieldHint(input: {
  companyId: string;
  agentsLoading: boolean;
  agentsError: unknown;
  hasAgentOptions: boolean;
}): string {
  if (!input.companyId) {
    return "No company context is available, so paste the Paperclip agent UUID manually.";
  }
  if (input.agentsLoading) {
    return "Loading Paperclip agents...";
  }
  if (input.agentsError) {
    return "Could not load Paperclip agents; paste the agent UUID manually.";
  }
  if (!input.hasAgentOptions) {
    return "No Paperclip agents were found for this company; paste the agent UUID manually.";
  }
  return "The Paperclip agent that will use this identity.";
}

const responsiveSettingsStyle = `
.agent-identities-settings,
.agent-identities-settings * {
  box-sizing: border-box;
}

.agent-identities-summary-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.agent-identities-settings-shell {
  grid-template-columns: 220px minmax(0, 1fr);
}

.agent-identities-list-header,
.agent-identities-list-row {
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(90px, auto) auto;
}

.agent-identities-row-actions {
  justify-content: flex-end;
}

.agent-identities-wizard-steps {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

@container (max-width: 720px) {
  .agent-identities-settings-shell {
    grid-template-columns: minmax(0, 1fr);
  }

  .agent-identities-sidebar {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@container (max-width: 520px) {
  .agent-identities-summary-grid,
  .agent-identities-sidebar,
  .agent-identities-wizard-steps {
    grid-template-columns: minmax(0, 1fr);
  }

  .agent-identities-list-header {
    display: none !important;
  }

  .agent-identities-list-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .agent-identities-list-row > :nth-child(1) {
    grid-column: 1;
    grid-row: 1;
  }

  .agent-identities-list-row > :nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .agent-identities-list-row > :nth-child(3) {
    grid-column: 2;
    grid-row: 1;
  }

  .agent-identities-list-row > :nth-child(4) {
    grid-column: 1 / -1;
    grid-row: 3;
    justify-content: flex-start;
  }
}
`;

const pageStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  maxWidth: 1160,
  display: "grid",
  gap: "1rem",
  color: uiText,
  containerType: "inline-size",
};

const pageTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.125rem",
  lineHeight: 1.2,
  letterSpacing: "-0.02em",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  flexWrap: "wrap",
};

const descriptionStyle: CSSProperties = {
  margin: "0.35rem 0 0",
  color: uiMutedText,
  fontSize: "0.875rem",
};

const summaryGridStyle: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
};

function summaryTileStyle(tone: IdentityTone): CSSProperties {
  return {
    display: "grid",
    gap: "0.25rem",
    padding: "0.85rem 1rem",
    border: `1px solid ${toneBorder(tone)}`,
    borderRadius: 12,
    backgroundColor: toneBackground(tone),
  };
}

const summaryValueStyle: CSSProperties = {
  fontSize: "1.125rem",
  fontWeight: 700,
  lineHeight: 1,
};

const summaryLabelStyle: CSSProperties = {
  color: uiMutedText,
  fontSize: "0.8125rem",
  fontWeight: 600,
};

const credentialErrorStyle: CSSProperties = {
  padding: "0.75rem 0.9rem",
  backgroundColor: "color-mix(in srgb, var(--agent-identities-danger) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--agent-identities-danger) 45%, transparent)",
  borderRadius: 10,
  color: uiDanger,
  fontSize: "0.875rem",
};

const settingsShellStyle: CSSProperties = {
  display: "grid",
  gap: "1rem",
  alignItems: "start",
  minWidth: 0,
};

const sidebarStyle: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  padding: "0.5rem",
  border: `1px solid ${uiBorder}`,
  borderRadius: 14,
  backgroundColor: uiPanel,
};

function sidebarButtonStyle(active: boolean): CSSProperties {
  return {
    display: "grid",
    gap: "0.15rem",
    width: "100%",
    minHeight: 54,
    padding: "0.65rem 0.75rem",
    border: `1px solid ${active ? uiBorderStrong : "transparent"}`,
    borderRadius: 10,
    backgroundColor: active ? uiSurface : "transparent",
    color: uiText,
    textAlign: "left",
    cursor: "pointer",
  };
}

const sidebarTitleStyle: CSSProperties = {
  fontWeight: 650,
  fontSize: "0.875rem",
};

const sidebarDetailStyle: CSSProperties = {
  color: uiMutedText,
  fontSize: "0.8125rem",
};

const workspaceStyle: CSSProperties = {
  minWidth: 0,
};

const sectionStyle: CSSProperties = {
  minWidth: 0,
  border: `1px solid ${uiBorder}`,
  borderRadius: 14,
  padding: "1rem",
  display: "grid",
  gap: "0.9rem",
  backgroundColor: uiSurface,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.875rem",
  lineHeight: 1.25,
};

const sectionDescriptionStyle: CSSProperties = {
  margin: "0.25rem 0 0",
  color: uiMutedText,
  fontSize: "0.875rem",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  minWidth: 0,
};

const listHeaderStyle: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "0 0.75rem 0.25rem",
  color: uiMutedText,
  fontSize: "0.8125rem",
  fontWeight: 650,
};

const rowStyle: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  alignItems: "center",
  border: `1px solid ${uiBorder}`,
  borderRadius: 10,
  padding: "0.75rem",
  backgroundColor: uiPanel,
};

const rowTitleStyle: CSSProperties = {
  fontWeight: 650,
  overflowWrap: "anywhere",
};

const rowMetaStyle: CSSProperties = {
  color: uiMutedText,
  fontSize: "0.875rem",
  overflowWrap: "anywhere",
};

const rowActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const emptyStateStyle: CSSProperties = {
  display: "grid",
  justifyItems: "start",
  gap: "0.5rem",
  padding: "1.25rem",
  border: `1px dashed ${uiBorderStrong}`,
  borderRadius: 12,
  color: uiMutedText,
  backgroundColor: uiPanel,
};

const setupStepsStyle: CSSProperties = {
  display: "grid",
  gap: "0.5rem",
};

const setupStepStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "2rem minmax(0, 1fr)",
  gap: "0.75rem",
  alignItems: "start",
  padding: "0.75rem",
  border: `1px solid ${uiBorder}`,
  borderRadius: 10,
  backgroundColor: uiPanel,
};

const setupStepIndexStyle: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  width: "2rem",
  height: "2rem",
  borderRadius: 999,
  backgroundColor: uiMutedPanel,
  color: uiMutedText,
  fontWeight: 700,
  fontSize: "0.8125rem",
};

const setupStepTextStyle: CSSProperties = {
  margin: "0.2rem 0 0",
  color: uiMutedText,
  fontSize: "0.875rem",
};

const dialogBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "grid",
  placeItems: "start center",
  padding: "7vh 1rem 1rem",
  backgroundColor: uiOverlay,
  overflowY: "auto",
};

const dialogStyle: CSSProperties = {
  width: "min(760px, 100%)",
  maxHeight: "86vh",
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  border: `1px solid ${uiBorder}`,
  borderRadius: 16,
  backgroundColor: uiCanvas,
  color: uiText,
  boxShadow: `0 24px 80px ${uiShadow}`,
  overflow: "hidden",
};

const dialogHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "1.1rem 1.25rem 0.9rem",
  borderBottom: `1px solid ${uiBorder}`,
};

const dialogTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.125rem",
  lineHeight: 1.2,
  letterSpacing: "-0.015em",
};

const closeButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  border: `1px solid ${uiBorder}`,
  borderRadius: 8,
  backgroundColor: "transparent",
  color: uiMutedText,
  cursor: "pointer",
  fontSize: "0.875rem",
};

const dialogBodyStyle: CSSProperties = {
  display: "grid",
  gap: "0.85rem",
  padding: "1rem 1.25rem",
  overflowY: "auto",
};

const wizardStepListStyle: CSSProperties = {
  display: "grid",
  gap: "0.5rem",
};

function wizardStepStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    minHeight: 36,
    padding: "0.45rem 0.6rem",
    border: `1px solid ${active ? uiBorderStrong : uiBorder}`,
    borderRadius: 8,
    backgroundColor: active ? uiSurface : "transparent",
    color: active ? uiText : uiMutedText,
    fontSize: "0.875rem",
    fontWeight: active ? 600 : 500,
  };
}

function wizardStepNumberStyle(active: boolean, complete: boolean): CSSProperties {
  return {
    display: "inline-grid",
    placeItems: "center",
    width: 22,
    height: 22,
    borderRadius: 999,
    border: `1px solid ${complete ? uiSuccess : active ? uiBorderStrong : uiBorder}`,
    backgroundColor: complete ? "color-mix(in srgb, var(--agent-identities-success) 14%, transparent)" : uiPanel,
    color: complete ? uiSuccess : active ? uiText : uiMutedText,
    fontSize: "0.8125rem",
    fontWeight: 600,
  };
}

const dialogFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
  padding: "0.9rem 1.25rem",
  borderTop: `1px solid ${uiBorder}`,
  backgroundColor: uiPanel,
};

const saveStatusStyle: CSSProperties = {
  marginRight: "auto",
  fontSize: "0.875rem",
};

const validationNoticeStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  border: "1px solid color-mix(in srgb, var(--agent-identities-warning) 36%, transparent)",
  borderRadius: 8,
  backgroundColor: "color-mix(in srgb, var(--agent-identities-warning) 8%, transparent)",
  color: uiText,
  fontSize: "0.875rem",
};

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

const detailsBodyStyle: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  marginTop: "0.75rem",
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

const primaryButtonStyle: CSSProperties = {
  minHeight: 38,
  padding: "0.48rem 0.9rem",
  backgroundColor: uiPrimary,
  color: uiPrimaryText,
  border: `1px solid ${uiBorderStrong}`,
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 650,
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

const dangerButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  color: uiDanger,
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

function statusBadgeStyle(tone: IdentityTone): CSSProperties {
  return {
    justifySelf: "start",
    border: `1px solid ${toneBorder(tone)}`,
    borderRadius: 999,
    padding: "0.2rem 0.55rem",
    color: toneText(tone),
    backgroundColor: toneBackground(tone),
    fontSize: "0.8125rem",
    fontWeight: 650,
    whiteSpace: "nowrap",
  };
}

function buttonStyle(base: CSSProperties, disabled: boolean): CSSProperties {
  return disabled ? { ...base, opacity: 0.55, cursor: "not-allowed" } : base;
}

function toneText(tone: IdentityTone): string {
  if (tone === "good") return uiSuccess;
  if (tone === "warn") return uiWarning;
  return uiMutedText;
}

function toneBorder(tone: IdentityTone): string {
  if (tone === "good") return "color-mix(in srgb, var(--agent-identities-success) 42%, transparent)";
  if (tone === "warn") return "color-mix(in srgb, var(--agent-identities-warning) 48%, transparent)";
  return uiBorder;
}

function toneBackground(tone: IdentityTone): string {
  if (tone === "good") return "color-mix(in srgb, var(--agent-identities-success) 10%, transparent)";
  if (tone === "warn") return "color-mix(in srgb, var(--agent-identities-warning) 12%, transparent)";
  return uiPanel;
}
