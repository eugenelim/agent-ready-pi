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
pi install git:github.com/eugenelim/agent-ready-pi@v0.1.2

# One project: written to the project's .pi/settings.json.
# Pi loads it only after you trust the project.
pi install -l git:github.com/eugenelim/agent-ready-pi@v0.1.2

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
- **Model ID**, as the endpoint names GLM-5.3. Pi sends this exact string,
  and endpoints differ: one may call it `glm-5-3`, another `glm-5.3`. Step 4
  shows how to list the names your key can use.
- **Key header**: the standard `Authorization: Bearer <key>`, or a header of
  the endpoint's own, such as `api-key`. This is the header's name, never the
  key itself.
- **Limits**: the context window and the maximum output tokens the endpoint
  allows.

### 2. Keep the key in the macOS keychain

In your own terminal, run:

```bash
security add-generic-password -a "$USER" -s pi-company-llm -w
```

With nothing after `-w`, `security` asks for the key twice, so it never
lands in shell history. macOS requires the account name (`-a`); `$USER`, your
macOS username, is enough. To replace a stored key, run
`security delete-generic-password -s pi-company-llm` first.

Check the key without printing it:

```bash
k="$(security find-generic-password -s pi-company-llm -w)"; echo "exit $? · key length ${#k}"; unset k
```

You should see `exit 0` and a length above 0. If macOS asks whether
`security` may use the keychain, click **Always Allow**. Pi gives up on a key
command that waits too long, so the prompt must not appear during a Pi run.

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
- **Set `contextWindow` and `maxTokens` to the endpoint's limits.** Both are
  optional, but Pi does not ask a custom endpoint for its limits. A blank
  field gets Pi's own default, not the endpoint's:
  - Without `contextWindow`, Pi assumes 128,000 tokens and compacts long
    sessions early. GLM-5.3 supports about 1M tokens, but an endpoint may
    allow less.
  - Without `maxTokens`, Pi assumes 16,384 tokens when it sizes the thinking
    budget.
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
should print `OK`. If it fails:

| Error | Cause and fix |
| --- | --- |
| `Failed to resolve API key … from shell command` | The keychain command failed. Run the step 2 check. `exit 44` means no item is stored: add it with `-a "$USER"`. A prompt means you need to click **Always Allow** |
| `Failed to resolve provider "company" header "<value>"` | Reading the key for that header failed. If `<value>` is your key, the key went in as the header's name: see below |
| `404 status code (no body)` | The base URL is wrong. Pi sends requests to `<baseUrl>/chat/completions`, so the base URL ends at the API root, often `/v1` |
| The endpoint redirects to `/login` | The URL is the browser app, or the endpoint did not recognise the key. Find the API path and key header with the check below |
| `403` with `key_model_access_denied` | The model name is wrong, or your key may not use it. List the names your key can use with the check below |
| `Model "<id>" not found for provider "company". Using custom model id.` | The request reached the endpoint, but `models.json` has a different ID. Pi then ignores your limits. Make the `id` match |

To list the models your key can use, run this check. It prints only model
names and status codes; the key goes to `curl` through a pipe, never on
screen or in the process list:

```bash
LLM_BASE_URL="https://llm.example.internal/v1"   # the baseUrl from models.json
LLM_KEY_HEADER=""                                # empty for Bearer, or e.g. "api-key"
H="${LLM_KEY_HEADER:-Authorization}"; P=$([ -z "$LLM_KEY_HEADER" ] && echo "Bearer ")
security find-generic-password -s pi-company-llm -w | sed "s/^/$H: $P/" \
  | curl -sS -H @- -w "\nHTTP %{http_code}\n" "$LLM_BASE_URL/models"
```

A `200` with a model list means the base URL and key header are right. A `307`
or a redirect to `/login` means one of them is wrong.

**If your key ended up in `models.json`**, for example as a header name:

1. Fix the `company` entry, so the header is a name such as `api-key` or there
   is no `headers` entry at all.
2. Remove the key from your shell history and anywhere else you pasted it.
3. Ask the endpoint's owner to rotate the key. Store the new one as in step 2.

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

## Work in several sessions at once

Give each Pi session its own git worktree: a second checkout of the same
repository, in its own folder and on its own branch. Sessions then never edit
each other's files.

Run this from anywhere inside the repository. Change `TOPIC` for each
session:

```bash
TOPIC=my-change                                   # a short branch name for this session
BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD || echo origin/main)
ROOT=$(git rev-parse --show-toplevel)
WT="$(dirname "$ROOT")/$(basename "$ROOT")-$TOPIC"
git fetch origin
git worktree add -b "$TOPIC" "$WT" "$BASE"
cd "$WT"
pi --model company/<endpoint model ID>
```

The worktree sits beside the repository, for example `myrepo-my-change`
next to `myrepo`. It starts from the latest remote default branch.

- **Uncommitted changes stay behind.** A new worktree has only committed work.
- **Setup is shared.** The package install, `models.json` and the keychain
  key are per user, so a worktree needs no setup of its own.
- **Trust is per folder.** Pi may ask whether to trust the new folder. Give
  the same answer you gave for the main checkout.
- **Reviewer files must be committed.** The tool reads `.claude/agents/` or
  `.apm/agents/` inside the worktree. Check with
  `ls .claude/agents .apm/agents`. If they are missing because they are not
  committed, point the tool at the main checkout:
  `export AGENT_READY_PI_AGENTS_DIR="$ROOT/.claude/agents"`.

See the open worktrees, and remove one once its branch is merged:

```bash
git worktree list
git worktree remove "$WT"
git branch -d "$TOPIC"
```

`git worktree remove` refuses while the worktree has uncommitted changes, so
nothing is lost by accident.

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
