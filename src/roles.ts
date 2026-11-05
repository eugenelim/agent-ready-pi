/**
 * The fixed reviewer roles and the mapping from an agent file's `tools:`
 * line onto Pi's built-in tool names.
 */

/** Reviewer roles this package can run. Any other role is refused. */
export const ROLES = [
	"shaping-reviewer",
	"adversarial-reviewer",
	"finding-adjudicator",
	"security-reviewer",
	"quality-engineer",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Agent-file tool names mapped onto Pi tool names. `Edit` and `Write` are
 * deliberately absent: a reviewer never gets a write tool.
 */
const TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
	Read: ["read"],
	Grep: ["grep"],
	Glob: ["find", "ls"],
	Bash: ["bash"],
};

/** Pi tools no reviewer child may ever receive. */
export const FORBIDDEN_TOOLS: readonly string[] = ["edit", "write"];

/** Raised when a role, agent file or tool name cannot be resolved safely. */
export class ReviewConfigError extends Error {
	override name = "ReviewConfigError";
}

/** Return `value` as a known role, or throw. */
export function parseRole(value: unknown): Role {
	if (typeof value === "string" && (ROLES as readonly string[]).includes(value)) {
		return value as Role;
	}
	throw new ReviewConfigError(`unknown reviewer role: ${JSON.stringify(value)}`);
}

/** A parsed agent definition: frontmatter fields this package reads, plus the body. */
export interface AgentDefinition {
	name: string;
	tools: string[];
	model: string | undefined;
	body: string;
}

/**
 * Split an agent file into frontmatter and body. Only the flat `name:`,
 * `tools:` and `model:` keys are read; nested keys are ignored.
 */
export function parseAgentFile(text: string): AgentDefinition {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "---") throw new ReviewConfigError("agent file has no frontmatter");
	const end = lines.indexOf("---", 1);
	if (end === -1) throw new ReviewConfigError("agent file frontmatter is not closed");
	const fields = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (match) fields.set(match[1]!, match[2]!.trim());
	}
	const name = fields.get("name");
	const toolsLine = fields.get("tools");
	if (!name) throw new ReviewConfigError("agent file frontmatter has no name");
	if (!toolsLine) throw new ReviewConfigError(`agent file ${name} has no tools line`);
	const tools = toolsLine
		.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => tool.length > 0);
	const body = lines.slice(end + 1).join("\n").trim();
	if (!body) throw new ReviewConfigError(`agent file ${name} has an empty body`);
	return { name, tools, model: fields.get("model") || undefined, body };
}

/**
 * Map agent-file tool names onto a Pi `--tools` allowlist. An unknown name
 * fails closed rather than being dropped, so a widened agent file is noticed.
 */
export function toPiAllowlist(tools: readonly string[]): string[] {
	if (tools.length === 0) throw new ReviewConfigError("agent file lists no tools");
	const allowlist: string[] = [];
	for (const tool of tools) {
		const mapped = TOOL_MAP[tool];
		if (!mapped) throw new ReviewConfigError(`unsupported agent tool: ${tool}`);
		for (const piTool of mapped) if (!allowlist.includes(piTool)) allowlist.push(piTool);
	}
	for (const piTool of allowlist) {
		if (FORBIDDEN_TOOLS.includes(piTool)) throw new ReviewConfigError(`forbidden tool: ${piTool}`);
	}
	return allowlist;
}
