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

## Use a hosted model

Reviewers can run on any model Pi can reach, including open-weight models
such as GLM-5.3 served by a hosting company. The reviewer child gets the same
environment and Pi configuration directory as the parent, so you only set the
model up once.

Two warnings before you choose:

- **Your code goes to the host.** The host receives everything a reviewer
  reads, so pick one your data rules allow.
- **Check the model's licence.** Some open-weight models use their own
  licence, not MIT or Apache.

### 1. Keep the API key in the macOS keychain

In your own terminal, run:

```bash
security add-generic-password -s pi-<host> -w
```

With nothing after `-w`, `security` asks for the key, so it never lands in
shell history. Pi only stores a command that reads the key, never the key
itself. The first time Pi reads the key, macOS may ask you to allow it.

### 2a. A host Pi already supports

Fireworks, Together AI, OpenRouter, Z.ai, Moonshot, Hugging Face and the
other providers in Pi's `docs/providers.md` come with their endpoints built
in. You need only the key and a model ID in the form `<provider>/<id>`:

```bash
export FIREWORKS_API_KEY="$(security find-generic-password -s pi-fireworks -w)"
pi --list-models glm        # confirm the exact model ID
pi --model fireworks/<model-id>
```

Use the variable that matches your host, such as `TOGETHER_API_KEY`,
`OPENROUTER_API_KEY` or `ZAI_API_KEY`. The key then sits in that shell's
environment until you close it.

### 2b. Any other host

For a company gateway, vLLM, SGLang, LM Studio or Ollama, add the endpoint to
`models.json` in Pi's configuration directory. By default that is
`~/.pi/agent/`; `PI_CODING_AGENT_DIR` changes it. A leading `!` makes Pi run
the command on each request, so the key is not written to the file:

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "myhost": {
      "baseUrl": "https://<host>/v1",
      "api": "openai-completions",
      "apiKey": "!security find-generic-password -s pi-myhost -w",
      "models": [{ "id": "<model-id>" }]
    }
  }
}
```

Then run `pi --model myhost/<model-id>`. Use `"api": "openai-completions"`
for an OpenAI-compatible server. For any other API, see Pi's
`docs/models.md`.

### 3. Choose the reviewer model

With no mapping, every reviewer child uses the parent's model. To give
reviewers a different model, map the agent file's `model:` value. Every
agent-ready reviewer declares `model: opus`:

```bash
export AGENT_READY_PI_MODELS='{"opus":"fireworks/<model-id>"}'
```

### 4. Remove it afterwards

```bash
security delete-generic-password -s pi-<host>
```

Then revoke the key in the host's console.

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
