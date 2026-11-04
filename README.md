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

Reviewers can run on any model Pi can reach. The default setup below uses a
company endpoint that serves GLM-5.3, an open-weight model, over an
OpenAI-compatible API. The reviewer child inherits the parent's environment
and Pi configuration directory, so you set the model up once.

Two warnings before you start:

- **Your code goes to the endpoint.** It receives everything a reviewer
  reads, so use one your data rules allow.
- **GLM-5.3 has its own licence**, the GLM-5.3 License. It is not MIT, so
  check that it covers your use.

### 1. Collect the endpoint details

Ask the endpoint's owner for these four facts:

- **Base URL**, for example `https://llm.example.internal/v1`.
- **Model ID**, as the endpoint names GLM-5.3. Pi sends this exact string.
- **Key header**: the standard `Authorization: Bearer <key>`, or a header of
  the endpoint's own, such as `api-key`.
- **Limits**: the context window and the maximum output tokens the endpoint
  allows.

### 2. Keep the key in the macOS keychain

In your own terminal, run:

```bash
security add-generic-password -s pi-company-llm -w
```

With nothing after `-w`, `security` asks for the key, so it never lands in
shell history. The first time Pi reads the key, macOS may ask you to allow
it.

### 3. Add the endpoint to `models.json`

Pi reads `models.json` from its configuration directory. By default that is
`~/.pi/agent/`; set `PI_CODING_AGENT_DIR` to use another one. Put this in
`models.json`, using the values from step 1:

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "company": {
      "baseUrl": "https://llm.example.internal/v1",
      "api": "openai-completions",
      "apiKey": "!security find-generic-password -s pi-company-llm -w",
      "models": [
        {
          "id": "<endpoint model ID>",
          "name": "GLM-5.3",
          "reasoning": true,
          "contextWindow": 1000000,
          "maxTokens": 32768
        }
      ]
    }
  }
}
```

- **The key is never stored.** The leading `!` makes Pi run the keychain
  command on each request.
- **Set `contextWindow` and `maxTokens` to the endpoint's limits.** GLM-5.3
  supports about 1M tokens of context, but an endpoint may allow less.
  Without `contextWindow`, Pi assumes 128,000 tokens.
- **`reasoning: true`** lets Pi request GLM-5.3's thinking mode. Set it to
  `false` if the endpoint does not expose thinking.
- **For a key header of the endpoint's own**, keep a placeholder `apiKey`,
  which Pi needs to treat the model as available. Then send the real key in
  `headers`:

  ```json
  "apiKey": "unused",
  "headers": { "api-key": "!security find-generic-password -s pi-company-llm -w" },
  ```

### 4. Check the endpoint

```bash
pi --list-models glm
pi --print --no-session --model company/<endpoint model ID> "Reply with OK."
```

The first command should list `company/<endpoint model ID>`. The second
should print `OK`.

### 5. Use it for reviewers

To run Pi on this model, start it with `--model company/<endpoint model ID>`.
Reviewer children then use it too.

To keep Pi on another model and send only reviewers to GLM-5.3, map the
agent files' `model:` value. Every agent-ready reviewer declares
`model: opus`:

```bash
export AGENT_READY_PI_MODELS='{"opus":"company/<endpoint model ID>"}'
```

### A host Pi already supports

Fireworks, Together AI, OpenRouter, Z.ai, Moonshot, Hugging Face and the
other providers in Pi's `docs/providers.md` come with their endpoints built
in. Skip step 3: set the host's key variable, then use
`--model <provider>/<model ID>`:

```bash
export FIREWORKS_API_KEY="$(security find-generic-password -s pi-fireworks -w)"
pi --list-models glm
```

### Remove it afterwards

```bash
security delete-generic-password -s pi-company-llm
```

Delete the `company` entry from `models.json`, then revoke the key with the
endpoint's owner.

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
