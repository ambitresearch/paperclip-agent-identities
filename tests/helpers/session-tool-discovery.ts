/**
 * DRO-1163 / paperclipai/paperclip#10346
 *
 * A minimal, repo-owned model of the ONE fact the incident hinged on: an
 * agent session only sees this plugin's manifest tools through the managed
 * MCP gateway if the adapter actually attached that gateway server. Global
 * plugin manifest registration is a completely independent signal from
 * per-session tool discovery -- the incident was global registration
 * succeeding while per-session attachment silently did not happen.
 *
 * This is NOT a stand-in for Paperclip core's real adapter/runtime-MCP
 * attachment path (that lives upstream, tracked at
 * paperclipai/paperclip#10346 and paperclipai/paperclip#10144, and requires
 * a running core instance + real MCP client/server to verify end-to-end).
 * What it DOES let this repo verify, without a live core instance, is that
 * "tools are globally registered" and "tools are exposed in a given
 * session" are computed from genuinely different inputs and can disagree --
 * i.e. a green manifest-registration check can never be mistaken for proof
 * of session-level availability, because this harness makes the two calls
 * structurally distinct and requires an explicit gateway-attachment signal
 * before any tool is considered session-discoverable.
 */

export interface ManifestToolLike {
  readonly name: string;
}

/**
 * Mirrors the shape of the per-run attachment signal Paperclip core is
 * responsible for producing: a non-empty `ctx.runtimeMcp` descriptor plus an
 * adapter that actually attaches to it. Both must independently be truthy,
 * matching the incident where credentials existed but no session attached.
 */
export interface SessionGatewayAttachment {
  /** Whether `ctx.runtimeMcp` was non-empty for this heartbeat/run. */
  readonly runtimeMcpPresent: boolean;
  /** Whether the adapter actually attached the gateway MCP server. */
  readonly gatewayAttached: boolean;
}

/**
 * Simulates what an agent session can discover via `list_tools` against the
 * managed MCP gateway, given the plugin's globally registered manifest tools
 * and a session's gateway-attachment state.
 *
 * Discovery only ever returns a non-empty set when BOTH attachment signals
 * are true -- registration alone (`manifestTools`) never leaks through. This
 * is what makes "registered" and "discoverable" independently falsifiable
 * within this repo, instead of the previous suite's single hard-coded string
 * assertion.
 */
export function simulateSessionToolDiscovery(
  manifestTools: ReadonlyArray<ManifestToolLike>,
  attachment: SessionGatewayAttachment,
): string[] {
  if (!attachment.runtimeMcpPresent || !attachment.gatewayAttached) {
    return [];
  }
  return manifestTools.map((tool) => tool.name);
}
