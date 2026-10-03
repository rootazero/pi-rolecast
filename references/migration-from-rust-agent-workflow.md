# Migration from rust-agent-workflow

The original `rust-agent-workflow` skill is replaced by `pi-agent-workflow`. There is no runtime compatibility shim — old and new skills are different artifacts.

## Old role → new role

| Old | New |
|---|---|
| (main) | orchestrator |
| rust-architect | architect |
| contract-planner | planner |
| codemod | implementer |
| test-writer | tester |
| final-reviewer | reviewer |
| repo-mapper | mapper |
| perf-profiler | profiler |
| safety-auditor | auditor |
| relay-canary | canary |
| docs-visual | docs |

## Migration steps

```bash
# 1. Install framework
bash $SKILL_ROOT/scripts/install.sh

# 2. In each Rust project
python3 $SKILL_ROOT/scripts/scaffolder.py init --template rust

# 3. Diff against the reference
diff <(yq . <your-project>/.pi/agent-workflow.yaml) \
     <(yq . <framework>/examples/rust/profile.yaml)

# 4. Remove the old skill
rm -rf ~/.pi/agent/rust-agent-workflow

# 5. (optional) Archive the old source
mv /path/to/rust-agent-workflow /path/to/archive/
```

The reference profile at `examples/rust/profile.yaml` reproduces the effective routing of the old skill. If your generated profile differs, file an issue.
