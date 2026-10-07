/**
 * pi-rolecast/src/contracts.ts
 *
 * v0.6.0: Output-contract mechanism (A1 in the optimization roadmap).
 *
 * Profiles can declare `contracts.<role>: <jsonSchema>`. This module
 * validates the **schema itself** at scaffold-time (`scaffolder validate`).
 * It does NOT validate role outputs at dispatch-time — per user decision,
 * contracts are scaffold-time documentation + structural assertions, not
 * runtime enforcement. Roles continue to produce freeform text.
 *
 * Why a tiny custom validator instead of pulling in ajv / jsonschema?
 *   1. v0.6.0 contracts are scaffold-time only; runtime overhead is irrelevant.
 *   2. ajv is a ~150 KB dependency with a deep API surface; pulling it in
 *      for a single scaffolding check is overkill.
 *   3. The subset we support is intentionally narrow — adding keywords
 *      later (oneOf, format, pattern, …) is opt-in and well-bounded.
 *
 * Supported keywords (the rest of JSON Schema is rejected with a clear
 * error so users don't think their fancy schema was accepted):
 *   - `type`: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
 *   - `required`: string[]   (only meaningful when type === "object")
 *   - `properties`: { [name]: subschema }
 *   - `additionalProperties`: boolean | subschema
 *   - `enum`: [scalar, …]
 *   - `items`: subschema       (only meaningful when type === "array")
 *   - `description`: string    (documentation only)
 *   - `title`: string          (documentation only)
 *   - `default`: scalar        (documentation only at this layer)
 *
 * If you need more, the error message tells you to file an issue.
 */

export class ContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContractError";
    }
}

const SCALAR_TYPES = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "null",
]);

const SUPPORTED_KEYWORDS = new Set([
    "type",
    "required",
    "properties",
    "additionalProperties",
    "enum",
    "items",
    "description",
    "title",
    "default",
]);

function isPlainObject(x: unknown): x is Record<string, unknown> {
    return !!x && typeof x === "object" && !Array.isArray(x);
}

function validateSchemaInner(
    schema: unknown,
    path: string,
): void {
    if (!isPlainObject(schema)) {
        throw new ContractError(
            `${path}: schema must be a mapping, got ${describe(schema)}`,
        );
    }
    for (const k of Object.keys(schema)) {
        if (!SUPPORTED_KEYWORDS.has(k)) {
            throw new ContractError(
                `${path}: unsupported keyword '${k}' `
                + `(supported: ${[...SUPPORTED_KEYWORDS].sort().join(", ")}). `
                + `File an issue if you need this keyword.`,
            );
        }
    }

    const typeRaw = schema["type"];
    if (typeRaw !== undefined) {
        if (typeof typeRaw !== "string") {
            throw new ContractError(
                `${path}.type must be a single type string, got ${describe(typeRaw)}`,
            );
        }
        if (typeRaw !== "object" && typeRaw !== "array" && !SCALAR_TYPES.has(typeRaw)) {
            throw new ContractError(
                `${path}.type '${typeRaw}' is not a valid JSON Schema type `
                + `(expected: object | array | string | number | integer | boolean | null)`,
            );
        }
    }

    if ("required" in schema) {
        const req = schema["required"];
        if (!Array.isArray(req) || req.some((x) => typeof x !== "string")) {
            throw new ContractError(
                `${path}.required must be a list of strings, got ${describe(req)}`,
            );
        }
    }

    if ("properties" in schema) {
        const props = schema["properties"];
        if (!isPlainObject(props)) {
            throw new ContractError(
                `${path}.properties must be a mapping, got ${describe(props)}`,
            );
        }
        for (const [k, sub] of Object.entries(props)) {
            validateSchemaInner(sub, `${path}.properties.${k}`);
        }
    }

    if ("additionalProperties" in schema) {
        const ap = schema["additionalProperties"];
        if (typeof ap === "boolean") {
            // fine
        } else if (isPlainObject(ap)) {
            validateSchemaInner(ap, `${path}.additionalProperties`);
        } else {
            throw new ContractError(
                `${path}.additionalProperties must be boolean or schema, got ${describe(ap)}`,
            );
        }
    }

    if ("enum" in schema) {
        const en = schema["enum"];
        if (!Array.isArray(en)) {
            throw new ContractError(
                `${path}.enum must be a list, got ${describe(en)}`,
            );
        }
        if (en.length === 0) {
            throw new ContractError(`${path}.enum must be non-empty`);
        }
    }

    if ("items" in schema) {
        validateSchemaInner(schema["items"], `${path}.items`);
    }

    if ("description" in schema && typeof schema["description"] !== "string") {
        throw new ContractError(`${path}.description must be a string`);
    }
    if ("title" in schema && typeof schema["title"] !== "string") {
        throw new ContractError(`${path}.title must be a string`);
    }
}

/**
 * Validate a single contract schema. Throws ContractError on any structural
 * issue. The function is recursive; `path` is the human-readable location
 * within the schema (for error messages).
 */
export function validateContractSchema(
    schema: unknown,
    path: string = "contracts",
): void {
    validateSchemaInner(schema, path);
}

