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

// ────────────────────────────────────────────────────────────────────
// v0.8.0 (F2) — runtime narrowing coverage tests.
//
// The runtime narrowing (A2/A5) is exercised through the pure helper
// `enforceRoleNarrowing`, which is called by the tool_call hook in
// src/extension.ts. The module-level `currentRole` state is private
// (per extension.ts:474-483) so these tests document the contract
// the helper honours, not the dispatch machinery.
// ────────────────────────────────────────────────────────────────────

test("F2: fresh session has unrestricted currentRole", () => {
    // Before any Agent dispatch, the main session's tool calls are
    // unrestricted. This is the v0.6.0 docstring at extension.ts:474-483
    // ("The main session's own tool calls ... are unrestricted.").
    const bindings = {
        "coding-coder": mkBinding({ allowed_tools: ["bash"] }),
    };
    // currentRole === null  => the helper returns undefined regardless of
    // the bindings cache contents.
    const d = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "rm -rf /" } },
        bindings,
        null,
    );
    assert.equal(d, undefined, "fresh-session currentRole=null must allow any tool call");
});

test("F2: Agent dispatch sets currentRole to the dispatched subagent_type", () => {
    // Once the dispatcher fires a subagent, the helper should consult
    // that subagent's binding. We exercise the helper with
    // currentRole = "coding-coder" and a binding that allows bash only,
    // then verify a bash call is allowed and a read call is blocked.
    const bindings = {
        "coding-coder": mkBinding({ allowed_tools: ["bash"] }),
        "coding-judge": mkBinding({ allowed_tools: ["read", "grep"] }),
    };
    // Same dispatcher writes currentRole = "coding-coder" after a
    // successful Agent dispatch; the next tool call is checked here.
    const bashD = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "ls -la" } },
        bindings,
        "coding-coder",
    );
    assert.equal(bashD, undefined, "bash must be allowed for coding-coder");

    const readD = enforceRoleNarrowing(
        { toolName: "read", input: { path: "/tmp/x" } },
        bindings,
        "coding-coder",
    );
    assert.ok(readD, "read must be blocked for coding-coder");
    assert.match(readD?.reason ?? "", /not allowed to call tool 'read'/);
});

test("F2: sequential dispatches track the last one (parallel subagents share last role)", () => {
    // The v0.6.0 docstring at extension.ts:474-483 documents this
    // limitation explicitly: pi's extension API does not expose a
    // subagent_end event, so two back-to-back Agent dispatches leave
    // `currentRole` pointing at the second dispatched role. Parallel
    // subagents within one main-session turn inherit the LAST
    // dispatched role's restrictions.
    const bindings = {
        "coding-coder": mkBinding({ allowed_tools: ["bash"] }),
        "coding-judge": mkBinding({ allowed_tools: ["read"] }),
    };

    // First dispatch: currentRole becomes coding-coder.
    // Second dispatch: currentRole becomes coding-judge (overwrites).
    const secondRole = "coding-judge";
    const readD = enforceRoleNarrowing(
        { toolName: "read", input: { path: "/tmp/x" } },
        bindings,
        secondRole,
    );
    assert.equal(readD, undefined, "last-dispatched role (coding-judge) allows read");

    const bashD = enforceRoleNarrowing(
        { toolName: "bash", input: { command: "ls" } },
        bindings,
        secondRole,
    );
    assert.ok(bashD, "last-dispatched role (coding-judge) blocks bash");
    assert.match(bashD?.reason ?? "", /not allowed to call tool 'bash'/);
});
