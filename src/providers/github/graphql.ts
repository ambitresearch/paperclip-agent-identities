import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface GitHubGraphQLErrorPayload {
  readonly message: string;
  readonly type?: string;
  readonly path?: ReadonlyArray<string | number>;
}

export interface GitHubGraphQLResult<T> {
  readonly ok: true;
  readonly data: T;
}

export interface GitHubGraphQLFailure {
  readonly ok: false;
  readonly error: string;
}

/**
 * Minimal GitHub GraphQL v4 client shared by the Projects v2 tools
 * (organization Projects listing + adding a pull request to a project).
 * REST doesn't expose Projects v2 at all -- it's GraphQL-only -- so this is
 * the one seam both tools call through rather than each hand-rolling fetch +
 * error handling.
 */
export async function executeGitHubGraphQL<T>(
  ctx: PluginContext,
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<GitHubGraphQLResult<T> | GitHubGraphQLFailure> {
  let response: Response;
  try {
    response = await ctx.http.fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "paperclip-agent-identities/github-api",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown network error";
    return { ok: false, error: `GitHub GraphQL request failed before a response was received: ${reason}` };
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    return { ok: false, error: `GitHub GraphQL API returned ${response.status}. ${details}`.trim() };
  }

  const body = (await response.json()) as { data?: T; errors?: GitHubGraphQLErrorPayload[] };
  if (body.errors && body.errors.length > 0) {
    return { ok: false, error: body.errors.map((e) => e.message).join("; ") };
  }
  if (body.data === undefined) {
    return { ok: false, error: "GitHub GraphQL API returned no data." };
  }
  return { ok: true, data: body.data };
}
