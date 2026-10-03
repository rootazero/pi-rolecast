# Rust example profile

This directory contains the reference profile that reproduces the routing
decisions of the **original `rust-agent-workflow` skill** (pre-2026-10-03).

## Purpose

Users migrating from `rust-agent-workflow` should:

1. Run `scaffolder init --template rust` in their project.
2. Diff the generated profile against `examples/rust/profile.yaml`.
3. If differences exist, decide deliberately which is canonical.

This file is the **ground truth** for "what the old skill did". If your
scaffolder-generated profile diverges, file an issue.

## What this is NOT

This is not a one-click migration. The framework does not auto-migrate
profiles in v1; see `references/migration-from-rust-agent-workflow.md`.
