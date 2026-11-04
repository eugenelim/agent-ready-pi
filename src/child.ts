/**
 * Runs one reviewer as a fresh `pi --print` child process. This module does
 * not import Pi, so it can be tested with a fake `pi` binary.
 */

import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ROLES, type Role, ReviewConfigError, parseAgentFile, toPiAllowlist } from "./roles.ts";

/** Largest agent file this package will read. */
const MAX_AGENT_FILE_BYTES = 1024 * 1024;

/** Default child timeout: 20 minutes. */
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** The subset of `pi.exec`'s contract this module relies on. */
export type ExecFn = (
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;

/** Everything one review call needs; the extension fills it from Pi's context. */
export interface ReviewRequest {
	role: Role;
	packet: string;
	cwd: string;
	/** How to start Pi: the command plus any leading arguments. */
	pi: { command: string; args: string[] };
	exec: ExecFn;
	/** The parent's model as `provider/id`, inherited when no mapping applies. */
	parentModel?: string;
	signal?: AbortSignal;
	env?: Readonly<Record<string, string | undefined>>;
}

/** The outcome handed back to the caller's persist-and-classify path. */
export interface ReviewResult {
	ok: boolean;
	report: string;
	details: {
		role: Role;
		agentFile: string;
		allowlist: string[];
		model: string | undefined;
		modelSource: ModelSource;
		exitCode: number;
		killed: boolean;
		stderr: string;
		error?: string;
	};
}

/** Walk up from `cwd` to the nearest directory holding `.git`; fall back to `cwd`. */
export function findProjectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

/**
 * Locate the role's agent file. `AGENT_READY_PI_AGENTS_DIR` replaces the
 * search; otherwise `.claude/agents/` then `.apm/agents/` under the project
 * root. Only a regular file is accepted: a symlink or directory fails closed.
 */
export function findAgentFile(role: Role, cwd: string, env: ReviewRequest["env"] = process.env): string {
	const override = env?.AGENT_READY_PI_AGENTS_DIR;
	const root = findProjectRoot(cwd);
	const candidates = override
		? [join(resolve(cwd, override), `${role}.md`)]
		: [join(root, ".claude", "agents", `${role}.md`), join(root, ".apm", "agents", `${role}.md`)];
	for (const candidate of candidates) {
		let stat;
		try {
			stat = lstatSync(candidate);
		} catch {
			continue;
		}
		if (!stat.isFile()) throw new ReviewConfigError(`agent file is not a regular file: ${candidate}`);
		if (stat.size > MAX_AGENT_FILE_BYTES) throw new ReviewConfigError(`agent file is too large: ${candidate}`);
		return candidate;
	}
	throw new ReviewConfigError(`no agent file for ${role}; looked in ${candidates.join(", ")}`);
}

/** Where the child's model came from, recorded in the result for audit. */
export type ModelSource = "role" | "agent-model" | "parent" | "none";

/** Parse a JSON object of string values from an environment variable, or throw. */
function parseStringMap(name: string, raw: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ReviewConfigError(`${name} is not valid JSON`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ReviewConfigError(`${name} must be a JSON object`);
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "string" || !value.trim()) {
			throw new ReviewConfigError(`${name} has an empty or non-string value for ${key}`);
		}
		// "company/" or "/kimi-k3" usually means a shell variable was empty when the map was written.
		if (/^\/|\/(:|$)/.test(value.trim())) {
			throw new ReviewConfigError(`${name} has an incomplete model for ${key}: ${JSON.stringify(value)}`);
		}
	}
	return parsed as Record<string, string>;
}

/** A model reference without its optional `:<thinking>` suffix, for comparing models. */
function baseModel(model: string): string {
	const slash = model.indexOf("/");
	const colon = model.indexOf(":", slash + 1);
	return colon === -1 ? model : model.slice(0, colon);
}

/**
 * Pick the child's model, most specific first:
 *
 * 1. `AGENT_READY_PI_ROLE_MODELS`, a JSON object keyed by role. When it is set,
 *    it must name every role it is used for: a missing role fails closed
 *    instead of falling back, and the adjudicator may not share the
 *    adversarial reviewer's model, so it never judges its own family's findings.
 * 2. `AGENT_READY_PI_MODELS`, a JSON object keyed by the agent file's `model:`
 *    value (for example `opus`).
 * 3. The parent's model.
 */
