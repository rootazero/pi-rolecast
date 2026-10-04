/**
 * Unit tests for src/model_resolver.ts — capability-aware role binding.
 *
 * Covers: fallback_chain walking, registry ranking, scope filtering,
 * availability filtering, capability filtering, preference scoring,
 * and the fail-closed behaviour when scopedModels is explicitly empty.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	resolveModel,
	type CapabilityPreference,
	type CapabilityRequirement,
	type RequiredFeature,
	type ResolverModel,
	type ResolverRegistry,
} from "../../dist/model_resolver.js";

function mkModel(
	provider: string,
	id: string,
	overrides: Partial<ResolverModel> = {},
): ResolverModel {
	return {
		provider,
		id,
		reasoning_tier: undefined,
		context_window: undefined,
		features: ["tool_use"],
		speed: undefined,
		cost: undefined,
		...overrides,
	};
}

function mkRegistry(
	models: ResolverModel[],
	availableProviders?: Map<string, Set<string>>,
): ResolverRegistry {
	const map = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));
	return {
		list: () => models,
		find: (provider, id) => map.get(`${provider}/${id}`),
		getAvailable: availableProviders
			? () => {
					const out: Array<{ provider: string; id: string }> = [];
					for (const [provider, ids] of availableProviders) {
						for (const id of ids) out.push({ provider, id });
					}
					return out;
				}
			: undefined,
	};
}

const noPrefs: CapabilityPreference = {};
const noReqs: CapabilityRequirement = {};

// ---------- fallback_chain behaviour ----------

test("fallback_chain: returns first chain candidate that meets requires", () => {
	const reg = mkRegistry([
		mkModel("deepseek", "deepseek-flash", { context_window: 32000, features: ["thinking", "tool_use"] }),
		mkModel("openai", "gpt-4o-mini", { context_window: 16000 }),
	]);
	const result = resolveModel({
		binding: { alias: "x", fallback_chain: ["deepseek/deepseek-flash", "openai/gpt-4o-mini"] },
		registry: reg,
		requires: noReqs,
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.model.slashForm, "deepseek/deepseek-flash");
		assert.equal(result.source, "fallback_chain");
	}
});

test("fallback_chain: skips unavailable candidate, picks next", () => {
	const reg = mkRegistry(
		[
			mkModel("deepseek", "deepseek-flash"),
			mkModel("openai", "gpt-4o-mini"),
		],
		new Map([
			["deepseek", new Set()], // all deepseek unavailable
			["openai", new Set(["gpt-4o-mini"])],
		]),
	);
	const result = resolveModel({
		binding: { alias: "x", fallback_chain: ["deepseek/deepseek-flash", "openai/gpt-4o-mini"] },
		registry: reg,
		requires: noReqs,
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "openai/gpt-4o-mini");
});

test("fallback_chain: skips candidate that fails capability, picks next", () => {
	const reg = mkRegistry([
		mkModel("deepseek", "deepseek-flash", { context_window: 8000 }), // too small
		mkModel("openai", "gpt-4o-mini", { context_window: 32000 }),
	]);
	const result = resolveModel({
		binding: { alias: "x", fallback_chain: ["deepseek/deepseek-flash", "openai/gpt-4o-mini"] },
		registry: reg,
		requires: { context_window: 16000 },
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "openai/gpt-4o-mini");
});

test("fallback_chain: malformed entry is rejected, not crash", () => {
	const reg = mkRegistry([mkModel("openai", "gpt-4o-mini")]);
	const result = resolveModel({
		binding: { alias: "x", fallback_chain: ["no-slash-here", "openai/gpt-4o-mini"] },
		registry: reg,
		requires: noReqs,
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "openai/gpt-4o-mini");
});

test("fallback_chain: empty string is malformed", () => {
	const reg = mkRegistry([mkModel("openai", "gpt-4o-mini")]);
	const result = resolveModel({
		binding: { alias: "x", fallback_chain: ["", "/orphan"] },
		registry: reg,
		requires: noReqs,
	});
	// Both entries are malformed, so chain exhausts and we fall through to registry ranking.
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "openai/gpt-4o-mini");
});

// ---------- registry ranking ----------

test("registry: when fallback_chain exhausted, ranks by preference score", () => {
	const reg = mkRegistry([
		mkModel("a", "x", { speed: "low", cost: "low" }),
		mkModel("b", "y", { speed: "medium", cost: "medium" }),
		mkModel("c", "z", { speed: "medium", cost: "low" }), // matches both prefs → score 2
	]);
	const result = resolveModel({
		binding: { alias: "x" }, // no fallback_chain
		registry: reg,
		requires: noReqs,
		preferences: { speed: "medium", cost: "low" },
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "c/z");
});

test("registry: stable tie-break on lexicographic slash-form when scores equal", () => {
	const reg = mkRegistry([
		mkModel("zeta", "z"),
		mkModel("alpha", "a"),
		mkModel("beta", "b"),
	]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: noReqs,
		// No preferences → all score 0 → tie-break lexicographic.
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "alpha/a");
});

test("registry: source reports best-preference vs no-preference reasons", () => {
	const reg = mkRegistry([mkModel("a", "x", { speed: "low" })]);
	const noPref = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: noReqs,
	});
	const withPref = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: noReqs,
		preferences: { speed: "low" },
	});
	if (noPref.ok) assert.match(noPref.reason, /no preference set/);
	if (withPref.ok) assert.match(withPref.reason, /best preference match/);
});

// ---------- capability filtering ----------

test("requires.reasoning_tier: rejects model below the floor", () => {
	const reg = mkRegistry([
		mkModel("a", "x", { reasoning_tier: "low" }),
		mkModel("b", "y", { reasoning_tier: "medium" }),
	]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: { reasoning_tier: "high" },
	});
	assert.equal(result.ok, false);
});

test("requires.reasoning_tier: accepts model at or above the floor", () => {
	const reg = mkRegistry([
		mkModel("a", "x", { reasoning_tier: "high" }),
		mkModel("b", "y", { reasoning_tier: "medium" }),
	]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: { reasoning_tier: "medium" },
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "a/x"); // lex order tie-break
});

test("requires.features: all-of-required, any-of-model", () => {
	const reg = mkRegistry([
		mkModel("a", "x", { features: ["thinking", "tool_use", "vision"] }),
		mkModel("b", "y", { features: ["thinking", "tool_use"] }),
	]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: { features: ["thinking", "tool_use", "vision"] as ReadonlyArray<RequiredFeature> },
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "a/x");
});

// ---------- scopedModels behaviour ----------

test("scopedModels: undefined → all available models eligible", () => {
	const reg = mkRegistry([mkModel("a", "x"), mkModel("b", "y")]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		scopedModels: undefined,
		requires: noReqs,
	});
	assert.equal(result.ok, true);
});

test("scopedModels: non-empty list → restricts candidates", () => {
	const reg = mkRegistry([mkModel("a", "x"), mkModel("b", "y")]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		scopedModels: [{ provider: "b", id: "y" }],
		requires: noReqs,
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "b/y");
});

test("scopedModels: empty list → fail closed (no candidates)", () => {
	const reg = mkRegistry([mkModel("a", "x")]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		scopedModels: [],
		requires: noReqs,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /scopedModels are empty/);
});

// ---------- availability ----------

test("availability: registry.getAvailable() filters out unavailable models", () => {
	const reg = mkRegistry(
		[
			mkModel("deepseek", "deepseek-flash"),
			mkModel("openai", "gpt-4o-mini"),
		],
		new Map([["openai", new Set(["gpt-4o-mini"])]]),
	);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: noReqs,
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "openai/gpt-4o-mini");
});

// ---------- total failure ----------

test("fails with explanation when no candidate meets requires", () => {
	const reg = mkRegistry([mkModel("a", "x", { context_window: 1000 })]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: { context_window: 100_000 },
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.reason, /no candidate satisfies all filters/);
	}
});

test("fails when registry is empty", () => {
	const reg = mkRegistry([]);
	const result = resolveModel({
		binding: { alias: "x" },
		registry: reg,
		requires: noReqs,
	});
	assert.equal(result.ok, false);
});

// ---------- parseSlashForm edge cases ----------

test("fallback_chain: trailing-slash only is malformed", () => {
	const reg = mkRegistry([mkModel("a", "x")]);
	const result = resolveModel({
		binding: { alias: "x", fallback_chain: ["a/"] },
		registry: reg,
		requires: noReqs,
	});
	// Chain malformed → fall through to registry ranking → picks a/x.
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.model.slashForm, "a/x");
});
