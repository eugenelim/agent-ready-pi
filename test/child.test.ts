import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { type ExecFn, findProjectRoot, runReview } from "../src/child.ts";
import { FORBIDDEN_TOOLS, ROLES, ReviewConfigError, parseAgentFile, parseRole, toPiAllowlist } from "../src/roles.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakePi = join(here, "fake-pi.mjs");
const scratchRoots: string[] = [];

after(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

/** Copy a fixture into a fresh directory marked as a git root. */
function fixtureRepo(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-ready-pi-test-"));
	scratchRoots.push(dir);
	cpSync(join(here, "fixtures", name), dir, { recursive: true });
	mkdirSync(join(dir, ".git"));
	return dir;
}

/** `pi.exec` stand-in built on execFile, matching its result shape; `env` reaches the fake child. */
const execWith = (env: Record<string, string>): ExecFn => (command, args, options) =>
	new Promise((resolve) => {
		const childEnv = { ...process.env, ...env };
		execFile(command, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal, env: childEnv }, (error, stdout, stderr) => {
			const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
			resolve({
				stdout: String(stdout),
				stderr: String(stderr),
				code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
				killed: err?.killed === true || err?.name === "AbortError",
			});
		});
	});

interface Capture {
	args: string[];
	cwd: string;
	files: Record<string, { mode: number; text: string }>;
}

async function review(
	role: string,
	repo: string,
	env: Record<string, string> = {},
	extra: { parentModel?: string; signal?: AbortSignal } = {},
) {
	const capture = join(repo, "capture.json");
	const childEnv = { FAKE_PI_CAPTURE: capture, ...env };
	const result = await runReview({
		role: parseRole(role),
		packet: `packet for ${role}`,
		cwd: repo,
		pi: { command: process.execPath, args: [fakePi] },
		exec: execWith(childEnv),
		env: childEnv,
		...extra,
	});
	const captured = existsSync(capture) ? (JSON.parse(readFileSync(capture, "utf8")) as Capture) : undefined;
	return { result, captured };
}

describe("child argv per role", () => {
	const expected: Record<string, string> = {
		"shaping-reviewer": "read,grep,find,ls",
		"adversarial-reviewer": "read,grep,find,ls,bash",
		"finding-adjudicator": "read,grep",
	};
	for (const role of ROLES) {
		it(`${role} runs with its exact allowlist and fixed flags`, async () => {
			const repo = fixtureRepo("repo");
			const { result, captured } = await review(role, repo, {}, { parentModel: "anthropic/parent" });
			assert.equal(result.ok, true);
			assert.equal(result.report, "Clean — ready to commit.");
			assert.ok(captured);
			const args = captured.args.slice();
			const sp = args[args.indexOf("--system-prompt") + 1]!;
			const packet = args.at(-1)!;
			assert.deepEqual(args, [
				"--print",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--tools",
				expected[role]!,
				"--system-prompt",
				sp,
				"--model",
				"anthropic/parent",
				packet,
			]);
			assert.ok(packet.startsWith("@"));
			assert.equal(result.details.allowlist.join(","), expected[role]);
			assert.equal(captured.files[sp]!.text, `# ${role}\n\nReview the packet.`);
			assert.equal(captured.files[packet.slice(1)]!.text, `packet for ${role}`);
		});
	}

	it("runs the child from the project root", async () => {
		const repo = fixtureRepo("repo");
		const { captured } = await review("shaping-reviewer", repo);
		assert.equal(realpathSync(captured!.cwd), realpathSync(findProjectRoot(repo)));
	});

	it("omits --model when there is no parent model and no mapping", async () => {
		const repo = fixtureRepo("repo");
		const { captured } = await review("finding-adjudicator", repo);
		assert.equal(captured!.args.includes("--model"), false);
	});

	it("maps the agent model through AGENT_READY_PI_MODELS", async () => {
		const repo = fixtureRepo("repo");
		const { captured } = await review(
			"finding-adjudicator",
			repo,
			{ AGENT_READY_PI_MODELS: '{"opus":"anthropic/mapped"}' },
			{ parentModel: "anthropic/parent" },
		);
		const args = captured!.args;
		assert.equal(args[args.indexOf("--model") + 1], "anthropic/mapped");
	});
});

describe("prompt files", () => {
	it("are written at mode 0600 and removed after the run", async () => {
		const repo = fixtureRepo("repo");
		const { captured } = await review("adversarial-reviewer", repo);
		const paths = Object.keys(captured!.files);
		assert.equal(paths.length, 2);
		for (const path of paths) {
			assert.equal(captured!.files[path]!.mode, 0o600);
			assert.equal(existsSync(path), false);
		}
	});

	it("are removed when the child fails", async () => {
		const repo = fixtureRepo("repo");
		const { captured } = await review("adversarial-reviewer", repo, { FAKE_PI_MODE: "fail" });
		for (const path of Object.keys(captured!.files)) assert.equal(existsSync(path), false);
	});
});