export function resolveModel(
	role: Role,
	agentModel: string | undefined,
	parentModel: string | undefined,
	env: ReviewRequest["env"] = process.env,
): { model: string | undefined; source: ModelSource } {
	const roleRaw = env?.AGENT_READY_PI_ROLE_MODELS;
	if (roleRaw) {
		const roleMap = parseStringMap("AGENT_READY_PI_ROLE_MODELS", roleRaw);
		for (const key of Object.keys(roleMap)) {
			if (!(ROLES as readonly string[]).includes(key)) {
				throw new ReviewConfigError(`AGENT_READY_PI_ROLE_MODELS names an unknown role: ${key}`);
			}
		}
		const model = roleMap[role];
		if (!model) throw new ReviewConfigError(`AGENT_READY_PI_ROLE_MODELS has no model for ${role}`);
		const reviewer = roleMap["adversarial-reviewer"];
		if (role === "finding-adjudicator" && reviewer && baseModel(reviewer) === baseModel(model)) {
			throw new ReviewConfigError(
				"finding-adjudicator must not use the adversarial-reviewer's model in AGENT_READY_PI_ROLE_MODELS",
			);
		}
		return { model, source: "role" };
	}
	const raw = env?.AGENT_READY_PI_MODELS;
	if (raw && agentModel) {
		const mapped = parseStringMap("AGENT_READY_PI_MODELS", raw)[agentModel];
		if (mapped) return { model: mapped, source: "agent-model" };
	}
	return parentModel ? { model: parentModel, source: "parent" } : { model: undefined, source: "none" };
}

/** Build the child's argv. The fixed flags keep the child cold and non-recursive. */
export function buildChildArgs(opts: {
	allowlist: string[];
	systemPromptFile: string;
	packetFile: string;
	model: string | undefined;
}): string[] {
	const args = [
		"--print",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--tools",
		opts.allowlist.join(","),
		"--system-prompt",
		opts.systemPromptFile,
	];
	if (opts.model) args.push("--model", opts.model);
	args.push(`@${opts.packetFile}`);
	return args;
}

/** Parse the timeout override, falling back to the default. */
function timeoutMs(env: ReviewRequest["env"]): number {
	const value = Number(env?.AGENT_READY_PI_TIMEOUT_MS);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * Run one review. Configuration problems throw `ReviewConfigError`; a child
 * that fails, is killed or prints nothing returns `ok: false`, never a clean
 * report.
 */
export async function runReview(request: ReviewRequest): Promise<ReviewResult> {
	const env = request.env ?? process.env;
	const agentFile = findAgentFile(request.role, request.cwd, env);
	const agent = parseAgentFile(readFileSync(agentFile, "utf8"));
	if (agent.name !== request.role) {
		throw new ReviewConfigError(`agent file ${agentFile} names ${agent.name}, not ${request.role}`);
	}
	const allowlist = toPiAllowlist(agent.tools);
	const { model, source: modelSource } = resolveModel(request.role, agent.model, request.parentModel, env);

	const scratch = mkdtempSync(join(tmpdir(), "agent-ready-pi-"));
	try {
		const systemPromptFile = join(scratch, "system-prompt.md");
		const packetFile = join(scratch, "packet.md");
		writeFileSync(systemPromptFile, agent.body, { mode: 0o600 });
		writeFileSync(packetFile, request.packet, { mode: 0o600 });
		const args = [...request.pi.args, ...buildChildArgs({ allowlist, systemPromptFile, packetFile, model })];
		const result = await request.exec(request.pi.command, args, {
			signal: request.signal,
			timeout: timeoutMs(env),
			cwd: findProjectRoot(request.cwd),
		});
		const report = result.stdout.trim();
		const killed = result.killed === true;
		let error: string | undefined;
		if (killed) error = "reviewer child was terminated";
		else if (result.code !== 0) error = `reviewer child exited with code ${result.code}`;
		else if (!report) error = "reviewer child printed no report";
		return {
			ok: error === undefined,
			report,
			details: {
				role: request.role,
				agentFile,
				allowlist,
				model,
				modelSource,
				exitCode: result.code,
				killed,
				stderr: result.stderr.slice(-4000),
				...(error ? { error } : {}),
			},
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
