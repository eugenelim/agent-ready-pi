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

## How the tool works

These facts are settled. Use them instead of working them out.

- **Check first.** Call `agent_ready_review` with `check: true` and the role,
  with no packet. It reports the model, where that model came from, the
  review root, the agent file and the tools, and runs no reviewer. Call it
  before a gate and again after any settings fix.
- **Settings the tool reads.** It reads its role map on every call, in this
  order:
  1. `AGENT_READY_PI_ROLE_MODELS` in Pi's own environment, which is fixed
     when Pi starts.
  2. `roleModels` in the settings file, `~/.pi/agent/agent-ready-pi.json` by
     default, read fresh each time.

  The `bash` tool's environment is not evidence of what the tool sees. Trust
  the `check` result.
- **Applying a settings fix.**
  - A fix to the settings file applies on the next call.
  - A fix to `AGENT_READY_PI_ROLE_MODELS` applies only after Pi restarts. Tell
    the user to exit and run `pi --continue` from the same folder.
- **Review root.** The reviewer runs at the git root of the folder Pi was
  started in, and reads files there. If the work under review is in another
  worktree, stop and tell the user to start Pi in that worktree. Do not
  rewrite packet paths to point across worktrees.
- **Packet paths.** Use paths relative to the review root, as the calling
  skill gives them.
- **No hand-run reviewer.** Never start a reviewer child yourself with
  `pi --print` or any other command, even with the same flags. The tool
  enforces the tool allowlist, the role map's rules and the recorded model;
  a hand-run child skips all three, and its report is not a gate result.
- **Reading a failure.** A failed call names the cause, the model and its
  source, and the end of the child's error output. Report that to the user
  with the fix it points to, then stop at the gate.

Every other role, including `implementer`, stays on the calling skill's own
single-agent fallback.
