---
type: Documentation Index
title: "Domain"
description: "Files and subdirectories in Domain."
---

# Files

- [Agent identity domain](agent-identities.md) - Describes the Agent Identities domain model, versioned settings state, provider authorization boundaries, config resolution behavior, and credential sidecar handling for Paperclip agent identities.
- [Slack provider MVP contract and threat model](slack-provider-design.md) - Historical Slack identity provider design record with shipped-behavior annotations covering the MVP product boundary, credentials, tool surface, settings persistence, and threat model.
- [Slack provider MVP — contract, product boundary, threat model](slack-provider-mvp.md) - Specifies the partially implemented Slack provider MVP, including identity shape, company-scoped credential references, HTTP Events API behavior, manifest-assisted setup, and deferred capabilities.
- [Slack app manifests and per-agent provisioning](slack-provisioning-decision.md) - Records the decision to provision one Slack app and bot user per Paperclip agent using manual manifest copy/paste, HTTPS Events API transport, and company-scoped Slack credential references.
