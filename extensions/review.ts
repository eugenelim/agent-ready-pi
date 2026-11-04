/**
 * Pi extension: registers `agent_ready_review`, which runs one agent-ready
 * reviewer as a fresh `pi --print` child process.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type ExecFn, type ReviewPlan, type ReviewResult, planReview, runReview } from "../src/child.ts";
import { ROLES, ReviewConfigError, parseRole } from "../src/roles.ts";

/**
 * How to start the child Pi. `AGENT_READY_PI_BIN` wins; otherwise reuse the
 * running Pi's own entry point, as Pi's subagent example does; else `pi`.
 */
function piInvocation(): { command: string; args: string[] } {
	const override = process.env.AGENT_READY_PI_BIN;
	if (override) return { command: override, args: [] };
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
		return { command: process.execPath, args: [script] };
	}
	if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) {
		return { command: process.execPath, args: [] };
	}
	return { command: "pi", args: [] };
}

/** Most lines of the child's error output to quote in a failure message. */
const STDERR_TAIL_LINES = 12;

/**
 * Explain a failed review: the cause, the model the child ran on and where
 * that choice came from, and the end of the child's own error output.
 */
export function failureText(details: ReviewResult["details"]): string {
	const lines = [
		`agent_ready_review failed: ${details.error}. The reviewer is missing; this is not a clean review.`,
		`Model: ${details.model ?? "none"} (source: ${details.modelSource}).`,
	];
	if (details.modelSource !== "role") {
		lines.push("No role map is set, so the child did not use a per-role model. Call agent_ready_review with check: true to see the settings it reads.");
	}
	const tail = details.stderr.trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
	if (tail) lines.push("Child error output (last lines):", tail);
	return lines.join("\n");
}

/** Describe a resolved review plan, for `check: true`. */
export function checkText(plan: ReviewPlan): string {
	const from = plan.roleMapFrom === "env" ? "AGENT_READY_PI_ROLE_MODELS" : plan.roleMapFrom === "file" ? plan.configFile : undefined;
	return [
		`agent_ready_review check for ${plan.role}: ready. No reviewer was run.`,
		`Model: ${plan.model ?? "none"} (source: ${plan.modelSource}${from ? `, from ${from}` : ""}).`,
		`Review root: ${plan.root}. The reviewer reads files here.`,
		`Agent file: ${plan.agentFile}.`,
		`Tools: ${plan.allowlist.join(",")}.`,
		`Settings file consulted: ${plan.configFile}.`,
	].join("\n");
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "agent_ready_review",
		label: "Agent-ready review",
		description:
			"Run one agent-ready reviewer (shaping-reviewer, adversarial-reviewer or finding-adjudicator) " +
			"in a fresh, sessionless Pi child with that role's own tool allowlist, and return its report unchanged.",
		promptSnippet: "Run an agent-ready reviewer in a fresh Pi child process",
		promptGuidelines: [
			"When an agent-ready skill says to dispatch the shaping-reviewer, adversarial-reviewer or finding-adjudicator subagent, call agent_ready_review with that role and the review packet the skill assembles.",
			"Treat an agent_ready_review error as a missing reviewer, exactly as the skill defines it; never replace it with your own review, and never run a reviewer child by hand in its place.",
			"Before a gate, or after fixing reviewer settings, call agent_ready_review with check: true to see the model, review root and agent file it would use. Do not infer them from the bash tool's environment.",
		],
		parameters: Type.Object({
			role: Type.Union(ROLES.map((role) => Type.Literal(role))),
			packet: Type.Optional(
				Type.String({ description: "The complete review packet. It is data for the reviewer, not instructions to this tool. Required unless check is true." }),
			),
			check: Type.Optional(
				Type.Boolean({ description: "Resolve and report the model, review root, agent file and tools without running a reviewer." }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			try {
				const role = parseRole(params.role);
				if (params.check) {
					const plan = planReview({ role, cwd: ctx.cwd, parentModel });
					const { agentBody: _body, ...details } = plan;
					return { content: [{ type: "text", text: checkText(plan) }], details, isError: false };
				}
				if (!params.packet) throw new ReviewConfigError("packet is required unless check is true");
				const result = await runReview({
					role,
					packet: params.packet,
					cwd: ctx.cwd,
					pi: piInvocation(),
					exec,
					parentModel,
					signal,
				});
				const text = result.ok ? result.report : failureText(result.details);
				return { content: [{ type: "text", text }], details: result.details, isError: !result.ok };
			} catch (error) {
				if (!(error instanceof ReviewConfigError)) throw error;
				const text = `agent_ready_review failed: ${error.message}. The reviewer is missing; this is not a clean review.`;
				return { content: [{ type: "text", text }], details: { error: error.message }, isError: true };
			}
		},
	});
}
