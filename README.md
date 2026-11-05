# agent-ready-pi

A Pi package that lets a Pi run pass the agent-ready review gates. Without
it, a run stops there: shaping review, adversarial review, finding
adjudication and the security and quality passes all need an independent
reviewer, and Pi has no sub-agents.

The package adds one tool, `agent_ready_review`. It runs each reviewer as a
fresh `pi --print` child process with that role's own tool allowlist. It is
optional and installed separately. agent-ready Core does not import, bundle,
install or select it.

## Install

Pi needs Node.js 22.19 or newer.

```bash
# Personal: written to ~/.pi/agent/settings.json
pi install git:github.com/eugenelim/agent-ready-pi@v0.1.7

# One project: written to the project's .pi/settings.json.
# Pi loads it only after you trust the project.
pi install -l git:github.com/eugenelim/agent-ready-pi@v0.1.7

# Try it once without saving
pi -e /path/to/agent-ready-pi
```

### Upgrade

Install the new tag. Pi replaces the old version in place, so there is
nothing to remove:

```bash
pi install git:github.com/eugenelim/agent-ready-pi@v0.1.7
pi list        # shows one entry, at the new tag
```

**Do not run `pi remove` with the old tag after upgrading.** Pi matches the
package without its tag, so removing `@v0.1.5` removes the version you just
installed. If `pi list` ever shows nothing for the package, install it again.

### Remove

```bash
pi remove git:github.com/eugenelim/agent-ready-pi
pi list        # the package is gone
```

This removes the settings entry and the downloaded copy. Add `-l` to remove a
project install.

### What the project needs

