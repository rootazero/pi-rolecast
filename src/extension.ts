/**
 * pi-rolecast — Pi extension entrypoint.
 *
 * Bridges the framework's Python CLI (scripts/) to Pi as model-callable
 * tools and slash commands. The Python scripts remain the source of truth;
 * this module only shells out.
 *
 * Provides:
 *   Tools (model-callable):
 *     - scaffolder_init     wraps `python3 scripts/scaffolder.py init`
 *     - scaffolder_validate wraps `python3 scripts/scaffolder.py validate`
 *     - scaffolder_diff     wraps `python3 scripts/scaffolder.py diff`
 *     - gate_run            wraps `python3 scripts/gate_runner.py`
 *
 *   Slash commands:
 *     - /rolecast-init      scaffold a project profile
 *     - /rolecast-validate  validate the project profile
 *     - /rolecast-diff      check for framework schema drift
 *     - /rolecast-run       run a gate phase
 *     - /rolecast-status    show the dynamic binding snapshot
 *
 *   Event hooks:
 *     - session_start: detect missing profile, load bindings cache, surface
 *       unresolvable roles
 *     - tool_call: when the Agent tool is invoked with a subagent_type that
 *       matches a cached binding, resolve a concrete model and inject it.
 *     - input: when the user types a leading `@<handle>` mention that matches
 *       a cached binding, transform it into an explicit Agent dispatch
 *       instruction so the main LLM calls the Agent tool (which then takes
 *       the tool_call path).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	dumpBindings,
	type BindingPayload,
	type DumpBindingsResult,
} from "./dump_bindings.js";
import {
	diffProfile,
	scaffoldInit,
	validateProfile,
} from "./scaffolder.js";
import {
	runGate,
	type PhaseResult,
	type RunGateResult,
} from "./gate_runner.js";
import {
	resolveModel,
	type CapabilityPreference,
	type CapabilityRequirement,
	type RequiredFeature,
	type ResolveResult,
	type ResolverModel,
	type ResolverRegistry,
} from "./model_resolver.js";

const execFileP = promisify(execFile);

// ---- Resolution ----

// dist/extension.js → ../ is the framework root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(__dirname, "..");

const SCRIPTS = join(FRAMEWORK_ROOT, "scripts");
const PYTHON = process.env.PYTHON ?? "python3";

// v0.2.0: project profile is .pi/rolecast.yaml. Legacy .pi/agent-workflow.yaml
// is still recognised for one release as a deprecation aid.
const PROFILE_FILENAMES = ["rolecast.yaml", "agent-workflow.yaml"];
const PROFILE_DIR = ".pi";

function projectProfile(cwd: string): string {
	return join(cwd, PROFILE_DIR, PROFILE_FILENAMES[0]);
}

function findProjectProfile(cwd: string): string | null {
	const dir = join(cwd, PROFILE_DIR);
	for (const name of PROFILE_FILENAMES) {
		const p = join(dir, name);
		if (existsSync(p)) return p;
	}
	return null;
}

// ---- Subprocess helper ----

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runPythonScript(
	script: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
	const cmd = PYTHON;
	const cmdArgs = [join(SCRIPTS, script), ...args];
	const cwd = options.cwd ?? process.cwd();
	const timeoutMs = options.timeoutMs ?? 120_000;

	try {
		const { stdout, stderr } = await execFileP(cmd, cmdArgs, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
		});
		return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			stdout?: string;
			stderr?: string;
			code?: number | string;
			signal?: string;
		};
		return {
			exitCode: typeof e.code === "number" ? e.code : 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? e.message ?? String(err),
		};
	}
}

function summarize(result: RunResult, maxChars = 6000): string {
	const parts: string[] = [];
	if (result.stdout) parts.push(result.stdout.trim());
	if (result.stderr) parts.push(`[stderr]\n${result.stderr.trim()}`);
	const combined = parts.join("\n");
	if (combined.length <= maxChars) return combined;
	return `${combined.slice(0, maxChars)}\n... (truncated, full output in script logs)`;
}

/** Adapt a RunGateResult into the RunResult shape summarize() expects. */
function gateRunResultToRunResult(r: RunGateResult): RunResult {
	const stdout = JSON.stringify(r.summary, null, 2);
	const stderr = r.errorTail ?? "";
	return { exitCode: r.exitCode, stdout, stderr };
}

