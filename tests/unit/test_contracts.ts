/**
 * tests/unit/test_contracts.ts
 *
 * v0.6.0: A1 (output-contract mechanism). Covers src/contracts.ts.
 *
 * The user chose "仅 scaffold validate" — contracts are scaffold-time
 * documentation + structural assertions, NOT runtime enforcement. So
 * checkContractPayload is exercised here as a forward-compat helper
 * (future v0.7.x may use it for soft warnings), but the only mandatory
 * hook today is validateAllContracts.
 *
 * Run with: npx tsx --test tests/unit/test_contracts.ts
 */
import { test as testApi } from "node:test";
import assert from "node:assert/strict";

import {
    ContractError,
    validateContractSchema,
    validateAllContracts,
    checkContractPayload,
} from "../../src/contracts.js";

// ─────────────────────────────────────────────────────────────────────
// validateContractSchema — happy paths
// ─────────────────────────────────────────────────────────────────────

testApi("accepts empty schema (the wildcard case)", () => {
    assert.doesNotThrow(() => validateContractSchema({}));
});

testApi("accepts minimal object schema", () => {
    assert.doesNotThrow(() => validateContractSchema({ type: "object" }));
});

testApi("accepts nested object schema with required + properties", () => {
    const schema = {
        type: "object",
        required: ["verdict"],
        properties: {
            verdict: { type: "string", enum: ["approve", "reject"] },
            findings: {
                type: "array",
                items: {
                    type: "object",
                    required: ["file", "line"],
                    properties: {
                        file: { type: "string" },
                        line: { type: "integer" },
                    },
                },
            },
        },
        additionalProperties: false,
    };
    assert.doesNotThrow(() => validateContractSchema(schema));
});

testApi("accepts schema with documentation keywords (title, description, default)", () => {
    assert.doesNotThrow(() => validateContractSchema({
        title: "review-verdict",
        description: "judge output contract",
        type: "object",
        default: {},
    }));
});

testApi("accepts schema with boolean additionalProperties", () => {
    assert.doesNotThrow(() => validateContractSchema({
        type: "object",
        additionalProperties: false,
    }));
});

// ─────────────────────────────────────────────────────────────────────
// validateContractSchema — rejection paths
// ─────────────────────────────────────────────────────────────────────

testApi("rejects non-mapping schema", () => {
    assert.throws(() => validateContractSchema("not a schema"), ContractError);
    assert.throws(() => validateContractSchema(42), ContractError);
    assert.throws(() => validateContractSchema(["a", "b"]), ContractError);
    assert.throws(() => validateContractSchema(null), ContractError);
});

testApi("rejects unsupported keyword with file-an-issue hint", () => {
    try {
        validateContractSchema({ type: "object", pattern: "^foo" });
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof ContractError);
        assert.match((e as Error).message, /unsupported keyword 'pattern'/);
        assert.match((e as Error).message, /File an issue/);
    }
});

testApi("rejects unknown type values", () => {
    assert.throws(() => validateContractSchema({ type: "frobnicate" }), ContractError);
    assert.throws(() => validateContractSchema({ type: "" }), ContractError);
});

testApi("rejects non-array required", () => {
    assert.throws(
        () => validateContractSchema({ type: "object", required: "verdict" }),
        ContractError,
    );
    assert.throws(
        () => validateContractSchema({ type: "object", required: [1, 2, 3] }),
        ContractError,
    );
});

testApi("rejects non-mapping properties", () => {
    assert.throws(
        () => validateContractSchema({ type: "object", properties: "bad" }),
        ContractError,
    );
});

testApi("rejects non-boolean-or-schema additionalProperties", () => {
    assert.throws(
        () => validateContractSchema({ type: "object", additionalProperties: "yes" }),
        ContractError,
    );
});

testApi("rejects empty enum", () => {
    assert.throws(() => validateContractSchema({ enum: [] }), ContractError);
});

testApi("rejects non-array enum", () => {
    assert.throws(() => validateContractSchema({ enum: "approve" }), ContractError);
});

testApi("rejects non-mapping items", () => {
    assert.throws(
        () => validateContractSchema({ type: "array", items: "string" }),
        ContractError,
    );
});

