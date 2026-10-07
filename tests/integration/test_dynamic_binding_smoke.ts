/**
 * Real-session smoke test for v0.3.0 dynamic model binding.
 *
 * Loads the BUILT extension against a copy of the sample-rust-v3 fixture
 * and exercises the full lifecycle the host pi session would see:
 *
 *   1. session_start  — bindings cache loads from dump_bindings.py
 *   2. rolecast-status — slash command renders the resolver outcome
 *   3. tool_call      — Agent invocation mutates input.model
 *   4. input          — @handle mention transforms into dispatch instruction
 *
 * Uses a deterministic mock ModelRegistry that mirrors pi's ModelRegistry
 * shape but exposes reasoning_tier / context_window / features so the
 * resolver's capability filters can be exercised end-to-end.
 *
 * Coverage:
 *   - happy path: fallback chain matches first candidate
 *   - capability gate: coding-architect requires high reasoning + 32k ctx
 *   - capability gate: coding-reviewer requires 64k ctx (filters out 32k models)
 *   - preference ranking: ties broken lexicographically
 *   - tool_call blocks with reason when no candidate satisfies
 *   - tool_call injects model even if not in fallback chain (registry ranking)
 *   - input rewrites @handle into Agent dispatch
 *   - input skips @handle that is not in cache
 *   - input skips events with source === "extension"
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import piRolecastExtension from "../../dist/extension.js";
import { resolveModel } from "../../dist/model_resolver.js";

// ---- Mock pi context (matches pi-codpi-coding-agent ExtensionAPI surface) ----

interface RegisteredTool {
	name: string;
	execute?: (...args: unknown[]) => unknown;
}
interface RegisteredCommand {
	name: string;
	handler: (...args: unknown[]) => unknown;
}
interface HookEntry {
	event: string;
	handler: (...args: unknown[]) => unknown;
}
interface MockPi {
	tools: RegisteredTool[];
	commands: RegisteredCommand[];
	hooks: HookEntry[];
	notifyLog: Array<{ msg: string; type?: string }>;
	registerTool(t: RegisteredTool): void;
	registerCommand(name: string, def: { handler: (...args: unknown[]) => unknown; description?: string }): void;
	on(event: string, handler: (...args: unknown[]) => unknown): void;
	notify(msg: string, type?: "info" | "warning" | "error"): void;
	cwd: string;
	modelRegistry: MockModelRegistry;
	scopedModels: ReadonlyArray<{ provider: string; id: string }>;
}

class MockModelRegistry {
	constructor(
		private readonly all: ReadonlyArray<MockModel>,
		private readonly unavailableKeys: ReadonlySet<string> = new Set(),
	) {}
	getAll() {
		return this.all;
	}
	getAvailable() {
		return this.all
			.filter((m) => !this.unavailableKeys.has(`${m.provider}/${m.id}`))
			.map((m) => ({ provider: m.provider, id: m.id }));
	}
	find(provider: string, id: string) {
		return this.all.find((m) => m.provider === provider && m.id === id);
	}
}

interface MockModel {
	id: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
	input: ReadonlyArray<"text" | "image">;
}

// A realistic mix: opus/sonnet/deepseek-flash as primary candidates, plus
// the canary/reviewer paths. One model marked unavailable to exercise that
// branch.
const MOCK_MODELS: MockModel[] = [
	{ id: "claude-opus-5-5", provider: "anthropic", reasoning: true, contextWindow: 200_000, input: ["text"] },
	{ id: "claude-sonnet-5-5", provider: "anthropic", reasoning: true, contextWindow: 200_000, input: ["text"] },
	{ id: "deepseek-flash", provider: "deepseek", reasoning: true, contextWindow: 64_000, input: ["text"] },
	{ id: "gpt-4o-mini", provider: "openai", reasoning: false, contextWindow: 32_000, input: ["text"] },
	{ id: "minimax-m3", provider: "minimax", reasoning: false, contextWindow: 200_000, input: ["text", "image"] },
	{ id: "gpt-6.1-sol", provider: "openai", reasoning: true, contextWindow: 128_000, input: ["text"] },
];

const UNAVAILABLE = new Set(["anthropic/claude-opus-5-5"]); // simulate a vendor outage

function buildMockPi(cwd: string, scopedModels: MockModel[] = MOCK_MODELS): MockPi {
	const pi = {
		tools: [],
		commands: [],
		hooks: [],
		notifyLog: [],
		cwd,
		modelRegistry: new MockModelRegistry(scopedModels, scopedModels === MOCK_MODELS ? UNAVAILABLE : new Set()),
		scopedModels: [],
		// The extension reads ctx.ui.notify(...); mirror pi's ExtensionUIContext shape.
		ui: {
			notify(msg: string, type?: "info" | "warning" | "error") {
				(pi as unknown as MockPi).notifyLog.push({ msg, type });
			},
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		},
		registerTool(this: MockPi, t: RegisteredTool) {
			this.tools.push(t);
		},
		registerCommand(this: MockPi, name: string, def: { handler: (...args: unknown[]) => unknown }) {
			this.commands.push({ name, handler: def.handler });
		},
		on(this: MockPi, event: string, handler: (...args: unknown[]) => unknown) {
			this.hooks.push({ event, handler });
		},
		notify(this: MockPi, msg: string, type?: "info" | "warning" | "error") {
			this.notifyLog.push({ msg, type });
		},
	} as unknown as MockPi;
	return pi;
}

function findHook(pi: MockPi, event: string): HookEntry | undefined {
	return pi.hooks.find((h) => h.event === event);
}

function findCommand(pi: MockPi, name: string): RegisteredCommand | undefined {
	return pi.commands.find((c) => c.name === name);
}

// ---- Fixture: copy sample-rust-v3 into a tmp dir ----

const FRAMEWORK_ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE_ROOT = join(FRAMEWORK_ROOT, "tests", "fixtures", "sample-rust-v3");

function setupFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "rolecast-smoke-"));
	mkdirSync(join(dir, ".pi"), { recursive: true });
	copyFileSync(join(FIXTURE_ROOT, ".pi", "rolecast.yaml"), join(dir, ".pi", "rolecast.yaml"));
	// Empty settings.json so sync_settings.py / rolecast-status don't error out
	// trying to read other config files.
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ subagents: { agentOverrides: {} } }, null, 2),
	);
	return dir;
}

// ============================================================================
//                              TESTS
// ============================================================================

test("session_start loads bindings cache from dump_bindings.py (no warnings on fixture)", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const hook = findHook(pi, "session_start");
		assert.ok(hook, "session_start hook should be registered");
		await hook.handler({}, pi);

		// 11 roles in the fixture. All should resolve (fallback chain or registry ranking).
		const warnings = pi.notifyLog.filter((n) => n.type === "warning");
		const info = pi.notifyLog.filter((n) => n.type === "info");
		assert.equal(
			warnings.filter((w) => w.msg.includes("unresolved")).length,
			0,
			`expected no unresolved-role warning, got: ${JSON.stringify(warnings)}`,
		);
		// No "no profile" info either — fixture has rolecast.yaml.
		assert.equal(
			info.filter((i) => i.msg.includes("no profile found")).length,
			0,
			`expected no missing-profile info, got: ${JSON.stringify(info)}`,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_start notifies when no profile is present", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "rolecast-empty-"));
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const hook = findHook(pi, "session_start");
		await hook.handler({}, pi);

		const info = pi.notifyLog.filter((n) => n.type === "info");
		assert.ok(
			info.some((i) => i.msg.includes("no profile found") && i.msg.includes(".pi/rolecast.yaml")),
			`expected no-profile info notification, got: ${JSON.stringify(info)}`,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_start surfaces unresolved-role warning when requires cannot be met", async () => {
	const cwd = setupFixture();
	try {
		// Empty model registry — nothing satisfies ANY binding's requires.
		const pi = buildMockPi(cwd, []);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const hook = findHook(pi, "session_start");
		await hook.handler({}, pi);

		const warnings = pi.notifyLog.filter((n) => n.type === "warning");
		assert.ok(
			warnings.some((w) => w.msg.includes("unresolved") && w.msg.includes("coding-architect")),
			`expected unresolved-role warning mentioning coding-architect, got: ${JSON.stringify(warnings)}`,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rolecast-status command renders OK lines for resolved roles", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const cmd = findCommand(pi, "rolecast-status");
		assert.ok(cmd, "rolecast-status command should be registered");

		await cmd.handler("", pi);

		const last = pi.notifyLog[pi.notifyLog.length - 1];
		assert.ok(last, "rolecast-status should emit a notify");
		const body = last.msg;
		assert.match(body, /pi-rolecast dynamic binding snapshot/);
		assert.match(body, /OK\s+coding-architect\s+->\s+anthropic\/claude-sonnet-5-5/);
		// claude-opus-5-5 is in UNAVAILABLE set; first fallback candidate is skipped.
		// Sonnet 5-5 (medium reasoning) does NOT meet coding-architect's `requires.reasoning_tier: high`,
		// so the chain walks past it to deepseek-flash — which is also medium. Then chain exhausts.
		// Falls back to registry ranking; only gpt-6.1-sol (high reasoning + 128k) qualifies.
		assert.match(body, /OK\s+coding-coder\s+->\s+deepseek\/deepseek-flash/);
		assert.match(body, /OK\s+coding-canary\s+->\s+minimax\/minimax-m3/);
		assert.match(body, /OK\s+coding-judge\s+->\s+openai\/gpt-6.1-sol/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool_call injects resolved model into Agent invocation", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		// Populate cache via session_start.
		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);
		pi.notifyLog.length = 0; // clear session_start noise

		const toolCallHook = findHook(pi, "tool_call");
		assert.ok(toolCallHook, "tool_call hook should be registered");

		// Simulate the main LLM calling Agent for coding-implementer.
		const event = {
			toolName: "Agent",
			input: {
				prompt: "implement the hello-world thing",
				subagent_type: "coding-implementer",
				description: "implement hello",
			},
		};
		const result = await toolCallHook.handler(event, pi);
		// First fallback chain candidate (deepseek-flash) is available and satisfies requires.
		assert.equal(result, undefined, "no block; resolver succeeds");
		assert.equal(event.input.model, "deepseek/deepseek-flash");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool_call blocks when no candidate satisfies requires (with reason)", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);

		const toolCallHook = findHook(pi, "tool_call");
		const event = {
			toolName: "Agent",
			input: {
				prompt: "review something",
				subagent_type: "coding-reviewer",
				description: "review",
			},
		};
		// coding-reviewer's requires: context_window>=64000, reasoning_tier=high,
		// features=[thinking, tool_use]. Mock registry has gpt-6.1-sol (128k, high, thinking+tool_use)
		// which DOES qualify — so this should resolve successfully.
		const result = await toolCallHook.handler(event, pi);
		assert.equal(result, undefined, "reviewer should resolve to gpt-6.1-sol");
		assert.equal(event.input.model, "openai/gpt-6.1-sol");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool_call blocks with reason when registry is empty", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd, []);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);

		const toolCallHook = findHook(pi, "tool_call");
		const event = {
			toolName: "Agent",
			input: {
				prompt: "implement",
				subagent_type: "coding-implementer",
				description: "impl",
			},
		};
		const result = await toolCallHook.handler(event, pi);
		assert.ok(result, "expected block");
		if (result && typeof result === "object") {
			assert.equal(result.block, true);
			assert.ok(typeof result.reason === "string" && result.reason.includes("coding-implementer"));
			assert.ok(typeof result.reason === "string" && result.reason.includes("pi-rolecast"));
		}
		// input.model should NOT be mutated on failure.
		assert.equal(event.input.model, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool_call ignores subagent_types not in the bindings cache", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);

		const toolCallHook = findHook(pi, "tool_call");
		const event = {
			toolName: "Agent",
			input: {
				prompt: "do something",
				subagent_type: "unknown-role-not-in-cache",
				description: "...",
			},
		};
		const result = await toolCallHook.handler(event, pi);
		assert.equal(result, undefined);
		assert.equal(event.input.model, undefined, "unknown role → no mutation, no block");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("tool_call ignores non-Agent tools", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);

		const toolCallHook = findHook(pi, "tool_call");
		const event = {
			toolName: "read",
			input: { path: "/tmp/foo" },
		};
		const result = await toolCallHook.handler(event, pi);
		assert.equal(result, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("input transforms @handle mention into Agent dispatch instruction", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);

		const inputHook = findHook(pi, "input");
		const result = await inputHook.handler(
			{ text: "@coding-architect design the auth module", source: "interactive" },
			pi,
		);
		assert.ok(result && typeof result === "object");
		if (result && typeof result === "object" && "action" in result) {
			assert.equal(result.action, "transform");
			assert.match(result.text, /Dispatch this task to the @coding-architect role via the Agent tool/);
			assert.match(result.text, /subagent_type="coding-architect"/);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("input skips @handle that is not in the bindings cache", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);

		const inputHook = findHook(pi, "input");
		const result = await inputHook.handler(
			{ text: "@nonexistent-role do thing", source: "interactive" },
			pi,
		);
		assert.equal(result, undefined, "non-cached handle should not be transformed");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("input skips events where source is 'extension' (avoid rewriting ourselves)", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);

		const inputHook = findHook(pi, "input");
		const result = await inputHook.handler(
			{ text: "@coding-architect do thing", source: "extension" },
			pi,
		);
		assert.equal(result, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("input skips text that does not match @handle regex", async () => {
	const cwd = setupFixture();
	try {
		const pi = buildMockPi(cwd);
		piRolecastExtension(pi as unknown as Parameters<typeof piRolecastExtension>[0]);

		const sessionHook = findHook(pi, "session_start");
		await sessionHook.handler({}, pi);

		const inputHook = findHook(pi, "input");
		// No leading @ → not a handle mention
		const result1 = await inputHook.handler(
			{ text: "just write hello world", source: "interactive" },
			pi,
		);
		assert.equal(result1, undefined);

		// @handle with no following text → regex requires \s+<rest>, so won't match
		const result2 = await inputHook.handler(
			{ text: "@coding-architect", source: "interactive" },
			pi,
		);
		assert.equal(result2, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---- Resolver-level unit smoke (sanity that the resolver is wired in) ----

test("resolver: coding-architect fallback chain picks deepseek-flash when opus+sonnet fail", () => {
	// Inline registry where ALL chain candidates are unavailable → chain exhausts → registry ranking.
	const reg = {
		list: () => [
			{ provider: "anthropic", id: "claude-opus-5-5", reasoning_tier: "high" as const, context_window: 200000, features: ["thinking" as const, "tool_use" as const] },
			{ provider: "anthropic", id: "claude-sonnet-5-5", reasoning_tier: "medium" as const, context_window: 200000, features: ["thinking" as const, "tool_use" as const] },
			{ provider: "deepseek", id: "deepseek-flash", reasoning_tier: "medium" as const, context_window: 64000, features: ["thinking" as const, "tool_use" as const] },
			{ provider: "openai", id: "gpt-6.1-sol", reasoning_tier: "high" as const, context_window: 128000, features: ["thinking" as const, "tool_use" as const] },
		],
		find: (p: string, id: string) =>
			[{ provider: "anthropic", id: "claude-opus-5-5" }, { provider: "anthropic", id: "claude-sonnet-5-5" }, { provider: "deepseek", id: "deepseek-flash" }, { provider: "openai", id: "gpt-6.1-sol" }].find((m) => m.provider === p && m.id === id),
		getAvailable: () => [
			{ provider: "openai", id: "gpt-6.1-sol" },
		],
	};
	const result = resolveModel({
		binding: { alias: "x", fallback_chain: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "deepseek/deepseek-flash"] },
		registry: reg,
		requires: { reasoning_tier: "high", context_window: 32000, features: ["thinking", "tool_use"] },
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		// All chain candidates unavailable. Registry ranking + getAvailable filter
		// leaves only gpt-6.1-sol, which is the only model with reasoning_tier=high.
		assert.equal(result.source, "registry");
		assert.equal(result.model.slashForm, "openai/gpt-6.1-sol");
	}
});