// ---- Tool: scaffolder_init ----

const scaffolderInitTool = defineTool({
	name: "scaffolder_init",
	label: "Scaffolder Init",
	description: [
		"Bootstrap a pi-rolecast profile in the current project.",
		"Auto-detects the project's language (Cargo.toml → rust, pyproject.toml → python,",
		"package.json + tsconfig.json → typescript, go.mod → go) and writes",
		".pi/rolecast.yaml from the matching template. Idempotent: refuses to overwrite",
		"an existing profile unless --force is passed.",
	].join(" "),
	promptSnippet:
		"Bootstrap .pi/rolecast.yaml in the current project by auto-detecting the language and pre-filling from a template.",
	promptGuidelines: [
		"Use scaffolder_init when the user asks to set up a workflow profile, scaffold a project, or wants the framework to write its config file.",
		"Do NOT use this to validate or diff an existing profile — use scaffolder_validate / scaffolder_diff for that.",
		"If the project has multiple language markers, pass --template to pick one; otherwise the tool errors with the list of candidates.",
	],
	parameters: Type.Object({
		template: Type.Optional(
			Type.Union(
				[
					Type.Literal("rust"),
					Type.Literal("typescript"),
					Type.Literal("python"),
					Type.Literal("go"),
					Type.Literal("blank"),
				],
				{
					description:
						"Template name. Pass this when the project has multiple language markers or to override auto-detect.",
				},
			),
		),
		force: Type.Optional(
			Type.Boolean({
				description: "Overwrite an existing .pi/rolecast.yaml if present. Default: refuse.",
			}),
		),
		dry_run: Type.Optional(
			Type.Boolean({ description: "Print what would be created without writing." }),
		),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const cwd = _ctx?.cwd ?? process.cwd();
		const r = scaffoldInit({
			projectRoot: cwd,
			frameworkRoot: FRAMEWORK_ROOT,
			template: params.template ?? null,
			blank: params.template === "blank",
			dryRun: params.dry_run === true,
			force: params.force === true,
		});
		const details = { ok: r.ok, profilePath: r.profilePath, template: r.template };
		return {
			content: [{ type: "text", text: r.message }],
			details,
		};
	},
});

// ---- Tool: scaffolder_validate ----

const scaffolderValidateTool = defineTool({
	name: "scaffolder_validate",
	label: "Scaffolder Validate",
	description: [
		"Validate the project's .pi/rolecast.yaml profile against the framework schema.",
		"Checks every binding resolves to a known alias + model + channel; rejects unknown roles,",
		"trigger collisions, missing framework_version, etc. Delegates to profile_loader.load_profile.",
	].join(" "),
	promptSnippet: "Validate the project profile against the framework schema.",
	promptGuidelines: [
		"Use scaffolder_validate after editing a profile or before running gates to catch typos early.",
		"If it reports INVALID, do NOT run gates — fix the violations first.",
	],
	parameters: Type.Object({
		profile_path: Type.Optional(
			Type.String({
				description:
					"Path to the profile YAML. Default: .pi/rolecast.yaml relative to the current working directory.",
			}),
		),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const profilePath = params.profile_path ?? findProjectProfile(_ctx?.cwd ?? process.cwd());
		if (profilePath === null) {
			return {
				content: [{ type: "text", text: "profile not found in .pi/ (rolecast.yaml or legacy agent-workflow.yaml)" }],
				details: { ok: false },
			};
		}
		const r = validateProfile({
			profilePath,
			frameworkRoot: FRAMEWORK_ROOT,
		});
		return {
			content: [{ type: "text", text: r.output }],
			details: { ok: r.ok, profilePath },
		};
	},
});

// ---- Tool: scaffolder_diff ----

const scaffolderDiffTool = defineTool({
	name: "scaffolder_diff",
	label: "Scaffolder Diff",
	description: [
		"Compare the project profile's framework_version against the current framework version",
		"and report any fields added or removed in newer framework schemas. No auto-merge —",
		"you decide what to update.",
	].join(" "),
	promptSnippet: "Check whether the project profile is out of date with the current framework schema.",
	promptGuidelines: [
		"Use scaffolder_diff after upgrading pi-rolecast to see what changed in the schema.",
		"The tool does NOT modify the profile — apply any updates manually.",
	],
	parameters: Type.Object({
		profile_path: Type.Optional(
			Type.String({
				description:
					"Path to the profile YAML. Default: .pi/rolecast.yaml relative to the current working directory.",
			}),
		),
	}),
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const profilePath = params.profile_path ?? findProjectProfile(_ctx?.cwd ?? process.cwd());
		if (profilePath === null) {
			return {
				content: [{ type: "text", text: "profile not found in .pi/ (rolecast.yaml or legacy agent-workflow.yaml)" }],
				details: { ok: false },
			};
		}
		const r = diffProfile({
			profilePath,
			frameworkRoot: FRAMEWORK_ROOT,
		});
		return {
			content: [{ type: "text", text: r.output }],
			details: { ok: r.ok, profilePath, profileVersion: r.profileVersion },
		};
	},
});

// ---- Tool: gate_run ----

const gateRunTool = defineTool({
	name: "gate_run",
	label: "Gate Run",
	description: [
		"Execute the project's gate-runner. Runs declared gate phases (compile / lint / test etc.)",
		"in order, with per-phase retry + escalation per the profile.",
		"Exit code 0 = all phases pass; 1 = a phase failed after retries; 2 = config error.",
		"Logs land under <project>/.pi/rolecast-logs/<timestamp>/.",
	].join(" "),
	promptSnippet:
		"Run the project's gate-runner to verify compilation / lint / tests after code changes.",
	promptGuidelines: [
		"Use gate_run after implementation changes that should compile or pass tests.",
		"Pass phase to run a single phase when iterating; omit to run all in order.",
		"gate_run does NOT enforce non-negotiables — those are checked by the reviewer role at diff-review time.",
	],
	parameters: Type.Object({
		profile_path: Type.Optional(
			Type.String({
				description:
					"Path to the profile YAML. Default: .pi/rolecast.yaml relative to the current working directory.",
			}),
		),
		phase: Type.Optional(
			Type.String({
				description: "Phase name to run (e.g. 'compile', 'lint', 'test'). Omit to run all phases in declared order.",
			}),
		),
		log_dir: Type.Optional(
			Type.String({
				description: "Override the default log directory (.pi/rolecast-logs/).",
			}),
		),
	}),
	async execute(_id, params, signal, _onUpdate, _ctx) {
		// 10 minute ceiling so retries don't run forever in interactive sessions.
		const ac = new AbortController();
		const handle = setTimeout(() => ac.abort(), 10 * 60_000);
		// Forward parent signal so user-cancel kills the gate runner.
		const forwardAbort = () => ac.abort();
		signal?.addEventListener("abort", forwardAbort);
		let r: RunGateResult;
		try {
			r = await runGate({
				profilePath: params.profile_path ?? projectProfile(process.cwd()),
				frameworkRoot: FRAMEWORK_ROOT,
				phase: params.phase ?? "all",
				logDir: params.log_dir ?? ".pi/rolecast-logs",
				signal: ac.signal,
			});
		} finally {
			clearTimeout(handle);
			signal?.removeEventListener("abort", forwardAbort);
		}
		const result = gateRunResultToRunResult(r);
		return {
			content: [{ type: "text", text: summarize(result) }],
			details: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
		};
	},
});

// ---- Profile detection ----

interface SessionCtx {
	cwd: string;
	ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void };
}

