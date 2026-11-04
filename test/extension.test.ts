import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import extension from "../extensions/review.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "agent-ready-pi-ext-"));
cpSync(join(here, "fixtures", "repo"), repo, { recursive: true });
mkdirSync(join(repo, ".git"));
after(() => rmSync(repo, { recursive: true, force: true }));

interface Registered {
	name: string;
	promptGuidelines: string[];
	execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean; details: Record<string, unknown> }>;
}

/** Load the extension against a minimal fake `pi` and return the tool plus recorded exec calls. */
function load(execResult: { stdout: string; stderr: string; code: number }) {
	let tool: Registered | undefined;
	const calls: { command: string; args: string[] }[] = [];
	const fake = {
		registerTool: (definition: Registered) => {
			tool = definition;
		},
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args });
			return execResult;
		},
	};
	extension(fake as never);
	assert.ok(tool);
	return { tool, calls };
}

const ctx = { cwd: repo, model: { provider: "anthropic", id: "parent" } };

describe("agent_ready_review tool", () => {
	it("registers under its name and routes reviewer dispatch by name", () => {
		const { tool } = load({ stdout: "", stderr: "", code: 0 });
		assert.equal(tool.name, "agent_ready_review");
		assert.ok(tool.promptGuidelines.every((line) => line.includes("agent_ready_review")));
	});

	it("returns the child's report through pi.exec", async () => {
		const { tool, calls } = load({ stdout: "Clean — ready to commit.\n", stderr: "", code: 0 });
		const result = await tool.execute("id", { role: "finding-adjudicator", packet: "p" }, undefined, undefined, ctx);
		assert.equal(result.isError, false);
		assert.equal(result.content[0]!.text, "Clean — ready to commit.");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.args.includes("--no-extensions"));
		assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--model") + 1], "anthropic/parent");
	});

	it("marks a failed child as an error, never as a clean review", async () => {
		const { tool } = load({ stdout: "", stderr: "x", code: 2 });
		const result = await tool.execute("id", { role: "shaping-reviewer", packet: "p" }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /not a clean review/);
	});

	it("marks an unknown role as an error without starting a child", async () => {
		const { tool, calls } = load({ stdout: "ok", stderr: "", code: 0 });
		const result = await tool.execute("id", { role: "implementer", packet: "p" }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.equal(calls.length, 0);
	});
});
