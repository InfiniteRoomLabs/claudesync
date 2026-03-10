# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This repository was created from the `InfiniteRoomLabs/template-repo` template. It comes pre-configured with Spec Kitty for structured, spec-driven development.

## First-Time Setup

If this project has no `kitty-specs/` directory yet, it hasn't been initialized for development work. **Prompt the user to run `/init` to set up the project.** Offer to brainstorm if they're still figuring out what to build.

## Spec Kitty

This repo uses **Spec Kitty** for structured development workflows.

### Workflow Phases (in order)
`specify` -> `plan` -> `tasks` -> `implement` -> `review` -> `accept` -> `merge`

Each phase has a corresponding `/spec-kitty.{phase}` command. Always run them in sequence.

### Three Mission Types
- **software-dev**: research -> design -> implement -> test -> review. TDD-first, library-first architecture.
- **research**: question -> methodology -> gather -> analyze -> synthesize -> publish. Tracks sources in CSV evidence logs.
- **documentation**: discover -> audit -> design -> generate -> validate -> publish. Follows Divio 4-type system (tutorial, how-to, reference, explanation).

### Key Directories
- `.kittify/` -- Mission definitions, templates, and scripts. Ignored by `.claudeignore` -- do not scan.
- `.claude/commands/spec-kitty.*.md` -- Agent-facing commands generated from `.kittify/` templates.
- `kitty-specs/NNN-feature-name/` -- Working artifacts for each feature (spec.md, plan.md, tasks.md, etc.).

## Agent Marketplace

This project is configured to use the Infinite Room Labs private Claude Code marketplace. Install plugins with:

```
/plugin marketplace add InfiniteRoomLabs/agent-ops
/plugin install core@infinite-room-labs
```

## Conventions

### File Encoding
**UTF-8 only.** No Windows-1252 smart quotes, em/en dashes, or copy-pasted Office characters. Use ASCII equivalents (`"` not curly quotes, `-` not em dash, `->` not arrows). Run `spec-kitty validate-encoding --feature <id>` to check, add `--fix` to auto-repair.

### Path References
Always use absolute paths or paths relative to project root. Never refer to a folder by name alone.

### Git Discipline
- Never commit agent directories (`.claude/`, `.codex/`, `.gemini/`, etc.)
- Imperative mood commit messages
- Never rewrite shared branch history
- Never commit secrets or credentials
