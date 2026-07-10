import { describe, expect, it } from "vitest";
import {
  getProvider,
  hasProvider,
  listProviders,
  registerProvider,
  type ProviderAdapter
} from "../src/providers/registry.js";
import { SUPPORTED_IDENTITY_PROVIDERS } from "../src/shared/types.js";

describe("provider registry", () => {
  it("seeds every supported identity provider at import time", () => {
    for (const definition of SUPPORTED_IDENTITY_PROVIDERS) {
      expect(hasProvider(definition.id)).toBe(true);
      const adapter = getProvider(definition.id);
      expect(adapter.id).toBe(definition.id);
      expect(adapter.definition).toEqual(definition);
    }
  });

  it("lists all registered providers", () => {
    const listed = listProviders();
    expect(listed.length).toBeGreaterThanOrEqual(SUPPORTED_IDENTITY_PROVIDERS.length);
    const ids = listed.map((adapter) => adapter.id);
    for (const definition of SUPPORTED_IDENTITY_PROVIDERS) {
      expect(ids).toContain(definition.id);
    }
  });

  it("throws when looking up an unknown provider id", () => {
    expect(() => getProvider("unknown-provider" as never)).toThrow(/unknown provider/i);
  });

  it("hasProvider returns false for an unknown provider id", () => {
    expect(hasProvider("unknown-provider" as never)).toBe(false);
  });

  it("throws when registering a duplicate provider id", () => {
    const duplicate: ProviderAdapter = {
      id: "github",
      definition: {
        id: "github",
        name: "GitHub (duplicate)",
        description: "duplicate",
        status: "enabled"
      }
    };
    expect(() => registerProvider(duplicate)).toThrow(/already registered/i);
  });

  it("allows registering and retrieving a brand new provider id", () => {
    const custom: ProviderAdapter = {
      id: "custom-test-provider" as never,
      definition: {
        id: "custom-test-provider" as never,
        name: "Custom Test Provider",
        description: "test-only provider adapter",
        status: "coming-soon"
      }
    };
    registerProvider(custom);
    expect(hasProvider(custom.id)).toBe(true);
    expect(getProvider(custom.id)).toEqual(custom);
  });
});
