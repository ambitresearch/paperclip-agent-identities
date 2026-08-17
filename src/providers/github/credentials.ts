import type { CredentialResolverInput, ResolvedCredential } from "../../core/provider-contract.js";
import { resolveIdentityToken } from "../../credential-sidecar.js";
import type { GitHubAgentIdentity } from "./config.js";

export async function resolveGitHubCredential(
  input: CredentialResolverInput<GitHubAgentIdentity>
): Promise<ResolvedCredential> {
  const { identity, ctx } = input;
  const resolveSecret = (secretRef: string) => ctx.secrets.resolve({
    type: "secret_ref",
    secretId: secretRef,
    version: "latest",
  });
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);

  // `source` is carried through rather than dropped: it is the only trustworthy
  // signal of whether this token is bound to the configured bot identity
  // (`github-app`) or was supplied by an operator and owned by whoever owns it.
  const { token, source } = await resolveIdentityToken(identity, resolveSecret, fetchImpl);

  return { token, secrets: [token], source };
}