/**
 * Validate every contract in a profile's `contracts` mapping. Each key
 * must be a role name from the profile's bindings (otherwise we print a
 * warning, not an error — projects may declare contracts for custom_roles
 * the validator doesn't see).
 *
 * Returns an array of warning strings for non-binding keys. Throws
 * ContractError if any schema is malformed.
 */
export function validateAllContracts(
    contracts: unknown,
    boundRoleNames: ReadonlySet<string>,
): { warnings: string[] } {
    const warnings: string[] = [];
    if (contracts === undefined || contracts === null) {
        return { warnings };
    }
    if (!isPlainObject(contracts)) {
        throw new ContractError(
            `profile.contracts must be a mapping of role-name -> schema, `
            + `got ${describe(contracts)}`,
        );
    }
    for (const [role, schema] of Object.entries(contracts)) {
        validateContractSchema(schema, `contracts.${role}`);
        if (!boundRoleNames.has(role)) {
            warnings.push(
                `contracts.${role}: no binding for role '${role}' in this profile. `
                + `If this is a custom role declared in custom_roles, this is fine; `
                + `otherwise remove the contract.`,
            );
        }
    }
    return { warnings };
}

/**
 * Best-effort runtime payload validation. NOT used by scaffold validate
 * (per user decision). Exposed for future v0.7.x soft-warning mode and
 * for tests.
 *
 * Returns `{ok: true}` if the payload structurally matches the schema,
 * `{ok: false, reason: string}` otherwise. Never throws.
 */
export function checkContractPayload(
    schema: unknown,
    payload: unknown,
    path: string = "payload",
): { ok: true } | { ok: false; reason: string } {
    try {
        validateSchemaInner(schema, "<schema>");
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!isPlainObject(schema)) {
        return { ok: false, reason: "schema must be a mapping" };
    }
    return checkPayloadInner(schema, payload, path);
}

function checkPayloadInner(
    schema: Record<string, unknown>,
    payload: unknown,
    path: string,
): { ok: true } | { ok: false; reason: string } {
    const typeRaw = schema["type"];
    if (typeof typeRaw === "string") {
        const ok = typeMatches(typeRaw, payload);
        if (!ok) {
            return {
                ok: false,
                reason: `${path}: expected type '${typeRaw}', got ${describe(payload)}`,
            };
        }
    }

    if (isPlainObject(payload)) {
        if (Array.isArray(schema["required"])) {
            for (const k of schema["required"] as string[]) {
                if (!(k in payload)) {
                    return { ok: false, reason: `${path}: missing required field '${k}'` };
                }
            }
        }
        if (isPlainObject(schema["properties"])) {
            const props = schema["properties"] as Record<string, unknown>;
            for (const [k, sub] of Object.entries(props)) {
                if (k in payload) {
                    const r = checkPayloadInner(
                        sub as Record<string, unknown>,
                        payload[k],
                        `${path}.${k}`,
                    );
                    if (!r.ok) return r;
                }
            }
        }
        const ap = schema["additionalProperties"];
        if (ap === false && isPlainObject(schema["properties"])) {
            const allowed = new Set(Object.keys(schema["properties"] as object));
            for (const k of Object.keys(payload)) {
                if (!allowed.has(k)) {
                    return {
                        ok: false,
                        reason: `${path}: unexpected field '${k}' (additionalProperties: false)`,
                    };
                }
            }
        }
    }

    if (Array.isArray(payload) && schema["items"] !== undefined) {
        const itemsSchema = schema["items"];
        if (isPlainObject(itemsSchema)) {
            for (let i = 0; i < payload.length; i++) {
                const r = checkPayloadInner(
                    itemsSchema,
                    payload[i],
                    `${path}[${i}]`,
                );
                if (!r.ok) return r;
            }
        }
    }

    if (Array.isArray(schema["enum"])) {
        const en = schema["enum"];
        if (!en.some((e) => deepEqual(e, payload))) {
            return {
                ok: false,
                reason: `${path}: value ${describe(payload)} not in enum ${describe(en)}`,
            };
        }
    }

    return { ok: true };
}

function typeMatches(type: string, payload: unknown): boolean {
    switch (type) {
        case "object": return isPlainObject(payload);
        case "array": return Array.isArray(payload);
        case "string": return typeof payload === "string";
        case "number": return typeof payload === "number" && Number.isFinite(payload);
        case "integer": return typeof payload === "number" && Number.isInteger(payload);
        case "boolean": return typeof payload === "boolean";
        case "null": return payload === null;
        default: return true; // unknown types are not enforced at payload layer
    }
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => deepEqual(v, b[i]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const ka = Object.keys(a).sort();
        const kb = Object.keys(b).sort();
        if (ka.length !== kb.length) return false;
        if (!ka.every((k, i) => k === kb[i])) return false;
        return ka.every((k) => deepEqual(a[k], b[k]));
    }
    return false;
}

function describe(x: unknown): string {
    if (x === null) return "null";
    if (Array.isArray(x)) return "array";
    const t = typeof x;
    if (t === "object") return "object";
    return `${t} (${JSON.stringify(x)})`;
}