function profileStatus(cwd: string): { exists: boolean; path: string } {
	return { exists: existsSync(projectProfile(cwd)), path: projectProfile(cwd) };
}

// ---- Dynamic model binding (v0.3.0) ----

interface BindingsSnapshot {
	role_groups: string[];
	bindings: Record<string, BindingPayload>;
	loadError?: string;
}

// Module-level cache; populated at session_start, read by hooks.
let bindingsCache: BindingsSnapshot | null = null;
let bindingsCacheCwd: string | null = null;

function loadBindings(cwd: string): BindingsSnapshot {
	// v0.5.0: pure TS path — no python3 subprocess. dumpBindings() reads
	// .pi/rolecast.yaml directly via src/profile_loader.ts and returns the
	// snapshot synchronously. No more "ModuleNotFoundError: No module named
	// 'yaml'" traceback in the session_start warning.
	const result: DumpBindingsResult = dumpBindings({
		frameworkRoot: FRAMEWORK_ROOT,
		cwd,
	});
	return {
		role_groups: result.role_groups,
		bindings: result.bindings,
		loadError: result.loadError,
	};
}

/**
 * Adapt a pi Model into the resolver's ResolverModel shape.
 *
 * pi's Model only exposes `reasoning: boolean` — not a tier. We map:
 *   reasoning=true  → reasoning_tier="high"   (always reasoners)
 *   reasoning=false → reasoning_tier undefined  (let the resolver treat as
 *                     unknown, which means requires.reasoning_tier won't
 *                     match — but features=[thinking] still works)
 *
 * `speed` / `cost` are not available on pi's Model; we leave them absent
 * and let the resolver treat preferences as unmatchable rather than wrong.
 */
