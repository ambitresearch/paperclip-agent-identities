import type { PluginContext } from "@paperclipai/plugin-sdk";
import { redactSecretText } from "./tools/push-branch.js";

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
    // Some fetch implementations embed request details (including the
    // Authorization header) in thrown-error text. Redact the token before it
    // can leak into logs/tool output.
    return { ok: false, error: redactSecretText(`GitHub GraphQL request failed before a response was received: ${reason}`, [token]) };
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    return { ok: false, error: redactSecretText(`GitHub GraphQL API returned ${response.status}. ${details}`.trim(), [token]) };
  }

  const body = (await response.json()) as { data?: T; errors?: GitHubGraphQLErrorPayload[] };
  if (body.errors && body.errors.length > 0) {
    return { ok: false, error: redactSecretText(body.errors.map((e) => e.message).join("; "), [token]) };
  }
  if (body.data === undefined) {
    return { ok: false, error: "GitHub GraphQL API returned no data." };
  }
  return { ok: true, data: body.data };
}

interface ReviewThreadRepositoryData {
  node: {
    __typename?: string;
    repository?: {
      owner: { login: string };
      name: string;
    };
  } | null;
}

const REVIEW_THREAD_REPOSITORY_QUERY = `
query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      repository {
        owner { login }
        name
      }
    }
  }
}`;

/**
 * Review-thread global node IDs are not scoped to a repository by
 * construction -- GitHub will happily resolve/unresolve any thread ID a
 * caller passes, regardless of the `repository` parameter the tool was
 * invoked with. Look up which repository the thread actually belongs to and
 * compare it against the requested repository before allowing the mutation,
 * so a thread ID from one repo can't be used to mutate state associated with
 * (and logged/attributed to) a different repo the caller specified.
 */
export async function verifyReviewThreadBelongsToRepository(
  ctx: PluginContext,
  token: string,
  threadId: string,
  expected: { owner: string; repo: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await executeGitHubGraphQL<ReviewThreadRepositoryData>(
    ctx,
    token,
    REVIEW_THREAD_REPOSITORY_QUERY,
    { threadId }
  );
  if (!result.ok) {
    return { ok: false, error: `Failed to verify review thread repository: ${result.error}` };
  }
  const repository = result.data.node?.repository;
  if (!repository) {
    return { ok: false, error: "Review thread not found or is not a pull request review thread." };
  }
  if (
    repository.owner.login.toLowerCase() !== expected.owner.toLowerCase() ||
    repository.name.toLowerCase() !== expected.repo.toLowerCase()
  ) {
    return {
      ok: false,
      error:
        `Review thread belongs to '${repository.owner.login}/${repository.name}', ` +
        `not the requested repository '${expected.owner}/${expected.repo}'.`
    };
  }
  return { ok: true };
}
