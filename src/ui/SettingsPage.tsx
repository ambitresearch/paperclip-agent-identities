import { useState } from "react";
import { usePluginData, usePluginAction, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";

type BotIdentityConfig = {
  agentId: string;
  label: string;
  githubUsername: string;
  tokenSecretRef: string;
  allowedOwnerPattern: string;
  commitName?: string;
  commitEmail?: string;
};

export function SettingsPage(_props: PluginSettingsPageProps) {
  const { data, loading, error, refresh } = usePluginData<BotIdentityConfig | null>("bot-identity-config");
  const saveConfig = usePluginAction("save-bot-identity-config");

  const [formState, setFormState] = useState<BotIdentityConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const config = formState ?? data ?? {
    agentId: "",
    label: "",
    githubUsername: "",
    tokenSecretRef: "",
    allowedOwnerPattern: "^roshangautam$",
    commitName: "",
    commitEmail: "",
  };

  if (loading) return <div>Loading settings...</div>;
  if (error) return <div>Error loading settings: {error.message}</div>;

  function updateField(field: keyof BotIdentityConfig, value: string) {
    setFormState((prev) => ({
      ...(prev ?? data ?? {
        agentId: "",
        label: "",
        githubUsername: "",
        tokenSecretRef: "",
        allowedOwnerPattern: "^roshangautam$",
        commitName: "",
        commitEmail: "",
      }),
      [field]: value,
    }));
    setSaveSuccess(false);
    setSaveError(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await saveConfig(config as unknown as Record<string, unknown>);
      setSaveSuccess(true);
      refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 600, display: "grid", gap: "1rem" }}>
      <h2 style={{ margin: 0 }}>Pilot Agent Bot Identity Mapping</h2>
      <p style={{ margin: 0, color: "#555" }}>
        Configure which Paperclip agent acts through a GitHub bot account.
        The agent will use this identity for all GitHub operations on allowed repositories.
      </p>

      <div style={{ padding: "0.75rem 1rem", backgroundColor: "#fff3cd", border: "1px solid #ffc107", borderRadius: 4 }}>
        <strong>Security notice:</strong> The token secret ref must point to a <em>bot account</em> credential
        managed by Paperclip secrets, never a personal access token. The raw token is never exposed in
        this UI or stored in plugin config — only the secret reference is saved.
      </div>

      <fieldset style={{ border: "1px solid #ddd", borderRadius: 4, padding: "1rem", display: "grid", gap: "0.75rem" }}>
        <legend style={{ fontWeight: 600 }}>Identity</legend>

        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>Agent ID <span style={{ color: "red" }}>*</span></span>
          <input
            type="text"
            value={config.agentId}
            onChange={(e) => updateField("agentId", e.target.value)}
            placeholder="UUID of the pilot Paperclip agent"
            style={inputStyle}
          />
          <span style={hintStyle}>The Paperclip agent that will use this bot identity.</span>
        </label>

        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>Label <span style={{ color: "red" }}>*</span></span>
          <input
            type="text"
            value={config.label}
            onChange={(e) => updateField("label", e.target.value)}
            placeholder="e.g. QA Bot, Deploy Bot"
            style={inputStyle}
          />
          <span style={hintStyle}>Human-readable name for this identity mapping.</span>
        </label>
      </fieldset>

      <fieldset style={{ border: "1px solid #ddd", borderRadius: 4, padding: "1rem", display: "grid", gap: "0.75rem" }}>
        <legend style={{ fontWeight: 600 }}>GitHub Account</legend>

        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>GitHub Username <span style={{ color: "red" }}>*</span></span>
          <input
            type="text"
            value={config.githubUsername}
            onChange={(e) => updateField("githubUsername", e.target.value)}
            placeholder="e.g. paperclip-bot"
            style={inputStyle}
          />
          <span style={hintStyle}>GitHub machine user account for this agent.</span>
        </label>

        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>Token Secret Ref <span style={{ color: "red" }}>*</span></span>
          <input
            type="text"
            value={config.tokenSecretRef}
            onChange={(e) => updateField("tokenSecretRef", e.target.value)}
            placeholder="e.g. GITHUB_BOT_TOKEN"
            style={inputStyle}
          />
          <span style={hintStyle}>
            Paperclip secret reference that resolves to the bot&apos;s GitHub token.
            Must be a bot account credential — not a personal token.
          </span>
        </label>

        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>Allowed Owner Pattern</span>
          <input
            type="text"
            value={config.allowedOwnerPattern}
            onChange={(e) => updateField("allowedOwnerPattern", e.target.value)}
            placeholder="^roshangautam$"
            style={inputStyle}
          />
          <span style={hintStyle}>
            Regex pattern for allowed GitHub repository owners. Defaults to <code>^roshangautam$</code>.
            The bot will only operate on repos matching this pattern.
          </span>
        </label>
      </fieldset>

      <fieldset style={{ border: "1px solid #ddd", borderRadius: 4, padding: "1rem", display: "grid", gap: "0.75rem" }}>
        <legend style={{ fontWeight: 600 }}>Commit Identity (optional)</legend>

        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>Commit Name</span>
          <input
            type="text"
            value={config.commitName ?? ""}
            onChange={(e) => updateField("commitName", e.target.value)}
            placeholder="e.g. Paperclip Bot"
            style={inputStyle}
          />
          <span style={hintStyle}>Git author/committer name. Falls back to the GitHub username if empty.</span>
        </label>

        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>Commit Email</span>
          <input
            type="text"
            value={config.commitEmail ?? ""}
            onChange={(e) => updateField("commitEmail", e.target.value)}
            placeholder="e.g. bot@example.com"
            style={inputStyle}
          />
          <span style={hintStyle}>Git author/committer email. Falls back to the GitHub noreply address if empty.</span>
        </label>
      </fieldset>

      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !config.agentId || !config.label || !config.githubUsername || !config.tokenSecretRef}
          style={{
            padding: "0.5rem 1.25rem",
            backgroundColor: "#0d6efd",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: saving ? "wait" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving..." : "Save Configuration"}
        </button>
        {saveSuccess && <span style={{ color: "green" }}>Saved successfully.</span>}
        {saveError && <span style={{ color: "red" }}>{saveError}</span>}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: "0.9rem",
};

const hintStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "#666",
};
