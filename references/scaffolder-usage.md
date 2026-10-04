# Scaffolder usage (pi-rolecast v0.2.0)

## init

```bash
python3 $SKILL_ROOT/scripts/scaffolder.py init [--template LANG] [--blank] [--dry-run] [--force]
```

Auto-detects language from project files (Cargo.toml → rust, pyproject.toml → python, package.json+tsconfig.json → typescript, go.mod → go). Multi-language projects print a list; pass `--template` to pick.

Templates ship under `<framework>/templates/{rust,typescript,python,go,blank}.yaml`. The generated profile lands at `<project>/.pi/rolecast.yaml` and includes `workflow.role_groups: [coding]` by default.

## validate

```bash
python3 $SKILL_ROOT/scripts/scaffolder.py validate --profile <path>
```

Default profile path: `.pi/rolecast.yaml`. Legacy `.pi/agent-workflow.yaml` is also accepted. Delegates to `profile_loader.load_profile`. Exit code 0 = valid, non-zero = error.

## diff

```bash
python3 $SKILL_ROOT/scripts/scaffolder.py diff --profile <path>
```

Reads `profile.framework_version` and reports fields added/removed in newer framework schemas. No auto-merge.
