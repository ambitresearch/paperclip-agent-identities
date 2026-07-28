import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveCredentialSidecarPath } from "../../credential-sidecar.js";
import { requireHumanSettingsActor } from "../../core/settings-action-authorization.js";
import type {
  CreateGitHubAppManifestInput,
  CreateGitHubAppManifestResult,
  ConvertGitHubAppManifestInput,
  ConvertGitHubAppManifestResult,
  GetGitHubAppManifestFlowInput,
  GitHubAppManifestFlowState,
} from "../../shared/types.js";

const GITHUB_APP_MANIFEST_FLOW_STATE_PREFIX = "github-app-manifest-flow:";
const DEFAULT_GITHUB_APP_URL = "https://paperclip.example.com";
const GITHUB_PROVIDER = "github" as const;

/**
 * Permission reconciliation for existing GitHub App installations (DRO-1167).
 *
 * `default_permissions.organization_projects` below is baked into every
 * manifest a *new* App-creation flow generates via
 * `createGitHubAppManifestFlow`. It has NO effect on a GitHub App that was
 * already created and installed before this permission existed on the
 * manifest: GitHub does not retroactively grant permissions to a live App
 * registration just because the code that generates new manifests changed.
 *
 * For each existing installation that wants
 * `github_bot_list_organization_projects` / `github_bot_add_pull_request_to_project`
 * to work, an operator must walk this one-time reconciliation flow:
 *
 * 1. Open the App's settings page on GitHub
 *    (`https://github.com/settings/apps/<app-slug>/permissions`) and add the
 *    "Organization permissions -> Projects" permission, set to
 *    "Read and write", then save. GitHub App permission changes are
 *    NOT self-approving for org-owned installations: this queues a pending
 *    permission-update request rather than applying immediately.
 * 2. The organization's owner/admin (whoever controls the installation, not
 *    necessarily the App's own author) must review and accept the pending
 *    request, either via the email GitHub sends or by visiting
 *    `https://github.com/organizations/<org>/settings/installations/<installation_id>`
 *    and approving the "Review request" banner. Until accepted, the two
 *    Projects tools keep failing GraphQL calls with a permission error even
 *    though the App-level manifest already lists the permission.
 * 3. Once accepted, no token re-minting or reinstall is required -- the next
 *    installation-token mint (already done per-call by the credential
 *    resolver) picks up the expanded scope automatically.
 *
 * There is intentionally no code path here that auto-upgrades an existing
 * installation's permissions: GitHub's API has no endpoint to force-accept a
 * permission-update request on an org's behalf, and doing so silently would
 * bypass the org owner's explicit consent. `create-github-app-manifest`
 * always emits the full desired permission set (including
 * `organization_projects`) so brand-new Apps never need this reconciliation
 * step; only Apps created before this change do.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Required fields: ${field}`);
  }
  return value.trim();
}

function validateSinglePathSegment(value: string, field: string): string {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) {
    throw new Error(`${field} must be a single path segment.`);
  }
  return value;
}

function normalizeGitHubProviderInput(value: unknown): typeof GITHUB_PROVIDER {
  const provider = readString(value);
  if (provider && provider !== GITHUB_PROVIDER) {
    throw new Error("GitHub App manifest flow only supports the GitHub provider.");
  }
  return GITHUB_PROVIDER;
}

function readGitHubProvider(value: unknown): typeof GITHUB_PROVIDER | null {
  return readString(value) === GITHUB_PROVIDER ? GITHUB_PROVIDER : null;
}

function githubAppManifestFlowScope(state: string) {
  return { scopeKind: "instance" as const, stateKey: `${GITHUB_APP_MANIFEST_FLOW_STATE_PREFIX}${state}` };
}

export function createGitHubAppManifestFlow(input: CreateGitHubAppManifestInput): CreateGitHubAppManifestResult {
  const agentId = validateSinglePathSegment(readRequiredString(input.agentId, "agentId"), "agentId");
  const provider = normalizeGitHubProviderInput(input.provider);
  const label = readRequiredString(input.label, "label");
  const callbackUrl = readOptionalUrl(input.callbackUrl, "callbackUrl") ?? DEFAULT_GITHUB_APP_URL;
  const homepageUrl = readOptionalUrl(input.homepageUrl, "homepageUrl") ?? callbackUrl;
  const appName = normalizeGitHubAppName(label);
  const state = `pc_${createHash("sha256").update(`${agentId}:${provider}:${Date.now()}:${randomBytes(16).toString("hex")}`).digest("hex").slice(0, 32)}`;
  const setupUrl = getGitHubAppSetupUrl(callbackUrl, state);
  const manifest = JSON.stringify({
    name: appName,
    description: `Paperclip-managed GitHub App identity provider for ${label}.`,
    url: homepageUrl,
    redirect_url: callbackUrl,
    callback_urls: [callbackUrl],
    setup_url: setupUrl,
    setup_on_update: true,
    request_oauth_on_install: false,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      workflows: "write",
      checks: "read",
      statuses: "read",
      // Organization-level permission (not a repository permission) required
      // for the Projects v2 GraphQL API: listing org Projects
      // (github_bot_list_organization_projects) and adding a pull request as
      // a project item (github_bot_add_pull_request_to_project) both operate
      // on `Organization.projectsV2` / `addProjectV2ItemById`, which GitHub
      // gates on this single "Projects" organization permission regardless of
      // whether the target board is a classic or next-gen (v2) project.
      // "write" is required (not "read") because addProjectV2ItemById is a
      // mutation. See the reconciliation-flow note below for existing
      // installations that predate this permission.
      organization_projects: "write",
    },
    default_events: [],
  });

  return {
    agentId,
    provider,
    state,
    manifest,
    postUrl: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
    setupUrl,
    createdAt: new Date().toISOString(),
    label,
    appName,
  };
}

function normalizeGitHubAppName(label: string): string {
  const base = label.replace(/\[[^\]]*\]/g, "").replace(/[^a-zA-Z0-9 -]/g, " ").replace(/\s+/g, " ").trim();
  const name = base.toLowerCase().includes("paperclip") ? base : `${base} Paperclip Agent`;
  return name.slice(0, 34).replace(/\s+$/g, "") || "Paperclip Agent";
}

export function normalizeGitHubAppManifestFlowState(raw: unknown): GitHubAppManifestFlowState | null {
  if (!isRecord(raw)) return null;
  const agentId = readString(raw.agentId);
  const provider = readGitHubProvider(raw.provider);
  const state = readString(raw.state);
  const manifest = readString(raw.manifest);
  const postUrl = readString(raw.postUrl);
  const setupUrl = readString(raw.setupUrl) || readString(parseManifestSetupUrl(manifest)) || postUrl;
  const createdAt = readString(raw.createdAt);
  const appName = readString(raw.appName) || readString(parseManifestName(manifest));
  const label = readString(raw.label) || appName;
  if (!agentId || !provider || !state || !manifest || !postUrl || !setupUrl || !createdAt || !appName || !label) return null;
  const conversion = normalizeGitHubAppManifestConversionResult(raw.conversion);
  return { agentId, provider, state, manifest, postUrl, setupUrl, createdAt, label, appName, ...(conversion ? { conversion } : {}) };
}

function parseManifestName(manifest: string): unknown {
  try {
    const parsed = JSON.parse(manifest);
    return isRecord(parsed) ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function parseManifestSetupUrl(manifest: string): unknown {
  try {
    const parsed = JSON.parse(manifest);
    return isRecord(parsed) ? parsed.setup_url : undefined;
  } catch {
    return undefined;
  }
}

function getGitHubAppSetupUrl(appUrl: string, state: string): string {
  const url = new URL(appUrl);
  url.searchParams.set("githubAppManifest", "install");
  url.searchParams.set("state", state);
  url.searchParams.delete("code");
  url.searchParams.delete("installation_id");
  url.searchParams.delete("setup_action");
  return url.toString();
}

function normalizeGitHubAppManifestConversionResult(raw: unknown): ConvertGitHubAppManifestResult | null {
  if (!isRecord(raw)) return null;
  const agentId = readString(raw.agentId);
  const provider = readGitHubProvider(raw.provider);
  const appId = readString(raw.appId);
  const appSlug = readString(raw.appSlug);
  const appName = readString(raw.appName);
  const githubUsername = readString(raw.githubUsername);
  const privateKeyFile = readString(raw.privateKeyFile);
  const installUrl = readString(raw.installUrl);
  if (!agentId || !provider || !appId || !appSlug || !appName || !githubUsername || !privateKeyFile || !installUrl) return null;
  return { agentId, provider, appId, appSlug, appName, githubUsername, privateKeyFile, installUrl };
}

async function prepareGitHubAppPrivateKeyFile(flow: GitHubAppManifestFlowState): Promise<string> {
  const agentId = validateSinglePathSegment(readRequiredString(flow.agentId, "agentId"), "agentId");
  const privateKeyFile = join(dirname(await resolveCredentialSidecarPath()), "github-apps", agentId, "private-key.pem");
  const privateKeyDirectory = dirname(privateKeyFile);
  const writeProbe = join(
    privateKeyDirectory,
    `.paperclip-write-test-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    await mkdir(privateKeyDirectory, { recursive: true, mode: 0o700 });
    await assertReplaceablePrivateKeyTarget(privateKeyFile);
    await writeFile(writeProbe, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rm(writeProbe);
  } catch (error) {
    await rm(writeProbe, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to prepare GitHub App private-key destination '${privateKeyFile}': ${message}`, {
      cause: error,
    });
  }
  return privateKeyFile;
}

async function assertReplaceablePrivateKeyTarget(privateKeyFile: string): Promise<void> {
  try {
    const target = await lstat(privateKeyFile);
    if (!target.isFile()) {
      throw new Error(`Existing private-key target '${privateKeyFile}' is not a regular file.`);
    }
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isFileSystemError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string";
}

async function persistGitHubAppManifestConversion(
  flow: GitHubAppManifestFlowState,
  rawConversion: unknown,
  privateKeyFile: string,
): Promise<ConvertGitHubAppManifestResult> {
  if (!isRecord(rawConversion)) {
    throw new Error("GitHub App manifest conversion returned an invalid response.");
  }
  const appId = readString(rawConversion.id) || String(rawConversion.id ?? "").trim();
  const appSlug = readString(rawConversion.slug);
  const appName = readString(rawConversion.name);
  const pem = readString(rawConversion.pem);
  if (!appId || !appSlug || !appName || !pem) {
    throw new Error("GitHub App manifest conversion response is missing id, slug, name, or pem.");
  }

  const agentId = validateSinglePathSegment(readRequiredString(flow.agentId, "agentId"), "agentId");
  await writePrivateKeyFile(privateKeyFile, pem.endsWith("\n") ? pem : `${pem}\n`);

  return {
    agentId,
    provider: flow.provider,
    appId,
    appSlug,
    appName,
    githubUsername: `${appSlug}[bot]`,
    privateKeyFile,
    installUrl: `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(flow.state)}`,
  };
}

async function writePrivateKeyFile(privateKeyFile: string, contents: string): Promise<void> {
  const tempPath = `${privateKeyFile}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempPath, privateKeyFile);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function readOptionalUrl(value: unknown, field: string): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("URL must use http or https");
    }
    return parsed.toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${field} must be a valid URL: ${message}`);
  }
}

export function contributeGitHubAppManifestActions(ctx: PluginContext): void {
  ctx.actions.register("create-github-app-manifest", async (params, context) => {
    requireHumanSettingsActor(context);
    const result = createGitHubAppManifestFlow(params as CreateGitHubAppManifestInput);
    await ctx.state.set(githubAppManifestFlowScope(result.state), result);
    ctx.logger.info("GitHub App manifest flow created", { agentId: result.agentId, appName: result.appName });
    return result;
  });

  ctx.actions.register("get-github-app-manifest-flow", async (params, context) => {
    requireHumanSettingsActor(context);
    const input = params as GetGitHubAppManifestFlowInput;
    const state = readRequiredString(input.state, "state");
    const flow = normalizeGitHubAppManifestFlowState(await ctx.state.get(githubAppManifestFlowScope(state)));
    if (!flow || flow.state !== state) {
      throw new Error("Unknown or expired GitHub App manifest flow state.");
    }
    if (input.consume === true && flow.conversion) {
      await ctx.state.delete(githubAppManifestFlowScope(state));
    }
    return flow;
  });

  ctx.actions.register("convert-github-app-manifest", async (params, context) => {
    requireHumanSettingsActor(context);
    const input = params as ConvertGitHubAppManifestInput;
    const state = readRequiredString(input.state, "state");
    const code = readRequiredString(input.code, "code");
    const flow = normalizeGitHubAppManifestFlowState(await ctx.state.get(githubAppManifestFlowScope(state)));
    if (!flow || flow.state !== state) {
      throw new Error("Unknown or expired GitHub App manifest flow state.");
    }
    if (flow.conversion) return flow.conversion;

    // GitHub manifest codes are single-use. Prepare the local destination first
    // so a path/configuration failure cannot consume a code before persistence.
    const privateKeyFile = await prepareGitHubAppPrivateKeyFile(flow);
    const response = await ctx.http.fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "paperclip-agent-identities/github-app-manifest",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub App manifest conversion failed: ${response.status} ${await response.text()}`);
    }

    const conversion = await response.json();
    const converted = await persistGitHubAppManifestConversion(flow, conversion, privateKeyFile);
    await ctx.state.set(githubAppManifestFlowScope(flow.state), { ...flow, conversion: converted });
    ctx.logger.info("GitHub App manifest converted", { agentId: converted.agentId, appId: converted.appId, appSlug: converted.appSlug });
    return converted;
  });
}
