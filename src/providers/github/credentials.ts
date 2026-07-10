import type { CredentialResolverInput, ResolvedCredential } from "../../core/provider-contract.js";
import { resolveIdentityToken } from "../../credential-sidecar.js";
import type { GitHubAgentIdentity } from "./config.js";

export async function resolveGitHubCredential(
  input: CredentialResolverInput<GitHubAgentIdentity>
): Promise<ResolvedCredential> {
  const { identity, ctx } = input;
  const resolveSecret = (secretRef: string) => ctx.secrets.resolve(secretRef);
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);

  const { token } = await resolveIdentityToken(identity, resolveSecret, fetchImpl);

  return { token, secrets: [token] };
}
