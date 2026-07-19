import "@paperclipai/plugin-sdk";

declare module "@paperclipai/plugin-sdk" {
  interface PluginConfigClient {
    get(companyId?: string): Promise<Record<string, unknown>>;
    patchSecretRefs(input: {
      companyId?: string;
      path: string[];
      value: Record<string, unknown> | null;
    }): Promise<void>;
  }

  interface PluginSecretsClient {
    resolve(
      secretRef: string | { type: "secret_ref"; secretId: string; version?: "latest" },
      options?: { companyId?: string; configPath?: string },
    ): Promise<string>;
  }

  interface PluginWebhookInput {
    /** Host-authorized company scope derived from the bound webhook route. */
    companyId?: string;
  }
}
