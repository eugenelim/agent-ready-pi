---
name: agent-ready-reviewers
description: Use when an agent-ready skill (new-spec, intake-intent, author-delivery-brief or work-loop) says to dispatch the shaping-reviewer, adversarial-reviewer, finding-adjudicator, security-reviewer or quality-engineer subagent on Pi. Pi has no sub-agents; route that dispatch to the agent_ready_review tool.
---

# Agent-ready reviewers on Pi

Pi has no sub-agents. When an agent-ready skill tells you to dispatch one of
these reviewers, call the `agent_ready_review` tool instead:

| Skill asks for | Call |
| --- | --- |
| `shaping-reviewer` | `agent_ready_review` with `role: "shaping-reviewer"` |
| `adversarial-reviewer` | `agent_ready_review` with `role: "adversarial-reviewer"` |
| `finding-adjudicator` | `agent_ready_review` with `role: "finding-adjudicator"` |
| `security-reviewer` | `agent_ready_review` with `role: "security-reviewer"` |
| `quality-engineer` | `agent_ready_review` with `role: "quality-engineer"` |

1. Assemble the review packet exactly as the calling skill says. Pass it whole
   as `packet`. The reviewer sees only the packet and the repository; it does
   not see this conversation. Add no output-format instructions of your own:
   the reviewer's agent file sets its output contract, and the calling skill
   says when to ask for a typed report instead.
2. Take the tool's text back as the reviewer's report, unchanged. Then follow
   the calling skill's own steps for that kind of report, and only those.
3. If the tool returns an error, the reviewer is missing. Follow the calling
   skill's rule for a missing reviewer, which is usually `BLOCKED`. Never
   review the work yourself in its place.

## Which flow you are in

What happens to a report depends on the flow the calling skill is running, not
on the role alone. The calling skill decides each step; this package adds none.
As agent-ready Core 4.0 defines them (check the named file before acting on a
detail, because Core changes):

| Flow | Report format | What the calling skill does | Owning file |
| --- | --- | --- | --- |
| Shaping review (`new-spec`, `intake-intent`) | `Clean` or `Findings`, each with a `Fix:` line | Resolve the findings in the artifact and run the shaping review again until `Clean`. No persist, `raw-classify` or adjudication | the calling skill |
| Pre-EXECUTE review, before `start` | The exact clean sentence `Clean — ready to commit.`, or findings | Persist the report, `raw-classify` it, and send `findings` to `finding-adjudicator`. A missing adjudicator is a loud stop | work-loop `references/pre-execute-review.md` |
| Light mode and direct-light | The same sentence or findings | Persist, `raw-classify`, adjudicate what is not clean, and run adversarial rounds until clean. A missing adversarial reviewer is `BLOCKED`. Direct-light has no spec and no run state, so do not invent a spec path. `quality-engineer` runs only when the repo declares a strict external quality gate or a human asks for it | work-loop `references/light-mode.md`, `references/finding-adjudication.md` |
| Full mode (supervisor) | A typed report: one fenced `json` block, requested through the supervisor's `review-role` request | Persist the return and shape it into the typed report bound to the supervisor's subject. The controller assesses each finding itself; this is not the `raw-classify` path | work-loop `references/supervisor.md` § Review |

Before acting on a report, check:

- You know which flow you are in. If you cannot tell, the calling skill's
  mode line or the supervisor's request says; do not guess.
- The report is from the role you asked for, and you apply that flow's step
  for that role. An adjudicator's report has its own classification in the
  calling skill; do not treat it as an adversarial report.
- **`raw-classify` is for the adversarial format only.** It marks a shaping
  report `invalid` because a shaping report never contains the adversarial
  clean sentence. That is expected, not a stop. Do not run it on a shaping
  report, or on a typed report.
- **A clean report must be the sentence and nothing else.** Any text before or
  after the sentinel, apart from blank lines, makes `raw-classify` answer
  `invalid`, and a `## Not checked` footer sends even a clean report to the
  adjudicator. `invalid` is a loud stop in the calling skill. Do not edit the
  report into shape to get past it.
- **If a calling skill's text differs from this table, the skill wins.**

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

Any other role, including `implementer`, is not run by this tool and stays on
the calling skill's own fallback.