testApi("rejects nested schema problems with full path in error", () => {
    try {
        validateContractSchema({
            type: "object",
            properties: {
                findings: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            severity: { type: "wat" },
                        },
                    },
                },
            },
        });
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof ContractError);
        assert.match((e as Error).message, /contracts\.properties\.findings\.items\.properties\.severity\.type/);
    }
});

// ─────────────────────────────────────────────────────────────────────
// validateAllContracts — profile-level wrapper
// ─────────────────────────────────────────────────────────────────────

testApi("validateAllContracts: empty / absent contracts returns no warnings", () => {
    assert.deepEqual(validateAllContracts(undefined, new Set()).warnings, []);
    assert.deepEqual(validateAllContracts(null, new Set()).warnings, []);
    assert.deepEqual(validateAllContracts({}, new Set()).warnings, []);
});

testApi("validateAllContracts: contract for unbound role produces a warning", () => {
    const bound = new Set(["coding-judge"]);
    const contracts = {
        "coding-judge": { type: "object" },
        "coding-secretariat": { type: "object" },
    };
    const { warnings } = validateAllContracts(contracts, bound);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /contracts\.coding-secretariat/);
    assert.match(warnings[0]!, /no binding for role/);
});

testApi("validateAllContracts: malformed schema for one role fails whole call", () => {
    const bound = new Set(["coding-judge"]);
    const contracts = {
        "coding-judge": { type: "object", pattern: "no-good" },
    };
    assert.throws(
        () => validateAllContracts(contracts, bound),
        ContractError,
    );
});

testApi("validateAllContracts: contracts must be a mapping", () => {
    assert.throws(() => validateAllContracts("not a mapping", new Set()), ContractError);
    assert.throws(() => validateAllContracts(["array"], new Set()), ContractError);
});

// ─────────────────────────────────────────────────────────────────────
// checkContractPayload — forward-compat runtime helper
// ─────────────────────────────────────────────────────────────────────

testApi("checkContractPayload: happy path", () => {
    const schema = {
        type: "object",
        required: ["verdict"],
        properties: {
            verdict: { enum: ["approve", "reject"] },
        },
        additionalProperties: false,
    };
    assert.deepEqual(
        checkContractPayload(schema, { verdict: "approve" }),
        { ok: true },
    );
});

testApi("checkContractPayload: missing required field", () => {
    const schema = { type: "object", required: ["verdict"] };
    const r = checkContractPayload(schema, {});
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /missing required field 'verdict'/);
});

testApi("checkContractPayload: type mismatch", () => {
    const schema = { type: "string" };
    const r = checkContractPayload(schema, 42);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /expected type 'string'/);
});

testApi("checkContractPayload: array items validated", () => {
    const schema = { type: "array", items: { type: "integer" } };
    assert.deepEqual(checkContractPayload(schema, [1, 2, 3]), { ok: true });
    const bad = checkContractPayload(schema, [1, "two", 3]);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.reason, /\[1\]: expected type 'integer'/);
});

testApi("checkContractPayload: enum mismatch", () => {
    const schema = { enum: ["approve", "reject"] };
    const r = checkContractPayload(schema, "maybe");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not in enum/);
});

testApi("checkContractPayload: additionalProperties: false rejects extras", () => {
    const schema = {
        type: "object",
        properties: { verdict: { type: "string" } },
        additionalProperties: false,
    };
    const r = checkContractPayload(schema, { verdict: "ok", extra: "no" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /unexpected field 'extra'/);
});

testApi("checkContractPayload: integer type rejects non-integers (3.14)", () => {
    const r = checkContractPayload({ type: "integer" }, 3.14);
    assert.equal(r.ok, false);
});

testApi("checkContractPayload: integer accepts whole numbers", () => {
    assert.deepEqual(checkContractPayload({ type: "integer" }, 7), { ok: true });
    assert.deepEqual(checkContractPayload({ type: "integer" }, 0), { ok: true });
    assert.deepEqual(checkContractPayload({ type: "integer" }, -3), { ok: true });
});
