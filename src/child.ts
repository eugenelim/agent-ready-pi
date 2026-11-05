/**
 * Runs one reviewer as a fresh `pi --print` child process. This module does
 * not import Pi, so it can be tested with a fake `pi` binary.
 */

import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ROLES, type Role, ReviewConfigError, parseAgentFile, toPiAllowlist } from "./roles.ts";

/** Largest agent file this package will read. */
const MAX_AGENT_FILE_BYTES = 1024 * 1024;

/** Largest settings file this package will read. */
const MAX_CONFIG_FILE_BYTES = 64 * 1024;

/** Default child timeout: 20 minutes. */
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Waits before each retry of a child that failed to resolve its API key. The
 * keychain command runs under Pi's 10 second limit, so a loaded machine can
 * time it out; a short, bounded backoff rides that out without stalling a gate.
 */
export const KEY_RETRY_DELAYS_MS: readonly number[] = [2000, 4000];

/** What Pi prints when a key command fails or times out. */
const KEY_RESOLUTION_FAILURE = /Failed to resolve API key .* from shell command/;

/** Sleep that ends early, without throwing, when `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

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
	/** The session's working directory; the review runs at its git root. */
	cwd: string;
	/** How to start Pi: the command plus any leading arguments. */
	pi: { command: string; args: string[] };
	exec: ExecFn;
	/** The parent's model as `provider/id`, inherited when no mapping applies. */
	parentModel?: string;
	signal?: AbortSignal;
	env?: Readonly<Record<string, string | undefined>>;
	/** Waits before each retry after a key-resolution failure; defaults to `KEY_RETRY_DELAYS_MS`. */
	keyRetryDelaysMs?: readonly number[];
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
		roleMapFrom?: RoleMapOrigin;
		root: string;
		exitCode: number;
		/** How many times the child was started; above 1 means a key-resolution retry. */
		attempts: number;
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
	return checkStringMap(name, parsed);
}

/** Check that `parsed` is an object of complete model references, or throw. */
function checkStringMap(name: string, parsed: unknown): Record<string, string> {
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

/** Where a role map was read from. */
export type RoleMapOrigin = "env" | "file";

/**
 * The settings file: `AGENT_READY_PI_CONFIG`, else `agent-ready-pi.json` in
 * Pi's configuration directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`).
 */
export function configFilePath(env: ReviewRequest["env"] = process.env): string {
	if (env?.AGENT_READY_PI_CONFIG) return resolve(env.AGENT_READY_PI_CONFIG);
	const agentDir = env?.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
	return join(agentDir, "agent-ready-pi.json");
}

/**
 * Read `roleModels` from the settings file, fresh on every call so an edit
 * applies without restarting Pi. A missing file means no role map; anything
 * else unexpected fails closed.
 */
function readRoleMapFile(path: string): Record<string, string> | undefined {
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) throw new ReviewConfigError(`settings file is not a regular file: ${path}`);
	if (stat.size > MAX_CONFIG_FILE_BYTES) throw new ReviewConfigError(`settings file is too large: ${path}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new ReviewConfigError(`settings file is not valid JSON: ${path}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ReviewConfigError(`settings file must be a JSON object: ${path}`);
	}
	for (const key of Object.keys(parsed)) {
		if (key !== "roleModels") throw new ReviewConfigError(`settings file has an unknown key ${key}: ${path}`);
	}
	const roleModels = (parsed as { roleModels?: unknown }).roleModels;
	return roleModels === undefined ? undefined : checkStringMap(`roleModels in ${path}`, roleModels);
}

/** Apply a role map's rules for one role, or throw. */
function modelFromRoleMap(name: string, roleMap: Record<string, string>, role: Role): string {
	for (const key of Object.keys(roleMap)) {
		if (!(ROLES as readonly string[]).includes(key)) {
			throw new ReviewConfigError(`${name} names an unknown role: ${key}`);
		}
	}
	const model = roleMap[role];
	if (!model) throw new ReviewConfigError(`${name} has no model for ${role}`);
	const reviewer = roleMap["adversarial-reviewer"];
	if (role === "finding-adjudicator" && reviewer && baseModel(reviewer) === baseModel(model)) {
		throw new ReviewConfigError(`finding-adjudicator must not use the adversarial-reviewer's model in ${name}`);
	}
	return model;
}