function piModelToResolverModel(m: {
	id: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	input?: ReadonlyArray<"text" | "image">;
}): ResolverModel {
	const features: RequiredFeature[] = [];
	if (m.input && m.input.includes("image")) features.push("vision");
	if (m.reasoning) features.push("thinking");
	// tool_use is implicit for chat models in pi.
	features.push("tool_use");
	return {
		provider: m.provider,
		id: m.id,
		reasoning_tier: m.reasoning ? "high" : undefined,
		context_window: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
		features,
	};
}

interface PiModelRegistryLike {
	getAll(): ReadonlyArray<{
		id: string;
		provider: string;
		reasoning?: boolean;
		contextWindow?: number;
		input?: ReadonlyArray<"text" | "image">;
	}>;
	getAvailable(): ReadonlyArray<{ id: string; provider: string }>;
	find(provider: string, id: string): { id: string; provider: string } | undefined;
}

function makeResolverRegistry(modelRegistry: PiModelRegistryLike): ResolverRegistry {
	const all = modelRegistry.getAll();
	return {
		list: () => all.map(piModelToResolverModel),
		find: (provider: string, id: string) => {
			const m = modelRegistry.find(provider, id);
			return m ? piModelToResolverModel(m) : undefined;
		},
		getAvailable: () => modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id })),
	};
}

function normaliseRequires(raw: unknown): CapabilityRequirement {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: CapabilityRequirement = {};
	if (r.reasoning_tier === "low" || r.reasoning_tier === "medium" || r.reasoning_tier === "high") {
		out.reasoning_tier = r.reasoning_tier;
	}
	if (typeof r.context_window === "number" && r.context_window > 0) {
		out.context_window = r.context_window;
	}
	if (Array.isArray(r.features)) {
		const features: RequiredFeature[] = [];
		for (const f of r.features) {
			if (f === "thinking" || f === "tool_use" || f === "vision") features.push(f);
		}
		if (features.length > 0) out.features = features;
	}
	return out;
}

