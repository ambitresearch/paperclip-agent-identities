import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";

const HUMAN_SETTINGS_ACTOR_REQUIRED = "This settings action requires a human user actor.";

export function requireHumanSettingsActor(
  context: unknown,
): asserts context is PluginPerformActionContext {
  const actor = typeof context === "object" && context !== null
    ? (context as { actor?: unknown }).actor
    : undefined;
  if (
    typeof actor !== "object"
    || actor === null
    || (actor as { type?: unknown }).type !== "user"
  ) {
    throw new Error(HUMAN_SETTINGS_ACTOR_REQUIRED);
  }
}
