# Scaffolder usage

## init

```bash
python3 $SKILL_ROOT/scripts/scaffolder.py init [--template LANG] [--blank] [--dry-run] [--force]
```

Auto-detects language from project files (Cargo.toml → rust, pyproject.toml → python, package.json+tsconfig.json → typescript, go.mod → go). Multi-language projects print a list; pass `--template` to pick.

Templates ship under `<framework>/templates/{rust,typescript,python,go,blank}.yaml`.

## validate

```bash
python3 $SKILL_ROOT/scripts/scaffolder.py validate --profile <path>
```

Delegates to `profile_loader.load_profile`. Exit code 0 = valid, non-zero = error.

## diff

```bash
python3 $SKILL_ROOT/scripts/scaffolder.py diff --profile <path>
```

Reads `profile.framework_version` and reports fields added/removed in newer framework schemas. No auto-merge.
