import type { SlackAgentIdentity } from "../config.js";

// Routes an inbound Slack event to exactly one Paperclip agent, per
// openwiki/domain/slack-provider-design.md's DRO-1005 acceptance criteria:
// "Route by app ID plus team ID to exactly one agent; ambiguity fails
// closed." Both fields must match — matching only one is not sufficient,
// since a single Slack app can (in a later multi-workspace world) install
// into more than one team, and a single team could theoretically have more
// than one configured agent identity today if an operator misconfigures one.

export interface SlackEventRouteKey {
  readonly appId: string;
  readonly teamId: string;
}

export type SlackEventRouteResult =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly error: string };

export function routeSlackEventToAgent(
  identities: Record<string, SlackAgentIdentity>,
  key: SlackEventRouteKey
): SlackEventRouteResult {
  const appId = key.appId.trim();
  const teamId = key.teamId.trim();

  if (!appId || !teamId) {
    return { ok: false, error: "Cannot route a Slack event without both appId and teamId" };
  }

  const matches = Object.entries(identities).filter(
    ([, identity]) => identity.appId === appId && identity.teamId === teamId
  );

  if (matches.length === 0) {
    return { ok: false, error: `No agent identity configured for Slack app '${appId}' in team '${teamId}'` };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `Ambiguous Slack routing: multiple agent identities match app '${appId}' team '${teamId}' ` +
        `(${matches.map(([agentId]) => agentId).join(", ")})`,
    };
  }

  const [agentId] = matches[0];
  return { ok: true, agentId };
}
