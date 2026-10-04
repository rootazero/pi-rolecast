# Migration from v0.1.x (pi-agent-workflow) to v0.2.0 (pi-rolecast)

v0.2.0 is a **breaking release**. The package is renamed from `@rootazero/pi-agent-workflow` (scoped) to `pi-rolecast` (unscoped), roles are now grouped, and role names are hyphen-prefixed.

## Summary of changes

| Area | v0.1.x | v0.2.0 |
|---|---|---|
| npm package | `@rootazero/pi-agent-workflow` | `pi-rolecast` |
| Profile filename | `.pi/agent-workflow.yaml` | `.pi/rolecast.yaml` (legacy still recognised) |
| Role source dir | `agents/<role>.md` | `role-packs/<group>/<role>.md` |
| Role name format | `architect` | `coding-architect` (full prefixed) |
| Role scope | All roles are coding | Groups: coding, video, research, ... (future) |
| Profile field `workflow.role_groups` | (did not exist) | required top-level field |
| Dispatch mention | `@architect` | `@coding-architect` |
| Agent tool subagent_type | `architect` | `coding-architect` |
| Registry user-global dir | `~/.pi/agent-workflow/` | `~/.pi/rolecast/` |
| Log directory | `.pi/agent-workflow-logs/` | `.pi/rolecast-logs/` |

## Step-by-step migration

```bash
# 1. Uninstall the old package (keeps your project profile + agent files intact)
pi uninstall npm:@rootazero/pi-agent-workflow

# 2. Install the new package
pi install npm:pi-rolecast

# 3. In each project, re-run scaffolder to regenerate the profile
cd <your-project>
python3 $SKILL_ROOT/scripts/scaffolder.py init --template <lang> --force

# 4. Rename your profile file (optional — legacy name still works)
mv .pi/agent-workflow.yaml .pi/rolecast.yaml

# 5. Re-sync project-local agent files
python3 $SKILL_ROOT/scripts/sync_settings.py
```

## Profile diff (before / after)

**Before (v0.1.x):**

```yaml
framework_version: 0.1.0
name: my-project
description: ...
gates:
  compile: {commands: [cargo check], timeout: 300}
bindings:
  architect:      {alias: opus-thinking-medium, channels: [official]}
  implementer:    {alias: deepseek-verifiable, channels: [official]}
```

**After (v0.2.0):**

```yaml
framework_version: 0.2.0
name: my-project
description: ...
workflow:
  role_groups: [coding]
gates:
  compile: {commands: [cargo check], timeout: 300}
bindings:
  coding-architect:    {alias: opus-thinking-medium, channels: [official]}
  coding-implementer:  {alias: deepseek-verifiable, channels: [official]}
```

## What if I'm coming from the original `rust-agent-workflow`?

If you started on the very first `rust-agent-workflow` skill (pre-pi-agent-workflow), see the role-name translation below. The original skill used unprefixed names; pi-agent-workflow kept them; pi-rolecast prefixes them with the group.

| Original | v0.2.0 |
|---|---|
| (main) | coding-orchestrator |
| rust-architect | coding-architect |
| contract-planner | coding-planner |
| codemod | coding-implementer |
| test-writer | coding-tester |
| final-reviewer | coding-reviewer |
| repo-mapper | coding-mapper |
| perf-profiler | coding-profiler |
| safety-auditor | coding-auditor |
| relay-canary | coding-canary |
| docs-visual | coding-docs |

## Role groups roadmap

v0.2.0 ships with the `coding` group only. Future groups planned for separate releases:

- `video` — scriptwriter, narrator-prompt, thumbnail-designer, video-editor, transcript-cleaner, caption-styler, seo-optimizer, hook-generator
- `research` — literature-reviewer, data-analyst, fact-checker, summarizer
- `design` — ux-reviewer, copywriter, asset-curator, brand-checker
- `music` — composer, lyricist, mix-engineer, mastering-engineer

To enable a group once it's installed, add it to `workflow.role_groups`. Each group ships its own aliases + bindings defaults in its templates.

## Deprecation plan

The v0.2.0 release keeps these compatibility shims for **one** release cycle (until v0.3.0):

- `.pi/agent-workflow.yaml` still loads (with a stderr hint).
- Legacy unprefixed role names in `bindings:` print a hint pointing to the new prefixed name.
- The framework symlink path `~/.pi/agent/pi-agent-workflow` is removed on install (warning printed if found).

After v0.3.0 these shims will be removed and v0.2.x profiles will be the only supported format.
