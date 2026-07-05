function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecretsInText(input: string, secrets: readonly string[]): string {
  let output = input;

  for (const secret of secrets) {
    if (!secret) {
      continue;
    }

    const pattern = new RegExp(escapeRegex(secret), "g");
    output = output.replace(pattern, "[REDACTED]");
  }

  return output;
}

export function redactSecrets<T>(input: T, secrets: readonly string[]): T {
  if (typeof input === "string") {
    return redactSecretsInText(input, secrets) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item, secrets)) as T;
  }

  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>).map(([key, value]) => [
      key,
      redactSecrets(value, secrets),
    ]);
    return Object.fromEntries(entries) as T;
  }

  return input;
}

export function toSafeError(error: unknown, secrets: readonly string[]): Error {
  if (error instanceof Error) {
    return new Error(redactSecretsInText(error.message, secrets));
  }

  if (typeof error === "string") {
    return new Error(redactSecretsInText(error, secrets));
  }

  return new Error("Unknown error");
}
