import { z } from "@paperclipai/plugin-sdk";
import type {
  CredentialResolverInput,
  IdentityProvider,
  IdentityProviderDefinition,
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResolvedCredential
} from "../../core/provider-contract.js";
import type { ResourceReference } from "../../core/resource-reference.js";

// The example provider is a deliberately trivial, NON-git reference adapter.
// It exists to prove the IdentityProvider contract is about capability
// contribution — not secretly shaped around GitHub/git. See spec §11 and §13.
export const EXAMPLE_PROVIDER_ID = "example";

// Config sub-object shape: `example: { label, demoToken }`. There is NO
// repo/owner/ref field — the provider has no addressable resources. `demoToken`
// stands in for "a static token sourced from a secret" without dragging in file
// IO; a real provider would resolve this from a tokenFile or the plugin secret
// store inside `resolveCredential`.
const exampleIdentitySchema = z.object({
  label: z.string().trim().min(1, "label is required"),
  demoToken: z.string().trim().min(1, "demoToken is required")
});

export type ExampleAgentIdentity = z.infer<typeof exampleIdentitySchema>;

export function validateExampleConfig(raw: unknown): ExampleAgentIdentity | string {
  const parsed = exampleIdentitySchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
  }
  return parsed.data;
}

export function projectExamplePluginConfig(
  identities: Record<string, unknown>
): Record<string, ExampleAgentIdentity> {
  const projected: Record<string, ExampleAgentIdentity> = {};
  for (const [agentId, raw] of Object.entries(identities)) {
    const validated = validateExampleConfig(raw);
    if (typeof validated !== "string") {
      projected[agentId] = validated;
    }
  }
  return projected;
}

async function resolveExampleCredential(
  input: CredentialResolverInput<ExampleAgentIdentity>
): Promise<ResolvedCredential> {
  // A real provider would read a tokenFile or call the plugin secret store.
  // `input.identity` is the RESOLVED wrapper, so the config fields live one
  // level deeper at `input.identity.identity.<field>`.
  const token = input.identity.identity.demoToken;
  return { token, secrets: [token] };
}

const exampleWhoamiToolMetadata = {
  displayName: "Example: Who am I?",
  description: "Returns the configured example identity label and confirms a credential resolved.",
  parametersSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
} as const;

// The single capability the stub contributes. It requires a credential (default
// `requiresCredential`) so the pipeline's credential step is exercised for a
// non-git provider, but it NEVER returns the raw token — only a boolean. It has
// NO `resolveResourceRef`, which is exactly what proves the resource-ref step is
// optional and not git-shaped.
export const exampleWhoamiToolSpec: ProviderToolSpec<ExampleAgentIdentity, ResourceReference> = {
  name: "example_whoami",
  metadata: exampleWhoamiToolMetadata,
  validateParams(_raw: unknown): ParamsValidation {
    return { ok: true, params: {} };
  },
  async perform(
    execution: ProviderToolExecution<ExampleAgentIdentity, ResourceReference>
  ): Promise<unknown> {
    const identity = execution.identity.identity;
    return {
      content: `Configured example identity: ${identity.label}.`,
      data: {
        label: identity.label,
        // Booleans only — never the token value itself (security invariant).
        tokenResolved: execution.token !== null
      }
    };
  }
};

// A real manifest fragment even though the provider is coming-soon. This keeps
// the stub a COMPLETE template (flip `status` to "enabled" and it wires up
// end-to-end) and makes Task 14's registry test prove the `.enabled()` FILTER —
// not an empty array — is what excludes coming-soon providers.
export const exampleWhoamiManifestTool = {
  name: exampleWhoamiToolSpec.name,
  ...exampleWhoamiToolMetadata
} as const;

const exampleProviderDefinition: IdentityProviderDefinition = {
  id: EXAMPLE_PROVIDER_ID,
  name: "Example (reference stub)",
  status: "coming-soon",
  description:
    "A non-git reference adapter that demonstrates how to add an identity provider. Not enabled at runtime."
};

export const exampleProvider: IdentityProvider<ExampleAgentIdentity, ResourceReference> = {
  id: EXAMPLE_PROVIDER_ID,
  definition: exampleProviderDefinition,
  validateConfig: validateExampleConfig,
  projectPluginConfig: projectExamplePluginConfig,
  resolveCredential: resolveExampleCredential,
  tools: [exampleWhoamiToolSpec],
  manifestTools: [exampleWhoamiManifestTool]
};
