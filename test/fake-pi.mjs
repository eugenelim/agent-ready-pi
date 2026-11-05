#!/usr/bin/env node
// Fake `pi`: records its argv, the prompt files' modes and contents, then
// behaves as FAKE_PI_MODE says. Used only by the tests.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const files = {};
const sp = args.indexOf("--system-prompt");
const packetArg = args.find((arg) => arg.startsWith("@"));
for (const path of [sp >= 0 ? args[sp + 1] : undefined, packetArg?.slice(1)]) {
	if (path) files[path] = { mode: statSync(path).mode & 0o777, text: readFileSync(path, "utf8") };
}
if (process.env.FAKE_PI_CAPTURE) {
	writeFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify({ args, cwd: process.cwd(), files }));
}
const mode = process.env.FAKE_PI_MODE ?? "ok";
if (mode === "fail") {
	process.stderr.write("boom\n");
	process.exit(1);
}
if (mode === "key-flaky") {
	// Fail to resolve the key until FAKE_PI_KEY_FAILURES runs have happened.
	const counter = process.env.FAKE_PI_COUNTER;
	const runs = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
	writeFileSync(counter, String(runs));
	if (runs <= Number(process.env.FAKE_PI_KEY_FAILURES ?? "1")) {
		process.stderr.write('API key auth failed for provider company: Failed to resolve API key for provider "company" from shell command: security find-generic-password -s x -w\n');
		process.exit(1);
	}
}
if (mode === "empty") process.exit(0);
if (mode === "hang") setTimeout(() => {}, 60_000);
else process.stdout.write("Clean — ready to commit.\n");
