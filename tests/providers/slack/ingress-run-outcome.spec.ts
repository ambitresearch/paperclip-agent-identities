import { describe, it, expect } from "vitest";
import {
  GATEWAY_ATTACHMENT_EVENT,
  PLAN_ONLY_CLASSIFICATION,
  SlackRunEvidenceTracker,
  isAcknowledgmentOnlyReply,
} from "../../../src/providers/slack/ingress/run-outcome.js";

/**
 * DRO-1258 regressions.
 *
 * A Slack action request could end as a clean success while nothing was
 * actually done. These cover the two false-positive signals directly, plus
 * the positive control that genuine action evidence still completes.
 */
describe("Slack run action evidence (DRO-1258)", () => {
  const track = (records: ReadonlyArray<Record<string, unknown>>) => {
    const tracker = new SlackRunEvidenceTracker();
    for (const record of records) tracker.observeRecord(record);
    return tracker;
  };

  describe("acknowledgment-only replies", () => {
    it("does not treat a reply that only promises future work as success", () => {
      const tracker = track([
        { type: GATEWAY_ATTACHMENT_EVENT },
        { type: "result", result: "Sure thing, I'll post that to the channel shortly." },
      ]);

      expect(tracker.classify("Sure thing, I'll post that to the channel shortly.")).toBe(
        "acknowledgment_only",
      );
      expect(tracker.evidence().durableAction).toBe(false);
    });

    it.each([
      "On it!",
      "Got it, I'll take care of it.",
      "Let me check that for you.",
      "Will do. Give me a second.",
      "I'm on it, standing by.",
      "Acknowledged.",
    ])("classifies %j as acknowledgment-only", (reply) => {
      expect(isAcknowledgmentOnlyReply(reply)).toBe(true);
      expect(new SlackRunEvidenceTracker().classify(reply)).toBe("acknowledgment_only");
    });

    it("does not misclassify a substantive answer that also promises a follow-up", () => {
      const reply = [
        "The deploy failed because the migration lock was still held:",
        "- lock owner: worker-3",
        "- held since 14:02 UTC",
        "I'll file a follow-up to add a lock timeout.",
      ].join("\n");

      expect(isAcknowledgmentOnlyReply(reply)).toBe(false);
      expect(new SlackRunEvidenceTracker().classify(reply)).toBe("acted");
    });

    it("does not classify a past-tense action report as a promise", () => {
      const reply = "I posted the summary to #ops and assigned the issue to you.";
      expect(isAcknowledgmentOnlyReply(reply)).toBe(false);
      expect(new SlackRunEvidenceTracker().classify(reply)).toBe("acted");
    });
  });

  describe("tool_gateway.session_created is attachment telemetry, not progress", () => {
    it("alone does not satisfy liveness progress", () => {
      const tracker = track([
        { type: GATEWAY_ATTACHMENT_EVENT },
        { type: GATEWAY_ATTACHMENT_EVENT },
      ]);

      const evidence = tracker.evidence();
      expect(evidence.gatewayAttached).toBe(true);
      expect(evidence.durableAction).toBe(false);
      expect(tracker.classify("I'll get started on that now.")).toBe("acknowledgment_only");
    });

    it("is recognized when carried as an `event` field rather than `type`", () => {
      const tracker = track([{ event: GATEWAY_ATTACHMENT_EVENT }]);
      expect(tracker.evidence().gatewayAttached).toBe(true);
      expect(tracker.evidence().durableAction).toBe(false);
    });

    it("never resets progress already established by a real tool invocation", () => {
      const tracker = track([
        { type: "acpx.tool_call", name: "github_bot_add_issue_comment" },
        { type: GATEWAY_ATTACHMENT_EVENT },
      ]);

      expect(tracker.evidence().durableAction).toBe(true);
      expect(tracker.classify("On it!")).toBe("acted");
    });
  });

  describe("plan_only is never terminal success", () => {
    it("does not record a plan_only invocation as successful", () => {
      const tracker = track([
        {
          type: "invocation.completed",
          classification: PLAN_ONLY_CLASSIFICATION,
          result: "Here is the plan for renaming the channel.",
        },
      ]);

      expect(tracker.evidence().planOnly).toBe(true);
      expect(tracker.classify("Here is the plan for renaming the channel.")).toBe("plan_only");
    });

    it("outranks incidental tool use performed while planning", () => {
      const tracker = track([
        { type: "acpx.tool_call", name: "grep" },
        { type: "result", result: "Plan drafted.", terminalClassification: PLAN_ONLY_CLASSIFICATION },
      ]);

      expect(tracker.evidence().durableAction).toBe(true);
      expect(tracker.classify("Plan drafted.")).toBe("plan_only");
    });

    it("reads the classification from any of the terminal record shapes", () => {
      for (const key of ["classification", "terminalClassification", "outcome"]) {
        const tracker = track([{ type: "result", [key]: PLAN_ONLY_CLASSIFICATION }]);
        expect(tracker.classify("anything")).toBe("plan_only");
      }
    });

    it("leaves a non-plan_only classification as a normal outcome", () => {
      const tracker = track([
        { type: "acpx.tool_call", name: "slack_bot_post_message" },
        { type: "result", classification: "executed", result: "Posted." },
      ]);
      expect(tracker.classify("Posted.")).toBe("acted");
    });
  });

  describe("positive control: genuine action evidence completes", () => {
    it("counts a gateway session followed by a real tool invocation as progress", () => {
      const tracker = track([
        { type: GATEWAY_ATTACHMENT_EVENT },
        { type: "acpx.tool_call", name: "slack_bot_post_message" },
        { type: "result", result: "Posted the release notes to #general." },
      ]);

      const evidence = tracker.evidence();
      expect(evidence.gatewayAttached).toBe(true);
      expect(evidence.durableAction).toBe(true);
      expect(evidence.planOnly).toBe(false);
      expect(tracker.classify("Posted the release notes to #general.")).toBe("acted");
    });

    it.each([
      { type: "tool_use", name: "github_bot_create_pull_request" },
      { type: "item.completed", item: { type: "command_execution", command: "pnpm test" } },
      { type: "item.completed", item: { type: "file_change", path: "src/x.ts" } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "push" }] },
      },
    ])("accepts %j as durable action evidence", (record) => {
      const tracker = track([record as Record<string, unknown>]);
      expect(tracker.evidence().durableAction).toBe(true);
      // Even a bare acknowledgment reply completes when real work happened.
      expect(tracker.classify("On it!")).toBe("acted");
    });

    it("does not read agent prose as action evidence", () => {
      const tracker = track([
        { type: "item.completed", item: { type: "agent_message", text: "I'll do that next." } },
      ]);
      expect(tracker.evidence().durableAction).toBe(false);
      expect(tracker.classify("I'll do that next.")).toBe("acknowledgment_only");
    });

    it("does not optimistically read an unknown record type as action evidence", () => {
      const tracker = track([{ type: "some.future.record", detail: "unknown" }]);
      expect(tracker.evidence().durableAction).toBe(false);
    });
  });
});
