// v0.6.0 — A2 (allowed_tools) + A3 (soul) + A5 (bash seatbelt) injection helpers.
// Unit tests against the exported pure helpers in sync_settings.ts. We do not
// spin up a synthesised framework here; integration coverage lands with the
// role-pack migration in B套.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    prependSoul,
    appendToolRestrictions,
    appendBashSeatbelt,
} from "../../src/sync_settings.js";

const ROLE_BODY_WITH_FM = `---
name: coding-reviewer
category: coding
model: deepseek-flash
---

# Reviewer

You are the merge gate.
`;

const ROLE_BODY_NO_FM = `# Reviewer\n\nYou are the merge gate.\n`;

test("prependSoul: inserts soul block right after frontmatter", () => {
    const out = prependSoul(ROLE_BODY_WITH_FM, "## Generic law\n\nNo auto-retry.");
    // The closing --- of frontmatter is still the last thing before the soul.
    const fmEnd = out.indexOf("model: deepseek-flash\n---\n");
    assert.ok(fmEnd >= 0, "frontmatter block must be present");
    const afterFm = out.slice(fmEnd);
    assert.ok(afterFm.includes("<!-- ▼ soul (v0.6.0)"), "soul divider must follow frontmatter");
    assert.ok(afterFm.includes("No auto-retry."), "soul content must be present");
    assert.ok(afterFm.includes("<!-- ▲ end soul -->"), "soul closing marker must be present");
    // Role body must still be there, after the soul.
    const soulEndIdx = afterFm.indexOf("<!-- ▲ end soul -->");
    const afterSoul = afterFm.slice(soulEndIdx);
    assert.ok(afterSoul.includes("# Reviewer"), "role body must follow the soul");
});

test("prependSoul: handles role body without frontmatter", () => {
    const out = prependSoul(ROLE_BODY_NO_FM, "## Generic law");
    assert.ok(out.includes("<!-- ▼ soul"), "soul divider must be present");
    assert.ok(out.includes("## Generic law"), "soul content must be present");
    assert.ok(out.includes("# Reviewer"), "role body must still be there");
    // Soul must appear before the role body when there is no frontmatter.
    assert.ok(out.indexOf("<!-- ▼ soul") < out.indexOf("# Reviewer"), "soul must precede role body");
});

test("appendToolRestrictions: writes block when tools listed", () => {
    const out = appendToolRestrictions("body\n", ["read", "bash"]);
    assert.ok(out.includes("## Tool restrictions (v0.6.0)"));
    assert.ok(out.includes("read"));
    assert.ok(out.includes("bash"));
    assert.ok(out.includes("framework does not enforce"));
});

test("appendToolRestrictions: no block when null", () => {
    const out = appendToolRestrictions("body\n", null);
    assert.equal(out, "body\n");
});

test("appendToolRestrictions: no block when empty", () => {
    const out = appendToolRestrictions("body\n", []);
    assert.equal(out, "body\n");
});

test("appendBashSeatbelt: writes block listing each pattern", () => {
    const out = appendBashSeatbelt("body\n", ["rm -rf", "git reset --hard"]);
    assert.ok(out.includes("## Bash seatbelt (v0.6.0)"));
    assert.ok(out.includes("rm -rf"));
    assert.ok(out.includes("git reset --hard"));
    assert.ok(out.includes("literal-substring"));
    assert.ok(out.includes("防呆不防坏"));
});

test("appendBashSeatbelt: no block when patterns empty", () => {
    const out = appendBashSeatbelt("body\n", []);
    assert.equal(out, "body\n");
});
