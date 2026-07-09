import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { BotIdentitySettingsData, BotIdentitySettingsEntry } from "../shared/types.js";

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<BotIdentitySettingsData>("bot-identity-config");

  if (loading) return <div>Loading agent identities...</div>;
  if (error) return <div>Agent identities unavailable: {error.message}</div>;

  const identities = data?.identities ?? [];
  const summary = summarizeIdentities(identities, Boolean(data?.credentialSidecarError));

  return (
    <div style={widgetStyle}>
      <div>
        <strong>Agent Identities</strong>
        <div style={mutedStyle}>Identity provider coverage</div>
      </div>

      <div style={metricGridStyle}>
        <Metric label="Identities" value={summary.total} tone="neutral" />
        <Metric label="GitHub Apps" value={summary.githubApps} tone={summary.githubApps > 0 ? "good" : "neutral"} />
        <Metric label="Need setup" value={summary.needsSetup} tone={summary.needsSetup > 0 ? "warn" : "good"} />
      </div>

      {data?.credentialSidecarError ? (
        <div style={warningStyle}>Credential sidecar unavailable. Saves may not update private key references.</div>
      ) : identities.length === 0 ? (
        <div style={hintBoxStyle}>No agent identities configured yet. Open plugin settings to add a provider-backed agent identity.</div>
      ) : (
        <div style={identityListStyle}>
          {identities.slice(0, 3).map((identity) => (
            <div key={identity.id} style={identityRowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={identityNameStyle}>{identity.label}</div>
                <div style={mutedStyle}>{formatProviderIdentity(identity)}</div>
              </div>
              <span style={badgeStyle(identityTone(identity))}>{formatIdentityCredential(identity)}</span>
            </div>
          ))}
          {identities.length > 3 && <div style={mutedStyle}>+{identities.length - 3} more configured</div>}
        </div>
      )}
    </div>
  );
}

export { SettingsPage } from "./SettingsPage.js";

function summarizeIdentities(identities: BotIdentitySettingsEntry[], sidecarUnavailable: boolean) {
  const githubApps = identities.filter((identity) => hasCompleteGitHubApp(identity)).length;
  const configuredFallbacks = identities.filter((identity) => !hasCompleteGitHubApp(identity) && hasFallbackCredential(identity)).length;
  return {
    total: identities.length,
    githubApps,
    configuredFallbacks,
    needsSetup: sidecarUnavailable ? identities.length : identities.length - githubApps - configuredFallbacks,
  };
}

function hasCompleteGitHubApp(identity: BotIdentitySettingsEntry): boolean {
  const githubApp = identity.credential?.githubApp;
  return Boolean(githubApp?.appId && githubApp.installationId && (githubApp.privateKeySecretId || githubApp.privateKeyFile));
}

function hasFallbackCredential(identity: BotIdentitySettingsEntry): boolean {
  return Boolean(identity.credential?.secretId || identity.credential?.tokenFile);
}

function formatProviderIdentity(identity: BotIdentitySettingsEntry): string {
  const provider = identity.provider === "github" ? "GitHub" : identity.provider;
  return `${provider}: ${identity.githubUsername}`;
}

function formatIdentityCredential(identity: BotIdentitySettingsEntry): string {
  if (hasCompleteGitHubApp(identity)) return "GitHub App";
  if (hasFallbackCredential(identity)) return "Fallback";
  if (identity.credentialStatus === "sidecar-unavailable") return "Unavailable";
  return "Missing";
}

function identityTone(identity: BotIdentitySettingsEntry): MetricTone {
  if (hasCompleteGitHubApp(identity)) return "good";
  if (hasFallbackCredential(identity)) return "neutral";
  return "warn";
}

type MetricTone = "good" | "neutral" | "warn";

function Metric(props: { label: string; value: number; tone: MetricTone }) {
  return (
    <div style={metricStyle(props.tone)}>
      <div style={metricValueStyle}>{props.value}</div>
      <div style={metricLabelStyle}>{props.label}</div>
    </div>
  );
}

const widgetStyle = {
  display: "grid",
  gap: "0.75rem",
} as const;

const mutedStyle = {
  color: "GrayText",
  fontSize: "0.85rem",
  overflowWrap: "anywhere",
} as const;

const metricGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: "0.5rem",
} as const;

function metricStyle(tone: MetricTone) {
  return {
    border: `1px solid ${toneColor(tone)}`,
    borderRadius: 8,
    padding: "0.6rem",
    background: toneBackground(tone),
  } as const;
}

const metricValueStyle = {
  fontSize: "1.35rem",
  fontWeight: 700,
  lineHeight: 1,
} as const;

const metricLabelStyle = {
  color: "GrayText",
  fontSize: "0.75rem",
  marginTop: "0.25rem",
} as const;

const identityListStyle = {
  display: "grid",
  gap: "0.45rem",
} as const;

const identityRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.75rem",
} as const;

const identityNameStyle = {
  fontWeight: 600,
  overflowWrap: "anywhere",
} as const;

function badgeStyle(tone: MetricTone) {
  return {
    border: `1px solid ${toneColor(tone)}`,
    borderRadius: 999,
    padding: "0.15rem 0.5rem",
    color: toneColor(tone),
    fontSize: "0.75rem",
    whiteSpace: "nowrap",
  } as const;
}

const hintBoxStyle = {
  border: "1px dashed GrayText",
  borderRadius: 8,
  padding: "0.65rem",
  color: "GrayText",
  fontSize: "0.9rem",
} as const;

const warningStyle = {
  border: "1px solid rgba(255, 193, 7, 0.75)",
  borderRadius: 8,
  padding: "0.65rem",
  color: "#ffc107",
  background: "rgba(255, 193, 7, 0.12)",
  fontSize: "0.9rem",
} as const;

function toneColor(tone: MetricTone): string {
  if (tone === "good") return "#4ade80";
  if (tone === "warn") return "#fbbf24";
  return "GrayText";
}

function toneBackground(tone: MetricTone): string {
  if (tone === "good") return "rgba(74, 222, 128, 0.10)";
  if (tone === "warn") return "rgba(251, 191, 36, 0.12)";
  return "rgba(128, 128, 128, 0.08)";
}