function normalisePreferences(raw: unknown): CapabilityPreference {
	if (!raw || typeof raw !== "object") return {};
	const p = raw as Record<string, unknown>;
	const out: CapabilityPreference = {};
	if (p.speed === "low" || p.speed === "medium" || p.speed === "high") out.speed = p.speed;
	if (p.cost === "low" || p.cost === "medium" || p.cost === "high") out.cost = p.cost;
	return out;
}

function normaliseFallbackChain(raw: unknown): ReadonlyArray<string> {
	if (!Array.isArray(raw)) return [];
	return raw.filter((x): x is string => typeof x === "string" && x.includes("/"));
}

function resolveForRole(
	role: string,
	ctx: {
		binding: BindingPayload;
		scopedModels: ReadonlyArray<{ provider: string; id: string }>;
		registry: ResolverRegistry;
	},
): ResolveResult {
	return resolveModel({
		binding: {
			alias: ctx.binding.alias,
			fallback_chain: normaliseFallbackChain(ctx.binding.fallback_chain),
		},
		registry: ctx.registry,
		scopedModels:
			ctx.scopedModels.length === 0
				? undefined
				: ctx.scopedModels.map((m) => ({ provider: m.provider, id: m.id })),
		requires: normaliseRequires(ctx.binding.requires),
		preferences: normalisePreferences(ctx.binding.preferences),
	});
}

// Match a leading @handle mention. Mirrors pi-subagents' `[\w-]+` regex so
// we agree on what counts as a handle. Restrict to role names known to the
// cache before transforming.
const HANDLE_PATTERN = /^@([\w-]+)\s+([\s\S]+)$/;

function handleInCache(handle: string): boolean {
	return bindingsCache !== null && Object.prototype.hasOwnProperty.call(bindingsCache.bindings, handle);
}

function transformHandle(text: string): { text: string; handle?: string; rest?: string } {
	const m = HANDLE_PATTERN.exec(text);
	if (!m) return { text };
	const handle = m[1];
	const rest = m[2];
	if (!handleInCache(handle)) return { text };
	return {
		text:
			`Dispatch this task to the @${handle} role via the Agent tool (subagent_type="${handle}"). ` +
			`Do NOT answer the request yourself — the Agent tool will run it on a model bound to that role. ` +
			`Pass the user's task verbatim as the prompt.`,
		handle,
		rest,
	};
}

function snapshotForRolecast(
	cwd: string,
	scopedModels: ReadonlyArray<{ provider: string; id: string }>,
	registry: ResolverRegistry,
): string {
	const lines: string[] = [];
	lines.push(`pi-rolecast dynamic binding snapshot`);
	lines.push(`cwd: ${cwd}`);
	lines.push(`cached bindings: ${bindingsCache ? Object.keys(bindingsCache.bindings).length : 0}`);
	if (bindingsCache?.loadError) lines.push(`load error: ${bindingsCache.loadError}`);
	lines.push(`registry models: ${registry.list().length}`);
	lines.push(`scoped models: ${scopedModels.length === 0 ? "(none — all available models usable)" : scopedModels.length}`);
	lines.push("");
	if (bindingsCache === null) {
		lines.push("(bindings cache not populated — session_start may not have fired yet)");
		return lines.join("\n");
	}
	const roleNames = Object.keys(bindingsCache.bindings).sort();
	for (const role of roleNames) {
		const payload = bindingsCache.bindings[role];
		const result = resolveForRole(role, { binding: payload, scopedModels, registry });
		if (result.ok) {
			lines.push(
				`OK   ${role.padEnd(28)} -> ${result.model.slashForm.padEnd(40)} (${result.source})`,
			);
		} else {
			lines.push(`FAIL ${role.padEnd(28)} -> ${result.reason}`);
		}
	}
	return lines.join("\n");
}

// ---- Extension factory ----

