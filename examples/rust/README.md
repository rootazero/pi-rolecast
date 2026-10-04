# Rust example profile (pi-rolecast v0.2.0)

This directory contains the reference profile for the `coding` group of
pi-rolecast v0.2.0. It reproduces the routing decisions of the original
`rust-agent-workflow` skill (pre-2026-10-03), adapted to the new
grouped-role schema.

## Purpose

Users should:

1. Run `scaffolder init --template rust` in their project.
2. Diff the generated profile against `examples/rust/profile.yaml`.
3. If differences exist, decide deliberately which is canonical.

This file is the **ground truth** for "what the coding group does for Rust projects". If your scaffolder-generated profile diverges, file an issue.

## What this is NOT

This is not a one-click migration from `rust-agent-workflow`. See
`references/migration-from-rust-agent-workflow.md` for the v0.1.x → v0.2.0
upgrade path.