/**
 * Pick the child's model, most specific first:
 *
 * 1. A role map: `AGENT_READY_PI_ROLE_MODELS`, else `roleModels` in the
 *    settings file. It must name every role it is used for: a missing role
 *    fails closed instead of falling back, and the adjudicator may not share
 *    the adversarial reviewer's model, so it never judges its own family's
 *    findings.
 * 2. `AGENT_READY_PI_MODELS`, a JSON object keyed by the agent file's `model:`
 *    value (for example `opus`).
 * 3. The parent's model.
 */
export function resolveModel(
	role: Role,
	agentModel: string | undefined,
	parentModel: string | undefined,
	env: ReviewRequest["env"] = process.env,
): { model: string | undefined; source: ModelSource; roleMapFrom?: RoleMapOrigin } {
	const roleRaw = env?.AGENT_READY_PI_ROLE_MODELS;
	if (roleRaw) {
		const roleMap = parseStringMap("AGENT_READY_PI_ROLE_MODELS", roleRaw);
		return { model: modelFromRoleMap("AGENT_READY_PI_ROLE_MODELS", roleMap, role), source: "role", roleMapFrom: "env" };
	}
	const path = configFilePath(env);
	const fileMap = readRoleMapFile(path);
	if (fileMap) {
		return { model: modelFromRoleMap(`roleModels in ${path}`, fileMap, role), source: "role", roleMapFrom: "file" };
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

/** What a review would run, resolved without starting a child. */
export interface ReviewPlan {
	role: Role;
	/** The git root the child runs in; its reads resolve here. */
	root: string;
	agentFile: string;
	allowlist: string[];
	model: string | undefined;
	modelSource: ModelSource;
	roleMapFrom?: RoleMapOrigin;
	/** The settings file that was consulted for a role map. */
	configFile: string;
	agentBody: string;
}

/** Resolve everything a review needs. Configuration problems throw `ReviewConfigError`. */
export function planReview(request: Omit<ReviewRequest, "packet" | "pi" | "exec" | "signal">): ReviewPlan {
	const env = request.env ?? process.env;
	const agentFile = findAgentFile(request.role, request.cwd, env);
	const agent = parseAgentFile(readFileSync(agentFile, "utf8"));
	if (agent.name !== request.role) {
		throw new ReviewConfigError(`agent file ${agentFile} names ${agent.name}, not ${request.role}`);
	}
	const resolved = resolveModel(request.role, agent.model, request.parentModel, env);
	return {
		role: request.role,
		root: findProjectRoot(request.cwd),
		agentFile,
		allowlist: toPiAllowlist(agent.tools),
		model: resolved.model,
		modelSource: resolved.source,
		...(resolved.roleMapFrom ? { roleMapFrom: resolved.roleMapFrom } : {}),
		configFile: configFilePath(env),
		agentBody: agent.body,
	};
}

/**
 * Run one review. Configuration problems throw `ReviewConfigError`; a child
 * that fails, is killed or prints nothing returns `ok: false`, never a clean
 * report.
 */
export async function runReview(request: ReviewRequest): Promise<ReviewResult> {
	const env = request.env ?? process.env;
	const plan = planReview(request);
	const { agentFile, allowlist, model, modelSource } = plan;

	const scratch = mkdtempSync(join(tmpdir(), "agent-ready-pi-"));
	try {
		const systemPromptFile = join(scratch, "system-prompt.md");
		const packetFile = join(scratch, "packet.md");
		writeFileSync(systemPromptFile, plan.agentBody, { mode: 0o600 });
		writeFileSync(packetFile, request.packet, { mode: 0o600 });
		const args = [...request.pi.args, ...buildChildArgs({ allowlist, systemPromptFile, packetFile, model })];
		const delays = request.keyRetryDelaysMs ?? KEY_RETRY_DELAYS_MS;
		let attempts = 0;
		let result;
		for (;;) {
			attempts += 1;
			result = await request.exec(request.pi.command, args, {
				signal: request.signal,
				timeout: timeoutMs(env),
				cwd: plan.root,
			});
			// Only a failed key lookup is retried: it produced no review, and any other failure is real.
			const retryable = result.code !== 0 && !result.killed && KEY_RESOLUTION_FAILURE.test(result.stderr);
			const delay = delays[attempts - 1];
			if (!retryable || delay === undefined || request.signal?.aborted) break;
			await pause(delay, request.signal);
			if (request.signal?.aborted) break;
		}
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
				...(plan.roleMapFrom ? { roleMapFrom: plan.roleMapFrom } : {}),
				root: plan.root,
				exitCode: result.code,
				attempts,
				killed,
				stderr: result.stderr.slice(-4000),
				...(error ? { error } : {}),
			},
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
