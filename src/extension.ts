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
 *     - /workflow-init      scaffold a project profile
 *     - /workflow-validate  validate the project profile
 *     - /workflow-diff      check for framework schema drift
 *     - /workflow-run       run a gate phase
 *
 *   Event hooks:
 *     - session_start: detect missing profile and notify
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
		const args = ["init"];
		if (params.template) args.push("--template", params.template);
		if (params.force) args.push("--force");
		if (params.dry_run) args.push("--dry-run");
		const result = await runPythonScript("scaffolder.py", args);
		return {
			content: [{ type: "text", text: summarize(result) }],
			details: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
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
		const args = ["validate"];
		if (params.profile_path) args.push("--profile", params.profile_path);
		const result = await runPythonScript("scaffolder.py", args);
		return {
			content: [{ type: "text", text: summarize(result) }],
			details: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
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
		const args = ["diff"];
		if (params.profile_path) args.push("--profile", params.profile_path);
		const result = await runPythonScript("scaffolder.py", args);
		return {
			content: [{ type: "text", text: summarize(result) }],
			details: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
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
	async execute(_id, params, _signal, _onUpdate, _ctx) {
		const args: string[] = [];
		if (params.profile_path) args.push("--profile", params.profile_path);
		if (params.phase) args.push("--phase", params.phase);
		if (params.log_dir) args.push("--log-dir", params.log_dir);
		// 10 minute ceiling so retries don't run forever in interactive sessions.
		const result = await runPythonScript("gate_runner.py", args, { timeoutMs: 10 * 60_000 });
		return {
			content: [{ type: "text", text: summarize(result) }],
			details: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
		};
	},
});

// ---- Profile detection ----

interface SessionCtx {
	cwd: string;
	ui: { notify: (msg: string, level?: "info" | "warn" | "error") => void };
}

function profileStatus(cwd: string): { exists: boolean; path: string } {
	return { exists: existsSync(projectProfile(cwd)), path: projectProfile(cwd) };
}

// ---- Extension factory ----

export default function piRolecastExtension(pi: ExtensionAPI): void {
	// Register all four tools so the model can call them.
	pi.registerTool(scaffolderInitTool);
	pi.registerTool(scaffolderValidateTool);
	pi.registerTool(scaffolderDiffTool);
	pi.registerTool(gateRunTool);

	// Slash commands mirror the tools for direct user invocation.
	pi.registerCommand("workflow-init", {
		description: "Bootstrap .pi/rolecast.yaml in the current project.",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const pyArgs = ["init", ...parts];
			const result = await runPythonScript("scaffolder.py", pyArgs);
			ctx.ui.notify(summarize(result, 2000), result.exitCode === 0 ? "info" : "error");
		},
	});

	pi.registerCommand("workflow-validate", {
		description: "Validate the current project's profile.",
		handler: async (_args, ctx) => {
			const result = await runPythonScript("scaffolder.py", ["validate"]);
			ctx.ui.notify(summarize(result, 2000), result.exitCode === 0 ? "info" : "error");
		},
	});

	pi.registerCommand("workflow-diff", {
		description: "Check the project profile for framework schema drift.",
		handler: async (_args, ctx) => {
			const result = await runPythonScript("scaffolder.py", ["diff"]);
			ctx.ui.notify(summarize(result, 2000), result.exitCode === 0 ? "info" : "error");
		},
	});

	pi.registerCommand("workflow-run", {
		description: "Run the project's gate-runner. Usage: /workflow-run [phase]",
		handler: async (args, ctx) => {
			const phase = args.trim();
			const pyArgs = phase ? ["--phase", phase] : [];
			const result = await runPythonScript("gate_runner.py", pyArgs, { timeoutMs: 10 * 60_000 });
			ctx.ui.notify(summarize(result, 2000), result.exitCode === 0 ? "info" : "error");
		},
	});

	// Detect missing profile on session start and surface it as a one-time hint.
	pi.on("session_start", (_event, ctx) => {
		const status = profileStatus((ctx as unknown as SessionCtx).cwd);
		if (!status.exists) {
			ctx.ui.notify(
				`pi-rolecast: no profile found at ${status.path}. Run /workflow-init to bootstrap one.`,
				"info",
			);
		}
	});
}
