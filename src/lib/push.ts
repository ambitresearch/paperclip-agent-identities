import { toSafeError, redactSecretsInText } from "./redaction.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

function quoteForSingleQuotedShellLiteral(input: string): string {
  return `'${input.replace(/'/g, `'\"'\"'`)}'`;
}

export async function pushBranch(
  runner: GitRunner,
  input: PushInput,
  secrets: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.PAPERCLIP_GIT_PUSH_TOKEN;
  let askPassDir: string | undefined;
  if (input.token) {
    askPassDir = await mkdtemp(join(tmpdir(), "paperclip-git-askpass-"));
    const askPassPath = join(askPassDir, "askpass.sh");
    const quotedToken = quoteForSingleQuotedShellLiteral(input.token);
    await writeFile(
      askPassPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        '  *Username*) printf "%s\\n" "x-access-token" ;;',
        `  *) printf "%s\\n" ${quotedToken} ;;`,
        "esac",
      ].join("\n"),
      { mode: 0o700 },
    );

    env.GIT_ASKPASS = askPassPath;
    env.GIT_TERMINAL_PROMPT = "0";
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
  } finally {
    if (askPassDir) {
      await rm(askPassDir, { recursive: true, force: true });
    }
  }
}
