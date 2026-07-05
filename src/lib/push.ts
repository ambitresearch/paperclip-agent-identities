import { toSafeError, redactSecretsInText } from "./redaction.js";

export interface PushInput {
  remote: string;
  branch: string;
  token?: string;
}

export interface PushRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv }): Promise<PushRunResult>;
}

export async function pushBranch(
  runner: GitRunner,
  input: PushInput,
  secrets: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (input.token) {
    env.GITHUB_TOKEN = input.token;
  }

  try {
    const result = await runner.run("git", ["push", input.remote, `HEAD:${input.branch}`], { env });

    if (result.code !== 0) {
      throw new Error(`git push failed: ${result.stderr}`);
    }

    return {
      stdout: redactSecretsInText(result.stdout, secrets),
      stderr: redactSecretsInText(result.stderr, secrets),
    };
  } catch (error) {
    throw toSafeError(error, secrets);
  }
}
