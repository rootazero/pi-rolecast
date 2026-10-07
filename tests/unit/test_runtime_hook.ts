/**
 * v0.6.0 — runtime tool-call enforcement hook (D1).
 *
 * Tests the pure helper `enforceRoleNarrowing` exported from
 * src/extension.ts. The helper implements:
 *   (A2) allowed_tools narrowing — block tool calls outside the role's
 *        declared whitelist.
 *   (A5) bash seatbelt — block bash commands whose payload contains any
 *        of the role's forbidden substrings.
 *
 * These tests do not exercise the actual pi `tool_call` event pipeline
 * (that is integration territory — covered by smoke tests in
 * test_extension.ts); they exercise the pure decision function in
 * isolation, which is the bulk of the new logic.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { enforceRoleNarrowing } from "../../src/extension.js";
import type { BindingPayload } from "../../src/dump_bindings.js";

function mkBinding(overrides: Partial<BindingPayload> = {}): BindingPayload {
    return {
        alias: "deepseek-verifiable",
        channels: ["official"],
        fallback_chain: [],
        requires: {},
        preferences: {},
        ...overrides,
    };
}

const emptyBindings: Record<string, BindingPayload> = {};
const noRole = null;

test("enforceRoleNarrowing: no currentRole => always allow", () => {
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "rm -rf /" } },
        emptyBindings,
        noRole,
    );
    assert.equal(d, undefined, "main session has no narrowing; bash must be allowed");
});

test("enforceRoleNarrowing: currentRole set but no allowed_tools => allow any tool", () => {
    const bindings = { "coding-architect": mkBinding() };
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "anything" } },
        bindings,
        "coding-architect",
    );
    assert.equal(d, undefined, "missing allowed_tools means no narrowing");
});

test("enforceRoleNarrowing: A2 — block tool outside allowed_tools whitelist", () => {
    const bindings = {
        "coding-notary": mkBinding({ allowed_tools: ["read", "grep", "find", "ls"] }),
    };
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "ls" } },
        bindings,
        "coding-notary",
    );
    assert.ok(d, "bash should be blocked for notary");
    assert.equal(d?.block, true);
    assert.match(d?.reason ?? "", /not allowed to call tool 'bash'/);
    assert.match(d?.reason ?? "", /coding-notary/);
});

test("enforceRoleNarrowing: A2 — allow tool inside allowed_tools whitelist", () => {
    const bindings = {
        "coding-notary": mkBinding({ allowed_tools: ["read", "grep", "find", "ls"] }),
    };
    const d = enforceRoleNarrowing(
        { toolName: "read", input: { path: "/tmp/foo" } },
        bindings,
        "coding-notary",
    );
    assert.equal(d, undefined, "read should be allowed for notary");
});

test("enforceRoleNarrowing: A2 — null allowed_tools means unrestricted", () => {
    const bindings = {
        "coding-fixer": mkBinding({ allowed_tools: null }),
    };
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "anything" } },
        bindings,
        "coding-fixer",
    );
    assert.equal(d, undefined, "null allowed_tools means no narrowing");
});

test("enforceRoleNarrowing: A5 — block bash command with forbidden substring", () => {
    const bindings = {
        "coding-coder": mkBinding({
            allowed_tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
            forbidden_bash_patterns: ["rm -rf", "git reset --hard", "git clean", "git checkout --"],
        }),
    };
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "rm -rf node_modules" } },
        bindings,
        "coding-coder",
    );
    assert.ok(d, "rm -rf should trigger the seatbelt");
    assert.match(d?.reason ?? "", /seatbelt/);
    assert.match(d?.reason ?? "", /rm -rf/);
});

test("enforceRoleNarrowing: A5 — allow bash command without forbidden substring", () => {
    const bindings = {
        "coding-coder": mkBinding({
            allowed_tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
            forbidden_bash_patterns: ["rm -rf", "git reset --hard"],
        }),
    };
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "npm test" } },
        bindings,
        "coding-coder",
    );
    assert.equal(d, undefined, "npm test is not a forbidden pattern");
});

test("enforceRoleNarrowing: A5 — alternative bash command keys (cmd, script)", () => {
    const bindings = {
        "coding-coder": mkBinding({
            allowed_tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
            forbidden_bash_patterns: ["git reset --hard"],
        }),
    };
    // Some pi versions surface the command under "cmd" or "script".
    for (const key of ["cmd", "script"]) {
        const d = enforceRoleNarrowing(
            { toolName: "bash", input: { [key]: "git reset --hard HEAD~3" } },
            bindings,
            "coding-coder",
        );
        assert.ok(d, `seatbelt should fire for ${key} key too`);
        assert.match(d?.reason ?? "", /git reset --hard/);
    }
});

test("enforceRoleNarrowing: A2 takes precedence — block even if seatbelt would allow", () => {
    // Even if bash is in the forbidden-pattern-free set, if bash isn't
    // in allowed_tools, A2 still blocks it.
    const bindings = {
        "coding-diarist": mkBinding({
            allowed_tools: ["read", "write", "edit", "grep", "find", "ls"], // no bash
            forbidden_bash_patterns: [],
        }),
    };
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "ls" } },
        bindings,
        "coding-diarist",
    );
    assert.ok(d, "bash blocked by A2 even though seatbelt is empty");
    assert.match(d?.reason ?? "", /not allowed to call tool 'bash'/);
});

test("enforceRoleNarrowing: unknown currentRole => allow (defensive)", () => {
    const bindings = { "coding-architect": mkBinding({ allowed_tools: ["bash"] }) };
    // currentRole points at a role that's not in the bindings cache.
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "ls" } },
        bindings,
        "nonexistent-role",
    );
    assert.equal(d, undefined, "unknown role => allow (defensive)");
});

test("enforceRoleNarrowing: empty allowed_tools list => block all non-Agent tools", () => {
    // An empty list is an explicit "this role may use no tools". The
    // semantic of empty list is restrictive, not permissive.
    const bindings = {
        "coding-secretariat": mkBinding({ allowed_tools: [] }),
    };
    const d = enforceRoleNarrowing(
        { toolName: "read", input: { path: "/tmp/x" } },
        bindings,
        "coding-secretariat",
    );
    assert.ok(d, "empty allow list must block every tool call");
    assert.match(d?.reason ?? "", /Allowed tools: \(none\)/);
});