describe("child failures are never clean", () => {
	it("a non-zero exit is an error", async () => {
		const { result } = await review("shaping-reviewer", fixtureRepo("repo"), { FAKE_PI_MODE: "fail" });
		assert.equal(result.ok, false);
		assert.equal(result.details.exitCode, 1);
		assert.match(result.details.error!, /exited with code 1/);
		assert.match(result.details.stderr, /boom/);
	});

	it("empty stdout is an error", async () => {
		const { result } = await review("shaping-reviewer", fixtureRepo("repo"), { FAKE_PI_MODE: "empty" });
		assert.equal(result.ok, false);
		assert.match(result.details.error!, /no report/);
	});

	it("a timed-out child is an error", async () => {
		const { result } = await review("shaping-reviewer", fixtureRepo("repo"), {
			FAKE_PI_MODE: "hang",
			AGENT_READY_PI_TIMEOUT_MS: "300",
		});
		assert.equal(result.ok, false);
		assert.equal(result.details.killed, true);
	});

	it("an aborted call is an error", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const { result } = await review("shaping-reviewer", fixtureRepo("repo"), { FAKE_PI_MODE: "hang" }, { signal: controller.signal });
		assert.equal(result.ok, false);
	});
});

describe("fail closed on configuration", () => {
	it("rejects an unknown role", () => {
		assert.throws(() => parseRole("implementer"), ReviewConfigError);
		assert.throws(() => parseRole(undefined), ReviewConfigError);
	});

	it("rejects a missing agent file", async () => {
		const repo = fixtureRepo("repo");
		rmSync(join(repo, ".claude", "agents", "shaping-reviewer.md"));
		await assert.rejects(review("shaping-reviewer", repo), /no agent file for shaping-reviewer/);
	});

	it("falls back to .apm/agents/", async () => {
		const { result } = await review("finding-adjudicator", fixtureRepo("repo-apm"));
		assert.equal(result.ok, true);
		assert.match(result.details.agentFile, /\.apm\/agents\/finding-adjudicator\.md$/);
	});

	it("honours AGENT_READY_PI_AGENTS_DIR and does not search elsewhere", async () => {
		const repo = fixtureRepo("repo");
		await assert.rejects(review("shaping-reviewer", repo, { AGENT_READY_PI_AGENTS_DIR: "elsewhere" }), /no agent file/);
	});

	it("rejects a symlinked agent file", async () => {
		const repo = fixtureRepo("repo");
		const file = join(repo, ".claude", "agents", "shaping-reviewer.md");
		const real = join(repo, "real.md");
		cpSync(file, real);
		rmSync(file);
		symlinkSync(real, file);
		await assert.rejects(review("shaping-reviewer", repo), /not a regular file/);
	});

	it("rejects an agent file whose name differs from the role", async () => {
		const repo = fixtureRepo("repo");
		const file = join(repo, ".claude", "agents", "shaping-reviewer.md");
		writeFileSync(file, readFileSync(file, "utf8").replace("name: shaping-reviewer", "name: other"));
		await assert.rejects(review("shaping-reviewer", repo), /names other/);
	});

	it("rejects an unknown tools entry", async () => {
		const repo = fixtureRepo("repo");
		const file = join(repo, ".claude", "agents", "shaping-reviewer.md");
		writeFileSync(file, readFileSync(file, "utf8").replace("tools: Read, Grep, Glob", "tools: Read, WebFetch"));
		await assert.rejects(review("shaping-reviewer", repo), /unsupported agent tool: WebFetch/);
	});

	it("rejects Edit and Write in an agent file", () => {
		assert.throws(() => toPiAllowlist(["Read", "Edit"]), /unsupported agent tool: Edit/);
		assert.throws(() => toPiAllowlist(["Write"]), /unsupported agent tool: Write/);
	});

	it("rejects frontmatter without tools or a body", () => {
		assert.throws(() => parseAgentFile("---\nname: x\n---\nbody"), /no tools line/);
		assert.throws(() => parseAgentFile("---\nname: x\ntools: Read\n---\n"), /empty body/);
		assert.throws(() => parseAgentFile("no frontmatter"), /no frontmatter/);
	});

	it("rejects invalid AGENT_READY_PI_MODELS", async () => {
		await assert.rejects(review("shaping-reviewer", fixtureRepo("repo"), { AGENT_READY_PI_MODELS: "{" }), /not valid JSON/);
	});
});

describe("no write tool is reachable", () => {
	it("no mapped allowlist ever contains edit or write", () => {
		const every = toPiAllowlist(["Read", "Grep", "Glob", "Bash"]);
		for (const tool of FORBIDDEN_TOOLS) assert.equal(every.includes(tool), false);
	});
});