The project also needs [agent-ready](https://github.com/eugenelim/agent-ready-repo)
Core installed, for two reasons:

- Pi reads Core's skills from `.agents/skills/`.
- The tool reads each reviewer's definition from `.claude/agents/<role>.md`,
  then from `.apm/agents/<role>.md`. Both are under the repository root.

Install Core with `agentbundle`, as agent-ready's README shows:

```bash
python -m pip install agentbundle
agentbundle install --pack core
```

Commit the installed files, so every checkout and worktree has them.

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
| `security-reviewer` | Read, Grep, Glob, Bash | `read,grep,find,ls,bash` |
| `quality-engineer` | Read, Grep, Glob, Bash | `read,grep,find,ls,bash` |

The mapping is Read→`read`, Grep→`grep`, Glob→`find,ls` and Bash→`bash`.
`edit` and `write` are never granted.

**`adversarial-reviewer`, `security-reviewer` and `quality-engineer` have
`bash`.** Their lists are wider than read-only, because they rerun the
failures they report. The limits above are tool-level
only. Pi has no permission system, so they are not an OS sandbox. Run Pi
inside a container when the repository holds code you do not trust.

## Independence

agent-ready's shaping-review gate accepts "a genuinely fresh context" as an
independent reviewer. This package claims that a fresh `--no-session` child,
which loads no session and no context files, is that fresh context.

**Whether to accept the claim is your decision** for your own review gates.
agent-ready Core's gate text does not mention this package. If you do not
accept it, keep a human reviewer for shaping review on Pi.

The child uses the parent's model unless you map another. A different model
for the adjudicator, as recommended below, adds independence that a fresh
process alone does not give.

## Use a hosted model

Reviewers can run on any model Pi can reach. The default setup below uses a
company endpoint that serves GLM-5.3, an open-weight model, over an
OpenAI-compatible API. The reviewer child inherits the parent's environment
and Pi configuration directory, so you set the model up once.

Two warnings before you start:

- **Your code goes to the endpoint.** It receives everything a reviewer
  reads, so use one your data rules allow.
- **Check each model's licence.** GLM-5.3 uses the GLM-5.3 License and
  Kimi K3 the Kimi K3 License. Neither is MIT, so check that they cover your
  use.

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
| `Unsupported thinking_effort='medium'; supported values are [...]` | The endpoint accepts other thinking levels for this model. Add a `thinkingLevelMap`, as shown for Kimi K3 in step 5 |
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

To run Pi and every reviewer on one model, start Pi with
`--model company/<endpoint model ID>`. Reviewer children use the parent's
model unless you map another.

#### Recommended: a model per role

Use GLM-5.3 where tool use matters and Kimi K3 where reasoning matters.
This advice dates from November 2026. It rests mainly on Artificial
Analysis's comparison of the two models: GLM-5.3 scored 42% on
Terminal-Bench 4.0 against Kimi K3's 13%, and Kimi K3 scored 27% on
HLE-Diamond against GLM-5.3's 18%. Open-weight models change quickly, so
check newer releases before you adopt it.

| Role | Model | Why |
| --- | --- | --- |
| Pi itself | GLM-5.3 | Long sessions with heavy tool use |
| `adversarial-reviewer` | GLM-5.3 | Reproduces failures with `bash` |
| `shaping-reviewer` | Kimi K3 | Judges a contract; reasoning matters most |
| `finding-adjudicator` | Kimi K3 | A different model family from the reviewer whose findings it judges |
| `security-reviewer` | GLM-5.3 | Runs `bash` to probe a boundary |
| `quality-engineer` | GLM-5.3 | Runs `bash` to check tests and behaviour |

First add Kimi K3 to the `company` provider in `models.json`, next to
GLM-5.3. Use the endpoint's real limits:

```json
{
  "id": "kimi-k3",
  "name": "Kimi K3",
  "reasoning": true,
  "contextWindow": 1000000,
  "maxTokens": 32768,
  "thinkingLevelMap": {
    "minimal": "low", "low": "low", "medium": "high",
    "high": "high", "xhigh": "max", "max": "max"
  }
}
```

`thinkingLevelMap` translates Pi's thinking levels into values the endpoint
accepts. Some Kimi K3 deployments accept only `low`, `high` and `max`, so
Pi's default `medium` is sent as `high`.

Then map each role in the settings file, `agent-ready-pi.json` in Pi's
configuration directory. Use your endpoint's model IDs:

```bash
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; mkdir -p "$PI_DIR"
cat > "$PI_DIR/agent-ready-pi.json" <<'EOF'
{
  "roleModels": {
    "shaping-reviewer": "company/kimi-k3",
    "adversarial-reviewer": "company/glm-5-3",
    "finding-adjudicator": "company/kimi-k3",
    "security-reviewer": "company/glm-5-3",
    "quality-engineer": "company/glm-5-3"
  }
}
EOF
pi --model company/glm-5-3
```

The tool reads this file on every call, so an edit applies straight away,
in every terminal and worktree, without restarting Pi.

`AGENT_READY_PI_ROLE_MODELS` still works and takes priority over the file.
It is read only when Pi starts, so a change to it needs a restart. If you set
it in `~/.zshrc` before v0.1.5, remove that line and use the file:
`sed -i '' '/AGENT_READY_PI_ROLE_MODELS/d' ~/.zshrc`, then open a new window.

To see what the tool will use, ask Pi to call `agent_ready_review` with
`check: true` for a role. It reports the model and where it came from, the
review root, the agent file and the tools, without running a reviewer.

The role map is strict, so a gate never quietly runs on the wrong model:

- **Every role it runs must be listed.** A role left out fails with an error.
  It does not fall back to another model.
- **The adjudicator must not use the adversarial reviewer's model.** The
  check ignores a `:<thinking>` suffix, so `company/glm-5-3:high` and
  `company/glm-5-3` count as the same model.
- **Incomplete names are refused.** A value such as `company/`, usually left
  by an empty shell variable, fails before any child starts.
- **Each result records the model it used.** The tool's `details` show
  `model` and `modelSource`, which is `role`, `agent-model`, `parent` or
  `none`. For a role map, `roleMapFrom` says `env` or `file`.

#### If a review fails

A failed review names the cause, the model the child ran on, where that
choice came from, and the end of the child's error output. The session then
stops at the gate instead of reviewing its own work.

| Message | Cause and fix |
| --- | --- |
| `exited with code 1` with `source: parent` and `No role map is set` | Neither the settings file nor `AGENT_READY_PI_ROLE_MODELS` has a role map, so the child fell back to Pi's own model. Write the settings file; the next call uses it |
| `Failed to resolve API key … from shell command` after 3 attempts | The keychain command timed out or failed on every try. Pi gives it 10 seconds, so a heavily loaded machine can trip it. The tool already retries twice, after 2 and 4 seconds. Retry when the load drops; if it persists, run the step 2 key check |
| `exited with code 1` with `No API key found` | The child's model has no key. Start Pi with `--model company/<model ID>`, or set the role map |
| `Unsupported thinking_effort` in the error output | Add a `thinkingLevelMap` for that model, as shown above |
| `no model for <role>` | The role map leaves out that role. Add it |
| `incomplete model for <role>: "company/"` | The model name is missing after the provider. Fix the value |
| The review reads old files, or files are missing | Pi was started in a different worktree from the work. Exit, `cd` to the worktree that holds the work, and run `pi --continue` |

To rule out the package, run one child by hand from the repository root.
This check is for people diagnosing setup. Its output is not a review result,
so never use it as a substitute for the tool at a gate:

```bash
echo "Reply with OK." > /tmp/pi-child-packet.md
pi --print --no-session --no-extensions --no-skills --no-context-files \
  --tools read,grep,find,ls --system-prompt .claude/agents/shaping-reviewer.md \
  --model company/<model ID> @/tmp/pi-child-packet.md; echo "exit $?"
```

A reply and `exit 0` mean the reviewer and the model work. The shaping
reviewer will say a test packet is out of scope, which is correct.

#### One model for all reviewers

To send every reviewer to one model, map the agent files' `model:` value.
Every agent-ready reviewer declares `model: opus`:

```bash
export AGENT_READY_PI_MODELS='{"opus":"company/<endpoint model ID>"}'
```

A role map, from the settings file or `AGENT_READY_PI_ROLE_MODELS`, takes priority over this.

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

## Skills and agents from your user profile

### Skills

Pi loads user skills from two folders: `~/.agents/skills/` and
`~/.pi/agent/skills/`. To use skills installed somewhere else, such as
`~/.claude/skills/`, add the folder to `skills` in `~/.pi/agent/settings.json`:

```bash
python3 - ~/.pi/agent/settings.json <<'EOF'
import json, os, sys
p = sys.argv[1]; d = json.load(open(p)) if os.path.exists(p) else {}
paths = d.setdefault("skills", [])
if "~/.claude/skills" not in paths: paths.append("~/.claude/skills")
json.dump(d, open(p, "w"), indent=2); print("skills:", paths)
EOF
```

Then start `pi` and check its startup messages for the skills it loaded.

**Loading a skill does not make it work on Pi.** This applies to every skill
written for another agentic coding tool, such as Claude Code, Codex, Cursor,
Copilot or Gemini CLI. It applies even when the skill sits in the shared
`~/.agents/skills/` folder.

- **Missing tools.** Pi has only `read`, `bash`, `edit`, `write`, `grep`,
  `find`, `ls` and the tools that installed packages add. A step that needs
  another tool fails or gets skipped. Examples: starting a subagent, invoking
  another skill, fetching a web page, or calling a tool from an MCP server
  that Pi has not been set up with.
- **The skill does not know it is on Pi.** It may name host commands,
  settings files or folders that Pi does not have. A missing piece is not
  always reported, so check the result.
- **Same-named skills.** When two folders hold a skill with the same name,
  Pi keeps the first one it finds and prints a warning.

Test each skill you rely on before trusting it in a review gate.

### Agents (subagents)

Pi has no subagent system. It does not read agent definitions from any
folder, whether user or project, and whichever tool they were written for,
for example `~/.claude/agents/`, `.codex/agents/` or `.github/agents/`.

The `agent_ready_review` tool is the only way this package runs an agent, and
it has two limits:

- **Five roles only.** It runs `shaping-reviewer`, `adversarial-reviewer`,
  `finding-adjudicator`, `security-reviewer` and `quality-engineer`. It refuses
  every other agent, such as a research
  or design reviewer.
- **Repository files by default.** It reads the definitions from the
  repository's `.claude/agents/` or `.apm/agents/`.
  `AGENT_READY_PI_AGENTS_DIR` points it at another folder. The files there
  must still define those five roles, with tool lists the package can map.

Running any other agent on Pi would need this package, or another one, to
support that role and its tool allowlist.

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

- **Start Pi inside the worktree that holds the work.** Reviewers read files
  at the git root of the folder Pi was started in. A session started in the
  main checkout reviews the main checkout's files, not the worktree's.
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
| `AGENT_READY_PI_CONFIG` | The settings file to read. The default is `agent-ready-pi.json` in Pi's configuration directory. The file holds `roleModels`, a role map with the same rules as below, and is read on every call |
| `AGENT_READY_PI_ROLE_MODELS` | A JSON map from a role to a Pi model pattern. It takes priority over the settings file, and is read when Pi starts. When set, it must list every role it runs, and `finding-adjudicator` must not use `adversarial-reviewer`'s model. It takes priority over `AGENT_READY_PI_MODELS` |
| `AGENT_READY_PI_MODELS` | A JSON map from an agent file's `model:` value to a Pi model pattern, such as `{"opus": "anthropic/claude-opus-5-5"}`. Without either map, the child uses the parent's model |
| `AGENT_READY_PI_TIMEOUT_MS` | The child timeout. The default is 1,200,000 ms (20 minutes) |
| `AGENT_READY_PI_BIN` | The Pi command to start. By default, it reuses the running Pi |

## Development

```bash
npm install --ignore-scripts
npm test           # node:test, with a fake pi binary and no network
npm run typecheck  # tsc --noEmit
```

## Versions

Tags pin what `pi install …@<tag>` downloads, which is the tool and the skill
Pi loads. A new tag is cut only when either of those changes. Documentation
changes go straight to `main`. Read this README on GitHub for the latest
setup advice.

## Support

Provided as is, without support commitments. Issues and pull requests are
welcome.

## License

Apache-2.0 OR MIT, the same as agent-ready.
