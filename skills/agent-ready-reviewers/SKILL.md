---
name: agent-ready-reviewers
description: Use when an agent-ready skill (new-spec, intake-intent, author-delivery-brief or work-loop) says to dispatch the shaping-reviewer, adversarial-reviewer or finding-adjudicator subagent on Pi. Pi has no sub-agents; route that dispatch to the agent_ready_review tool.
---

# Agent-ready reviewers on Pi

Pi has no sub-agents. When an agent-ready skill tells you to dispatch one of
these reviewers, call the `agent_ready_review` tool instead:

| Skill asks for | Call |
| --- | --- |
| `shaping-reviewer` | `agent_ready_review` with `role: "shaping-reviewer"` |
| `adversarial-reviewer` | `agent_ready_review` with `role: "adversarial-reviewer"` |
| `finding-adjudicator` | `agent_ready_review` with `role: "finding-adjudicator"` |

1. Assemble the review packet exactly as the calling skill says. Pass it whole
   as `packet`. The reviewer sees only the packet and the repository; it does
   not see this conversation.
2. Take the tool's text back as the reviewer's report. Hand it to the calling
   skill's own persist-and-classify step unchanged.
3. If the tool returns an error, the reviewer is missing. Follow the calling
   skill's rule for a missing reviewer, which is usually `BLOCKED`. Never
   review the work yourself in its place.

Every other role, including `implementer`, stays on the calling skill's own
single-agent fallback.
