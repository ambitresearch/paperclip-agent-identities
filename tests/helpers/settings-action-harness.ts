import { createTestHarness as createSdkTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { TestHarnessOptions, TestHarnessPerformActionOptions } from "@paperclipai/plugin-sdk/testing";

const HUMAN_SETTINGS_ACTIONS = new Set([
  "save-bot-identity-config",
  "delete-bot-identity-config",
  "create-github-app-manifest",
  "get-github-app-manifest-flow",
  "convert-github-app-manifest",
  "create-slack-app-manifest",
  "get-slack-app-manifest-flow",
  "discover-slack-install-metadata",
  "save-slack-install-metadata",
  "rebind-legacy-slack-credentials",
]);

const LOCAL_USER_ACTOR = { type: "user" as const, userId: null };

export function createSettingsActionTestHarness(options: TestHarnessOptions) {
  const harness = createSdkTestHarness(options);
  const performAction = harness.performAction.bind(harness);

  harness.performAction = <T = unknown>(
    key: string,
    params?: Record<string, unknown>,
    actionOptions?: TestHarnessPerformActionOptions,
  ): Promise<T> => performAction<T>(
    key,
    params,
    HUMAN_SETTINGS_ACTIONS.has(key) && actionOptions?.actor === undefined
      ? { ...actionOptions, actor: LOCAL_USER_ACTOR }
      : actionOptions,
  );

  return harness;
}
