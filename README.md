# agent-ready-pi

A Pi package that lets a Pi run pass the three agent-ready review gates.
Without it, a run stops there: shaping review, adversarial review and finding
adjudication all need an independent reviewer, and Pi has no sub-agents.

The package adds one tool, `agent_ready_review`. It runs each reviewer as a
fresh `pi --print` child process with that role's own tool allowlist. It is
optional and installed separately. agent-ready Core does not import, bundle,
install or select it.

## Install

Pi needs Node.js 22.19 or newer.

```bash
# Personal: written to ~/.pi/agent/settings.json
pi install git:github.com/eugenelim/agent-ready-pi@v0.1.0

# One project: written to the project's .pi/settings.json.
# Pi loads it only after you trust the project.
pi install -l git:github.com/eugenelim/agent-ready-pi@v0.1.0

# Try it once without saving
pi -e /path/to/agent-ready-pi
```

The project also needs agent-ready Core installed, for two reasons:

- Pi reads Core's skills from `.agents/skills/`.
- The tool reads each reviewer's definition from `.claude/agents/<role>.md`,
  then from `.apm/agents/<role>.md`. Both are under the repository root.

## What the tool runs

```
pi --print --no-session --no-extensions --no-skills --no-context-files \
   --tools <allowlist> --system-prompt <agent body> [--model <m>] @<packet>
```

- **`--no-session`:** the child starts cold. It saves no session and shares no
  conversation with the parent.
- **`--no-extensions`:** the child cannot call `agent_ready_review` itself, so
  a review cannot recurse.
- **`--no-skills` and `--no-context-files`:** the child loads no skills and no
  `AGENTS.md` or `CLAUDE.md`. Each reviewer body tells it which repository
  files to read.
- **Prompt files:** the agent body and the packet go to a private temporary
  directory, with files at mode 0600. The directory is removed after the run.
- **Failure:** if the role, agent file or a `tools:` entry is unknown, the
  call fails closed. A child that exits non-zero, is killed or prints nothing
  returns an error. A failure is never reported as a clean review.

## Role allowlists

| Role | Agent file `tools:` | Pi `--tools` |
| --- | --- | --- |
| `shaping-reviewer` | Read, Grep, Glob | `read,grep,find,ls` |
| `adversarial-reviewer` | Read, Grep, Glob, Bash | `read,grep,find,ls,bash` |
| `finding-adjudicator` | Read, Grep | `read,grep` |

The mapping is Read→`read`, Grep→`grep`, Glob→`find,ls` and Bash→`bash`.
`edit` and `write` are never granted.

**`adversarial-reviewer` has `bash`.** Its list is wider than read-only,
because it reruns the failures it reports. The limits above are tool-level
only. Pi has no permission system, so they are not an OS sandbox. Run Pi
inside a container when the repository holds code you do not trust.

## Independence

A fresh `--no-session` child that loads no context files counts as the
"genuinely fresh context" that agent-ready's shaping-review gate accepts. It
uses the same model as the parent unless you map a model. This is the claim
this package makes, and the repository owner has accepted it. agent-ready
Core's gate text is unchanged.

## Configuration

| Variable | Effect |
| --- | --- |
| `AGENT_READY_PI_AGENTS_DIR` | Read `<dir>/<role>.md` instead of searching `.claude/agents/` and `.apm/agents/` |
| `AGENT_READY_PI_MODELS` | A JSON map from an agent file's `model:` value to a Pi model pattern, such as `{"opus": "anthropic/claude-opus-5-5"}`. Without it, the child uses the parent's model |
| `AGENT_READY_PI_TIMEOUT_MS` | The child timeout. The default is 1,200,000 ms (20 minutes) |
| `AGENT_READY_PI_BIN` | The Pi command to start. By default, it reuses the running Pi |

## Development

```bash
npm install --ignore-scripts
npm test           # node:test, with a fake pi binary and no network
npm run typecheck  # tsc --noEmit
```

## License

Apache-2.0 OR MIT, the same as agent-ready.
