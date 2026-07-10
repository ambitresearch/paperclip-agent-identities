export interface ResourceReference {
  readonly kind: string;
}

export function isResourceReference(value: unknown): value is ResourceReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}
