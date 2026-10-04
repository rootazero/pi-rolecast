/**
 * model_resolver.ts — capability-aware resolution of role bindings to a
 * concrete provider/modelId, evaluated against the current pi model registry
 * (which reflects what the user has actually configured and what is currently
 * available in their session).
 *
 * Failures are explicit: when no candidate satisfies the role's `requires:`
 * the resolver returns `{ ok: false, reason }`. There is no silent fallback
 * to the parent model — that was the bug recorded in
 * `references/architecture-decisions.md` #4 and is the regression we are
 * avoiding here.
 */

export type ReasoningTier = "low" | "medium" | "high";
export type RequiredFeature = "thinking" | "tool_use" | "vision";
export type SpeedCostTier = "low" | "medium" | "high";

export type CapabilityRequirement = {
    /** Minimum reasoning tier; absent means no constraint. */
    reasoning_tier?: ReasoningTier;
    /** Minimum context window in tokens; absent means no constraint. */
    context_window?: number;
    /** Any-of-required feature set; absent means no constraint. */
    features?: ReadonlyArray<RequiredFeature>;
};

export type CapabilityPreference = {
    speed?: SpeedCostTier;
    cost?: SpeedCostTier;
};

/** Subset of a pi Model we need for capability matching. */
export interface ResolverModel {
    provider: string;
    id: string;
    reasoning_tier?: ReasoningTier;
    context_window?: number;
    features?: ReadonlyArray<RequiredFeature>;
    speed?: SpeedCostTier;
    cost?: SpeedCostTier;
}

/** Subset of pi ModelRegistry the resolver depends on. */
export interface ResolverRegistry {
    list(): ReadonlyArray<ResolverModel>;
    find(provider: string, id: string): ResolverModel | undefined;
    getAvailable?(): ReadonlyArray<{ provider: string; id: string }>;
}

export interface ScopedModelRef {
    provider: string;
    id: string;
}

export interface RoleBinding {
    alias: string;
    /** Ordered slash-form candidates ("provider/modelId"). Optional. */
    fallback_chain?: ReadonlyArray<string>;
}

export interface ResolveInput {
    binding: RoleBinding;
    registry: ResolverRegistry;
    /** When present and non-empty, only models in this set are eligible. */
    scopedModels?: ReadonlyArray<ScopedModelRef>;
    requires: CapabilityRequirement;
    preferences?: CapabilityPreference;
}

export interface ResolvedModel {
    provider: string;
    id: string;
    slashForm: string;
}

export type ResolveResult =
    | {
          ok: true;
          model: ResolvedModel;
          /** Where the winning model was found. */
          source: "fallback_chain" | "registry";
          /** Human-readable explanation (used in /rolecast-status). */
          reason: string;
      }
    | {
          ok: false;
          /** Human-readable explanation for the failure. */
          reason: string;
      };

/* ---------- internal helpers ---------- */

const TIER_RANK: Record<ReasoningTier, number> = { low: 1, medium: 2, high: 3 };

function meetsRequires(model: ResolverModel, requires: CapabilityRequirement): boolean {
    if (requires.reasoning_tier !== undefined) {
        if (!model.reasoning_tier) return false;
        if (TIER_RANK[model.reasoning_tier] < TIER_RANK[requires.reasoning_tier]) {
            return false;
        }
    }
    if (requires.context_window !== undefined) {
        if (!model.context_window) return false;
        if (model.context_window < requires.context_window) return false;
    }
    if (requires.features && requires.features.length > 0) {
        if (!model.features || model.features.length === 0) return false;
        for (const required of requires.features) {
            if (!model.features.includes(required)) return false;
        }
    }
    return true;
}

function meetsPreferences(model: ResolverModel, preferences: CapabilityPreference | undefined): number {
    if (!preferences) return 0;
    let score = 0;
    if (preferences.speed && model.speed === preferences.speed) score += 1;
    if (preferences.cost && model.cost === preferences.cost) score += 1;
    return score;
}

