// The Settings-UI-rendering analogue of `settings-index.ts`. Deliberately a
// SEPARATE module for the same reason as settings-index.ts: this is imported
// by the client Settings UI bundle, so it must only depend on per-provider
// `settings-adapter-ui.tsx` modules (client-safe, may import React/JSX), not
// on server-only provider composition (app-manifest.ts's `node:crypto` usage,
// credential resolution touching the filesystem).
//
// Adding a settings-capable provider's UI = add its `settings-adapter-ui.tsx`
// module and append it to ALL_SETTINGS_UI_ADAPTERS here. GitHub does not yet
// have one (its manifest wizard still lives inline in SettingsPage.tsx); see
// the comment near its usage in SettingsPage.tsx for the migration shape.
import { buildProviderSettingsUIRegistry } from "../core/provider-settings-ui-contract.js";
import { slackSettingsUIAdapter } from "./slack/settings-adapter-ui.js";

export const ALL_SETTINGS_UI_ADAPTERS = [slackSettingsUIAdapter] as const;

export const providerSettingsUIRegistry = buildProviderSettingsUIRegistry([...ALL_SETTINGS_UI_ADAPTERS]);
