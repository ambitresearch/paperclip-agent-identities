// src/providers/settings-index.ts
//
// The Settings-UI analogue of src/providers/index.ts. Deliberately a SEPARATE
// module (not added to providers/index.ts) because that file imports the
// concrete `IdentityProvider` implementations (githubProvider, slackProvider,
// ...), which pull in server-only code (e.g. app-manifest.ts's `node:crypto`
// usage, credential resolution touching the filesystem). This file is
// imported by the client-side Settings UI bundle
// (src/ui/SettingsPage.tsx -> this file), so it must only depend on the
// per-provider `settings-adapter.ts` modules, which are themselves UI-safe.
//
// Adding a settings-capable provider = add its `settings-adapter.ts` module
// and append it to ALL_SETTINGS_ADAPTERS here.
import { githubSettingsAdapter } from "./github/settings-adapter.js";
import { slackSettingsAdapter } from "./slack/settings-adapter.js";

export const ALL_SETTINGS_ADAPTERS = [githubSettingsAdapter, slackSettingsAdapter] as const;
