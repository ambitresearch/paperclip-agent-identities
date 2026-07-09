import { useEffect, useState, type CSSProperties } from "react";
import { usePluginData, usePluginAction, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { DEFAULT_ALLOWED_REPO_PATTERNS, DEFAULT_BOT_IDENTITY_CONFIG } from "../shared/types.js";
import type {
  BotIdentitySettingsData,
  BotIdentitySettingsEntry,
  PaperclipAgentOption,
  PaperclipAgentsData,
  SaveBotIdentityConfigInput,
  CreateGitHubAppManifestResult,
  ConvertGitHubAppManifestResult,
  GetGitHubAppManifestFlowResult
} from "../shared/types.js";

type PaperclipSecretOption = {
  id: string;
  name: string;
  key?: string;
  description?: string;
  provider?: string;
  status?: string;
};

type IdentityFormState = {
  agentId: string;
  label: string;
  githubUsername: string;
  allowedRepoPatternsText: string;
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
};

export function SettingsPage(props: PluginSettingsPageProps) {
  const companyId = props.context.companyId ?? "";
  const companyDisplayName = getCompanyDisplayName(props.context.companyPrefix, companyId);
  const { data, loading, error, refresh } = usePluginData<BotIdentitySettingsData>("bot-identity-config", { companyId });
  const { data: agentsData, loading: agentsLoading, error: agentsError } = usePluginData<PaperclipAgentsData>("paperclip-agents", { companyId });
  const saveConfig = usePluginAction("save-bot-identity-config");
  const deleteConfig = usePluginAction("delete-bot-identity-config");
  const createGitHubAppManifest = usePluginAction("create-github-app-manifest");
  const getGitHubAppManifestFlow = usePluginAction("get-github-app-manifest-flow");
  const convertGitHubAppManifest = usePluginAction("convert-github-app-manifest");

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
  const identities = data?.identities ?? [];
  const agentOptions = agentsData?.agents ?? [];

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
        const savedIdentity = identities.find((entry) => entry.agentId === flow.agentId);
        const selectedAgent = agentOptions.find((agent) => agent.id === flow.agentId);
        const defaults = selectedAgent ? getAgentIdentityDefaults(selectedAgent, companyDisplayName) : null;
        const restoredForm = toFormState(savedIdentity);
        const draftForm = readManifestDraftForm(callback.state);
        const conversion = flow.conversion;
        setFormState({
          ...restoredForm,
          ...draftForm,
          agentId: flow.agentId,
          label: draftForm?.label || restoredForm.label || flow.label,
          githubUsername: conversion?.githubUsername || draftForm?.githubUsername || restoredForm.githubUsername || defaults?.githubUsername || DEFAULT_BOT_IDENTITY_CONFIG.githubUsername,
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
  }, [agentOptions, companyDisplayName, getGitHubAppManifestFlow, identities]);

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
  const isEditingExistingIdentity = Boolean(config && identities.some((entry) => entry.agentId === config.agentId));
  const hasExistingGitHubAppCredential = Boolean(
    config?.previousGithubAppId ||
    config?.previousGithubInstallationId ||
    config?.previousPrivateKeySecretId ||
    config?.previousPrivateKeyFile
  );

  if (loading) return <div>Loading settings...</div>;
  if (error) return <div>Error loading settings: {error.message}</div>;

  function startCreate() {
    setFormState(toFormState());
    setSaveError(null);
    setSaveSuccess(false);
    resetManifestFlow();
  }

  function startEdit(entry: BotIdentitySettingsEntry) {
    setFormState(toFormState(entry));
    setSaveError(null);
    setSaveSuccess(false);
    resetManifestFlow();
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
    }
  }

  function updateAgentSelection(agentId: string) {
    setFormState((prev) => {
      const base = prev ?? toFormState();
      const selectedAgent = agentOptions.find((agent) => agent.id === agentId);
      if (!selectedAgent || base.previousAgentId || base.agentId === agentId) {
        return { ...base, agentId };
      }
      const defaults = getAgentIdentityDefaults(selectedAgent, companyDisplayName);
      return {
        ...base,
        agentId,
        label: shouldPrefillIdentityField(base.label, DEFAULT_BOT_IDENTITY_CONFIG.label) ? defaults.label : base.label,
        githubUsername: shouldPrefillIdentityField(base.githubUsername, DEFAULT_BOT_IDENTITY_CONFIG.githubUsername) ? defaults.githubUsername : base.githubUsername,
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

  async function handleCreateGitHubAppManifest() {
    if (!config) return;
    setManifestBusy(true);
    setManifestError(null);
    setManifestResult(null);
    try {
      const result = await createGitHubAppManifest({
        agentId: config.agentId.trim(),
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
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const targetAgentId = config.agentId.trim();
      const previousAgentIds = config.previousAgentId && config.previousAgentId !== targetAgentId ? [config.previousAgentId] : [];
      const payload: SaveBotIdentityConfigInput = {
        agentId: config.agentId.trim(),
        label: config.label.trim(),
        githubUsername: config.githubUsername.trim(),
        allowedRepoPatterns: parseAllowedRepoPatterns(config.allowedRepoPatternsText),
        commitName: config.commitName.trim() || undefined,
        commitEmail: config.commitEmail.trim() || undefined,
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
      await syncGitHubAppCredentialPropagationForAgents({
        selectedAgentIds: [],
        previousAgentIds: [entry.agentId],
        previousGithubAppId: entry.credential?.githubApp?.appId,
        previousGithubInstallationId: entry.credential?.githubApp?.installationId,
        previousPrivateKeySecretRef: entry.credential?.githubApp?.privateKeySecretId,
        previousPrivateKeyFile: entry.credential?.githubApp?.privateKeyFile,
      });
      await deleteConfig({ agentId: entry.agentId });
      if (formState?.agentId === entry.agentId) {
        setFormState(null);
      }
      await refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeletingAgentId(null);
    }
  }

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <div>
          <h2 style={{ margin: 0 }}>Agent Identities</h2>
          <p style={descriptionStyle}>
            Configure per-agent identity providers. GitHub is the first provider, with per-agent bot metadata and GitHub App token sources.
          </p>
        </div>
        <button
          onClick={startCreate}
          style={iconButtonStyle}
          title="Add agent"
          aria-label="Add agent"
        >
          +
        </button>
      </div>

      {data?.credentialSidecarError && (
        <div style={credentialErrorStyle}>
          Credential source unavailable: {data.credentialSidecarError}
        </div>
      )}

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>Configured agents</h3>
        {identities.length === 0 ? (
          <p style={hintStyle}>No agents configured yet. Add one to enable provider-backed agent tools.</p>
        ) : (
          <div style={listStyle}>
            {identities.map((entry) => (
              <div key={entry.agentId} style={rowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={rowTitleStyle}>{entry.label}</div>
                  <div style={rowMetaStyle}>
                    {entry.githubUsername} · {formatAgentName(entry.agentId, agentOptions)} · credential {formatCredentialStatus(entry.credentialStatus)}
                  </div>
                </div>
                <div style={rowActionsStyle}>
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

      {config && (
        <section style={sectionStyle}>
          <h3 style={sectionTitleStyle}>{isEditingExistingIdentity ? "Edit agent identity" : "Add agent identity"}</h3>

          <fieldset style={fieldsetStyle}>
            <legend style={{ fontWeight: 600 }}>Identity</legend>

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

          <fieldset style={fieldsetStyle}>
            <legend style={{ fontWeight: 600 }}>GitHub policy</legend>

            <label style={fieldStyle}>
              <span>GitHub Username <span style={requiredStyle}>*</span></span>
              <input
                type="text"
                value={config.githubUsername}
                onChange={(e) => updateField("githubUsername", e.target.value)}
                placeholder="e.g. ouroboros-paperclip-bot[bot]"
                style={inputStyle}
              />
              <span style={hintStyle}>Public GitHub login expected for this agent's GitHub identity.</span>
            </label>

            <label style={fieldStyle}>
              <span>Allowed repository patterns</span>
              <textarea
                value={config.allowedRepoPatternsText}
                onChange={(e) => updateField("allowedRepoPatternsText", e.target.value)}
                placeholder="my-org/*
my-org/my-repo"
                rows={4}
                style={textareaStyle}
              />
              <span style={hintStyle}>One owner/repo pattern per line. Supports * and ? wildcards; examples: my-org/* or my-org/my-repo.</span>
            </label>
          </fieldset>

          <fieldset style={fieldsetStyle}>
            <legend style={{ fontWeight: 600 }}>GitHub App credential source</legend>

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
                placeholder="/paperclip/.paperclip/agent-identities/github-apps/<agent>/private-key.pem"
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
                    placeholder="/paperclip/.paperclip/agent-identities/tokens/<agent-id>.token"
                    style={inputStyle}
                  />
                  <span style={hintStyle}>Compatibility only. Prefer GitHub App credentials above.</span>
                </label>
              </div>
            </details>
          </fieldset>

          <div style={inlineNoticeStyle}>
            Saving this identity cascades the GitHub App values to the selected agent environment as <code>GITHUB_APP_ID</code>, <code>GITHUB_INSTALLATION_ID</code>, and either <code>GITHUB_APP_PRIVATE_KEY</code> or <code>GITHUB_APP_PRIVATE_KEY_FILE</code>.
          </div>

          <fieldset style={fieldsetStyle}>
            <legend style={{ fontWeight: 600 }}>Commit identity (optional)</legend>

            <label style={fieldStyle}>
              <span>Commit Name</span>
              <input
                type="text"
                value={config.commitName}
                onChange={(e) => updateField("commitName", e.target.value)}
                placeholder="e.g. Ouroboros Paperclip Bot"
                style={inputStyle}
              />
            </label>

            <label style={fieldStyle}>
              <span>Commit Email</span>
              <input
                type="text"
                value={config.commitEmail}
                onChange={(e) => updateField("commitEmail", e.target.value)}
                placeholder="e.g. bot@example.com"
                style={inputStyle}
              />
            </label>
          </fieldset>

          <div style={formActionsStyle}>
            <button
              onClick={() => void handleSave()}
              disabled={saving || !config.agentId || !config.label || !config.githubUsername}
              style={primaryButtonStyle}
            >
              {saving ? "Saving..." : "Save agent"}
            </button>
            <button onClick={() => setFormState(null)} disabled={saving} style={secondaryButtonStyle}>Cancel</button>
            {saveSuccess && <span style={successStyle}>Saved successfully.</span>}
            {saveError && <span style={errorStyle}>{saveError}</span>}
          </div>
        </section>
      )}
    </div>
  );
}


function GitHubAppManifestCreateIntro() {
  return (
    <div style={inlineNoticeStyle}>
      <strong>Create a GitHub App with a manifest.</strong> This opens GitHub with the required bot permissions prefilled. After GitHub creates the app, Paperclip saves the generated private key file, preloads the App ID, opens the install flow, and restores the form with the Installation ID when GitHub redirects back.
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

function getAgentIdentityDefaults(agent: PaperclipAgentOption, companyDisplayName: string): Pick<IdentityFormState, "label" | "githubUsername" | "commitName" | "commitEmail" | "privateKeyFile"> {
  const displayName = getAgentDisplayName(agent);
  const slug = slugifyGitHubAppName(displayName);
  return {
    label: formatIdentityLabel(displayName, companyDisplayName),
    githubUsername: `${slug}[bot]`,
    commitName: `${displayName} Paperclip Bot`,
    commitEmail: `${slug}[bot]@users.noreply.github.com`,
    privateKeyFile: `/paperclip/.paperclip/agent-identities/github-apps/${agent.id}/private-key.pem`,
  };
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

function getCompanyDisplayName(companyPrefix: string | null | undefined, companyId: string): string {
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

function toFormState(entry?: BotIdentitySettingsEntry): IdentityFormState {
  return {
    agentId: entry?.agentId ?? DEFAULT_BOT_IDENTITY_CONFIG.agentId,
    label: entry?.label ?? DEFAULT_BOT_IDENTITY_CONFIG.label,
    githubUsername: entry?.githubUsername ?? DEFAULT_BOT_IDENTITY_CONFIG.githubUsername,
    allowedRepoPatternsText: (entry?.allowedRepoPatterns ?? DEFAULT_ALLOWED_REPO_PATTERNS).join("\n"),
    commitName: entry?.commitName ?? "",
    commitEmail: entry?.commitEmail ?? "",
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

function normalizeManifestDraftForm(raw: unknown): IdentityFormState | null {
  if (!isRecord(raw)) return null;
  return {
    agentId: readString(raw.agentId),
    label: readString(raw.label),
    githubUsername: readString(raw.githubUsername),
    allowedRepoPatternsText: readString(raw.allowedRepoPatternsText),
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

function parseAllowedRepoPatterns(value: string): string[] {
  return parseAgentIds(value);
}

function parseAgentIds(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function formatAgentOption(agent: PaperclipAgentOption): string {
  const detail = agent.title || agent.role || agent.status;
  return detail ? `${agent.name} - ${detail}` : agent.name;
}

function formatAgentName(agentId: string, agents: PaperclipAgentOption[]): string {
  const agent = agents.find((entry) => entry.id === agentId);
  return agent ? agent.name : agentId;
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
  if (status === "configured") return "configured";
  if (status === "sidecar-unavailable") return "unavailable";
  return "missing";
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
    const githubApp = buildGitHubAppPropagationConfig({
      appId: input.githubAppId,
      installationId: input.githubInstallationId,
      privateKeySecretRef: input.privateKeySecretRef,
      privateKeyFile: input.privateKeyFile,
    }, "GitHub App credential propagation requires app ID, installation ID, and a private key secret or file.");
    operations.push(...selectedAgentIds.map((agentId) => ({ agentId, mode: "ensure" as const, githubApp })));
  }

  if (removeAgentIds.length > 0) {
    const githubApp = buildGitHubAppPropagationConfig({
      appId: input.previousGithubAppId ?? input.githubAppId,
      installationId: input.previousGithubInstallationId ?? input.githubInstallationId,
      privateKeySecretRef: input.previousPrivateKeySecretRef ?? input.privateKeySecretRef,
      privateKeyFile: input.previousPrivateKeyFile ?? input.privateKeyFile,
    }, "Cannot safely remove prior GitHub App propagation without the previous app credential values.");
    operations.push(...removeAgentIds.map((agentId) => ({ agentId, mode: "remove" as const, githubApp })));
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

function buildGitHubAppPropagationConfig(
  input: {
    appId?: string;
    installationId?: string;
    privateKeySecretRef?: string;
    privateKeyFile?: string;
  },
  errorMessage: string
): GitHubAppPropagationConfig {
  const appId = input.appId?.trim();
  const installationId = input.installationId?.trim();
  const privateKeySecretRef = input.privateKeySecretRef?.trim();
  const privateKeyFile = input.privateKeyFile?.trim();
  if (!appId || !installationId || (!privateKeySecretRef && !privateKeyFile)) {
    throw new Error(errorMessage);
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

const pageStyle: CSSProperties = {
  maxWidth: 920,
  display: "grid",
  gap: "1rem",
  color: "CanvasText",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
};

const descriptionStyle: CSSProperties = {
  margin: "0.35rem 0 0",
  color: "CanvasText",
  opacity: 0.82,
};

const credentialErrorStyle: CSSProperties = {
  padding: "0.65rem 0.85rem",
  backgroundColor: "rgba(255, 107, 107, 0.12)",
  border: "1px solid rgba(255, 107, 107, 0.45)",
  borderRadius: 6,
  color: "#ff6b6b",
  fontSize: "0.9rem",
};

const sectionStyle: CSSProperties = {
  border: "1px solid GrayText",
  borderRadius: 6,
  padding: "1rem",
  display: "grid",
  gap: "0.85rem",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "0.5rem",
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  alignItems: "center",
  border: "1px solid GrayText",
  borderRadius: 4,
  padding: "0.75rem",
};

const rowTitleStyle: CSSProperties = {
  fontWeight: 700,
};

const rowMetaStyle: CSSProperties = {
  color: "GrayText",
  fontSize: "0.85rem",
  overflowWrap: "anywhere",
};

const rowActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
};

const fieldsetStyle: CSSProperties = {
  border: "1px solid GrayText",
  borderRadius: 4,
  padding: "1rem",
  display: "grid",
  gap: "0.75rem",
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "0.25rem",
};

const inputStyle: CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid GrayText",
  borderRadius: 4,
  fontSize: "0.9rem",
  backgroundColor: "Field",
  color: "FieldText",
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
  padding: "0.75rem",
  border: "1px dashed GrayText",
  borderRadius: 6,
};

const linkStyle: CSSProperties = {
  color: "#58a6ff",
};

const inlineNoticeStyle: CSSProperties = {
  padding: "0.65rem 0.85rem",
  border: "1px solid color-mix(in srgb, CanvasText 14%, transparent)",
  borderRadius: 6,
  backgroundColor: "color-mix(in srgb, CanvasText 5%, transparent)",
  color: "GrayText",
  fontSize: "0.86rem",
};

const hintStyle: CSSProperties = {
  fontSize: "0.8rem",
  color: "GrayText",
};

const formActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};

const primaryButtonStyle: CSSProperties = {
  padding: "0.5rem 1rem",
  backgroundColor: "#0d6efd",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};

const iconButtonStyle: CSSProperties = {
  width: 38,
  height: 38,
  display: "inline-grid",
  placeItems: "center",
  flexShrink: 0,
  borderRadius: "999px",
  border: "1px solid color-mix(in srgb, CanvasText 22%, transparent)",
  backgroundColor: "color-mix(in srgb, CanvasText 8%, transparent)",
  color: "CanvasText",
  cursor: "pointer",
  fontSize: "1.45rem",
  lineHeight: 1,
  fontWeight: 500,
};

const secondaryButtonStyle: CSSProperties = {
  padding: "0.45rem 0.8rem",
  backgroundColor: "transparent",
  color: "CanvasText",
  border: "1px solid GrayText",
  borderRadius: 4,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  color: "#ff6b6b",
};

const requiredStyle: CSSProperties = {
  color: "#ff6b6b",
};

const successStyle: CSSProperties = {
  color: "#2da44e",
};

const errorStyle: CSSProperties = {
  color: "#ff6b6b",
};
