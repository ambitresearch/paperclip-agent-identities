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

// The v4 envelope stores public provider metadata plus a secret reference, never
// the token itself. There is no repo/owner/ref field because this provider has no
// addressable resources.
const exampleIdentitySchema = z.object({
  label: z.string().trim().min(1, "label is required"),
  demoTokenSecretId: z.string().trim().min(1, "demoTokenSecretId is required")
});

const exampleConfigEnvelopeSchema = z.object({
  provider: z.literal(EXAMPLE_PROVIDER_ID),
  agentId: z.string().trim().min(1),
  label: z.string().trim().min(1),
  example: z.object({ demoTokenSecretId: z.string().trim().min(1) })
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
  for (const raw of Object.values(identities)) {
    const envelope = exampleConfigEnvelopeSchema.safeParse(raw);
    if (!envelope.success) continue;
    const validated = validateExampleConfig({
      label: envelope.data.label,
      demoTokenSecretId: envelope.data.example.demoTokenSecretId
    });
    if (typeof validated !== "string") {
      projected[envelope.data.agentId] = validated;
    }
  }
  return projected;
}

async function resolveExampleCredential(
  input: CredentialResolverInput<ExampleAgentIdentity>
): Promise<ResolvedCredential> {
  const token = await input.ctx.secrets.resolve(input.identity.identity.demoTokenSecretId);
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
