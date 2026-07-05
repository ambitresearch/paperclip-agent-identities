import { toSafeError } from "./redaction.js";

export interface PullRequestInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export interface GitHubPullRequestClient {
  createPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
}

export async function createPullRequest(
  client: GitHubPullRequestClient,
  input: PullRequestInput,
  secrets: readonly string[],
): Promise<PullRequestResult> {
  try {
    return await client.createPullRequest(input);
  } catch (error) {
    throw toSafeError(error, secrets);
  }
}