function parseSlashForm(slash: string): { provider: string; id: string } | undefined {
    const idx = slash.indexOf("/");
    if (idx <= 0 || idx === slash.length - 1) return undefined;
    return { provider: slash.slice(0, idx), id: slash.slice(idx + 1) };
}

function modelToSlash(model: ResolverModel): string {
    return `${model.provider}/${model.id}`;
}

/* ---------- main entry ---------- */

export function resolveModel(input: ResolveInput): ResolveResult {
    const { binding, registry, scopedModels, requires, preferences } = input;

    // Build the allow-set from scopedModels when provided.
    // Empty scopedModels is treated as "user has scoped to nothing" → fail closed.
    const scopedSet: Set<string> | null =
        scopedModels === undefined
            ? null
            : scopedModels.length === 0
              ? new Set<string>()
              : new Set(scopedModels.map((m) => `${m.provider}/${m.id}`));

    const isAllowed = (p: string, id: string): boolean => scopedSet === null || scopedSet.has(`${p}/${id}`);

    // Also consult registry.getAvailable() — pi computes availability from quota
    // / outages, and the resolver should not pick something the registry has
    // marked unavailable even if it is configured.
    const availableKeys = (() => {
        const list = registry.getAvailable?.();
        return list ? new Set(list.map((m) => `${m.provider}/${m.id}`)) : undefined;
    })();
    const isAvailable = (p: string, id: string): boolean =>
        availableKeys === undefined || availableKeys.has(`${p}/${id}`);

    const rejections: string[] = [];

    // 1) Walk the user-supplied fallback_chain first.
    if (binding.fallback_chain && binding.fallback_chain.length > 0) {
        for (const candidate of binding.fallback_chain) {
            const parsed = parseSlashForm(candidate);
            if (!parsed) {
                rejections.push(`${candidate}: malformed slash-form`);
                continue;
            }
            if (!isAllowed(parsed.provider, parsed.id)) {
                rejections.push(`${candidate}: not in scopedModels`);
                continue;
            }
            if (!isAvailable(parsed.provider, parsed.id)) {
                rejections.push(`${candidate}: registry reports unavailable`);
                continue;
            }
            const model = registry.find(parsed.provider, parsed.id);
            if (!model) {
                rejections.push(`${candidate}: not in registry`);
                continue;
            }
            if (!meetsRequires(model, requires)) {
                rejections.push(`${candidate}: does not satisfy requires`);
                continue;
            }
            return {
                ok: true,
                model: { provider: parsed.provider, id: parsed.id, slashForm: candidate },
                source: "fallback_chain",
                reason: `first candidate in fallback_chain that satisfies requires`,
            };
        }
    }

    // 2) Walk the full registry and rank by preference score.
    const registryCandidates: Array<{ model: ResolverModel; score: number }> = [];
    for (const model of registry.list()) {
        if (!isAllowed(model.provider, model.id)) continue;
        if (!isAvailable(model.provider, model.id)) continue;
        if (!meetsRequires(model, requires)) {
            rejections.push(modelToSlash(model) + ": does not satisfy requires");
            continue;
        }
        registryCandidates.push({ model, score: meetsPreferences(model, preferences) });
    }

    if (registryCandidates.length === 0) {
        const summary = scopedSet !== null && scopedSet.size === 0 ? "scopedModels are empty" : "no candidate satisfies all filters";
        return { ok: false, reason: `${summary}${rejections.length ? ` (${rejections.length} candidates rejected)` : ""}` };
    }

    registryCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Stable order tie-break: lexicographic on slash-form.
        return modelToSlash(a.model).localeCompare(modelToSlash(b.model));
    });

    const winner = registryCandidates[0].model;
    return {
        ok: true,
        model: { provider: winner.provider, id: winner.id, slashForm: modelToSlash(winner) },
        source: "registry",
        reason:
            registryCandidates[0].score > 0
                ? `best preference match (score=${registryCandidates[0].score}) among ${registryCandidates.length} candidates`
                : `first candidate satisfying requires among ${registryCandidates.length} (no preference set)`,
    };
}