export default function piRolecastExtension(pi: ExtensionAPI): void {
	// Register all four tools so the model can call them.
	pi.registerTool(scaffolderInitTool);
	pi.registerTool(scaffolderValidateTool);
	pi.registerTool(scaffolderDiffTool);
	pi.registerTool(gateRunTool);

	// Slash commands mirror the tools for direct user invocation. Names use the
// `rolecast-*` prefix (matches the package name).
	const initHandler = async (args: string, ctx: { cwd?: string; ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		// Naive parse: --template X / --blank / --force / --dry-run
		let template: string | null = null;
		let blank = false;
		let force = false;
		let dryRun = false;
		for (let i = 0; i < parts.length; i++) {
			const p = parts[i]!;
			if (p === "--template") template = parts[++i] ?? null;
			else if (p === "--blank") blank = true;
			else if (p === "--force") force = true;
			else if (p === "--dry-run") dryRun = true;
		}
		const r = scaffoldInit({
			projectRoot: ctx.cwd ?? process.cwd(),
			frameworkRoot: FRAMEWORK_ROOT,
			template,
			blank,
			force,
			dryRun,
		});
		ctx.ui.notify(r.message, r.ok ? "info" : "error");
	};
	const validateHandler = async (_args: string, ctx: { cwd?: string; ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
		const profilePath = findProjectProfile(ctx.cwd ?? process.cwd());
		if (profilePath === null) {
			ctx.ui.notify("profile not found in .pi/", "error");
			return;
		}
		const r = validateProfile({ profilePath, frameworkRoot: FRAMEWORK_ROOT });
		ctx.ui.notify(r.output, r.ok ? "info" : "error");
	};
	const diffHandler = async (_args: string, ctx: { cwd?: string; ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
		const profilePath = findProjectProfile(ctx.cwd ?? process.cwd());
		if (profilePath === null) {
			ctx.ui.notify("profile not found in .pi/", "error");
			return;
		}
		const r = diffProfile({ profilePath, frameworkRoot: FRAMEWORK_ROOT });
		ctx.ui.notify(r.output, r.ok ? "info" : "error");
	};
	const runHandler = async (args: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
		const phase = args.trim();
		// 10 minute ceiling so retries don't run forever in interactive sessions.
		const ac = new AbortController();
		const handle = setTimeout(() => ac.abort(), 10 * 60_000);
		let r: RunGateResult;
		try {
			r = await runGate({
				profilePath: findProjectProfile(process.cwd()) ?? projectProfile(process.cwd()),
				frameworkRoot: FRAMEWORK_ROOT,
				phase: phase || "all",
				logDir: ".pi/rolecast-logs",
				signal: ac.signal,
			});
		} finally {
			clearTimeout(handle);
		}
		const result = gateRunResultToRunResult(r);
		ctx.ui.notify(summarize(result, 2000), result.exitCode === 0 ? "info" : "error");
	};

	pi.registerCommand("rolecast-init", {
		description: "Bootstrap .pi/rolecast.yaml in the current project.",
		handler: initHandler,
	});

	pi.registerCommand("rolecast-validate", {
		description: "Validate the current project's profile.",
		handler: validateHandler,
	});

	pi.registerCommand("rolecast-diff", {
		description: "Check the project profile for framework schema drift.",
		handler: diffHandler,
	});

	pi.registerCommand("rolecast-run", {
		description: "Run the project's gate-runner. Usage: /rolecast-run [phase]",
		handler: runHandler,
	});

	pi.registerCommand("rolecast-status", {
		description: "Show the dynamic binding snapshot (cache + per-role resolver outcome).",
		handler: async (_args, ctx) => {
			const extCtx = ctx as unknown as SessionCtx & { modelRegistry: PiModelRegistryLike; scopedModels: ReadonlyArray<{ provider: string; id: string }> };
			const registry = makeResolverRegistry(extCtx.modelRegistry);
			const text = snapshotForRolecast(extCtx.cwd, extCtx.scopedModels, registry);
			ctx.ui.notify(text, bindingsCache?.loadError ? "warning" : "info");
		},
	});

	// ---- Event hooks ----

	// session_start: detect missing profile, load bindings cache, surface unresolvable roles.
	pi.on("session_start", async (_event, ctx) => {
		const extCtx = ctx as unknown as SessionCtx & { modelRegistry: PiModelRegistryLike; scopedModels: ReadonlyArray<{ provider: string; id: string }> };
		const status = profileStatus(extCtx.cwd);
		if (!status.exists) {
			extCtx.ui.notify(
				`pi-rolecast: no profile found at ${status.path}. Run /rolecast-init to bootstrap one.`,
				"info",
			);
		}
		// Refresh the bindings cache so hooks see the current profile state.
		bindingsCacheCwd = extCtx.cwd;
		bindingsCache = await loadBindings(extCtx.cwd);
		if (bindingsCache.loadError) {
			extCtx.ui.notify(
				`pi-rolecast: failed to load bindings (${bindingsCache.loadError}). Dynamic binding disabled this session.`,
				"warning",
			);
			return;
		}
		if (Object.keys(bindingsCache.bindings).length === 0) {
			return; // No profile or no bindings — nothing to surface.
		}
		// Walk every binding; surface any that cannot be resolved.
		const registry = makeResolverRegistry(extCtx.modelRegistry);
		const failures: string[] = [];
		for (const [role, payload] of Object.entries(bindingsCache.bindings)) {
			const result = resolveForRole(role, {
				binding: payload,
				scopedModels: extCtx.scopedModels,
				registry,
			});
			if (!result.ok) failures.push(`${role}: ${result.reason}`);
		}
		if (failures.length > 0) {
			extCtx.ui.notify(
				`pi-rolecast: ${failures.length}/${Object.keys(bindingsCache.bindings).length} role(s) unresolved:\n` +
					failures.map((s) => `  - ${s}`).join("\n") +
					"\nRun /rolecast-status for details.",
				"warning",
			);
		}
	});

	// tool_call: when the Agent tool is invoked with a subagent_type matching
	// a cached binding, resolve a concrete model and inject it as `model:`.
	pi.on("tool_call", (event, ctx) => {
		const extCtx = ctx as unknown as { modelRegistry: PiModelRegistryLike; scopedModels: ReadonlyArray<{ provider: string; id: string }> };
		// CustomToolCallEvent covers any non-built-in tool — pi-subagents'
		// "Agent" tool falls into this branch.
		const input = event.input as Record<string, unknown> | undefined;
		if (!input) return;
		if (event.toolName !== "Agent") return;
		const subagentType = input.subagent_type;
		if (typeof subagentType !== "string" || subagentType.length === 0) return;
		if (bindingsCache === null) return;
		const payload = bindingsCache.bindings[subagentType];
		if (!payload) return;
		const registry = makeResolverRegistry(extCtx.modelRegistry);
		const result = resolveForRole(subagentType, {
			binding: payload,
			scopedModels: extCtx.scopedModels,
			registry,
		});
		if (!result.ok) {
			return {
				block: true,
				reason:
					`pi-rolecast: cannot resolve a model for role '${subagentType}'. ` +
					`${result.reason}. Run /rolecast-status for details.`,
				terminate: true,
			};
		}
		// Only inject if the caller did not already pick a model.
		if (typeof input.model !== "string" || input.model.length === 0) {
			input.model = result.model.slashForm;
		}
	});

	// input: rewrite leading @handle mentions that match a cached binding
	// into an explicit Agent dispatch instruction. The main LLM then calls
	// the Agent tool, which takes the tool_call path above.
	pi.on("input", (event, _ctx) => {
		if (event.source === "extension") return; // never rewrite extension-originated input
		const t = transformHandle(event.text);
		if (!t.handle) return;
		return { action: "transform", text: t.text, images: event.images };
	});
}
