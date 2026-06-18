---
title: "ClaudeSync -- Skill Sync Across Claude Surfaces"
description: A git-canonical agent-Skill library that bidirectionally syncs Skills across Claude Code, the /v1/skills API, claude.ai, and Desktop/Cowork, with per-surface drift detection and indexer integration.
author: Wes Gilleland
version: 0.1.0
status: draft
date: 2026-06-17
source: "claude.ai conversation 5af90461-42ee-4df6-8272-1d8da1d91305 (\"Skill syncing across Claude platforms...\"), artifact skill-sync-design.md"
tags: [claudesync, skills, sync, drift-detection, claude-code, anthropic-api, indexer, git]
---

# ClaudeSync -- Skill Sync Across Claude Surfaces (PRD)

> Provenance note: reconciled **verbatim** against the source design doc
> `skill-sync-design.md` (claude.ai conversation `5af90461-...`; the doc's own
> header is "Idea capture / pre-design", 2026-06-11, Wes Gilleland) after fixing
> the `downloadArtifact` content-type bug that had blocked pulling it (see
> "Resolved bug" below). The upstream doc is an early idea-capture, so several
> specifics are deliberately deferred to design time; those live under Open
> Questions rather than being invented here.

---

## Executive Summary

Agent **Skills** (a `SKILL.md` + assets) live in four disconnected Claude
surfaces and do not sync between them. This PRD adds a `claudesync skills`
subsystem that treats a **git repo as the canonical store** and bidirectionally
syncs Skills to/from: Claude Code (filesystem), the Anthropic platform API
(`/v1/skills`), claude.ai (per-user zip upload, no public API), and
Desktop/Cowork. It detects per-surface drift, never auto-merges remote changes
into `main`, and indexes Skills alongside conversations so they are searchable
and cross-linkable.

Author's framing: *"skills don't sync across these different surfaces, which is
exactly what claudesync is meant to solve."*

---

## Problem / Motivation

- A Skill authored in Claude Code (`~/.claude/skills/`) has no path to the
  platform API, claude.ai, Desktop, or Cowork without manual copy/zip/upload.
- There is no single source of truth or version history for Skills; edits on one
  surface are invisible to the others.
- ClaudeSync already pulls conversations into a homelab git repo and indexes them
  -- Skills are the natural next first-class document type in that same corpus.

## Goals

1. **Canonical store.** Skills live as plain directories (`SKILL.md` + assets) in
   the existing claudesync homelab repo. Git is the source of truth and version
   history.
2. **Full CRUD on every surface that supports it.**
3. **Bidirectional sync** with drift detection in either direction.
4. **Indexer integration** -- Skills indexed like conversations (full-text over
   `SKILL.md` bodies, frontmatter as structured metadata).

## Non-Goals

- Auto-merging remote-ahead changes into `main` (always lands on a review branch).
- Treating claude.ai's unofficial upload path as stable (gated, best-effort).
- Building Skill *authoring* tooling -- this syncs Skills, it does not generate
  them.

---

## Surfaces & Adapters

| Surface | Storage | API posture |
|---|---|---|
| **Claude Code (filesystem)** | `~/.claude/skills/` (personal), `.claude/skills/` (project), plugins | Local FS. Symlink repo dirs in, or rsync-style copy with a manifest hash check. Project-scoped skills map to per-repo `.claude/skills/` via config. **MVP target.** |
| **Anthropic Platform API** | `/v1/skills` (REST; beta headers `skills-2025-10-02`, `code-execution-2025-08-25`, `files-api-2025-04-14`) | Real REST surface, workspace-wide, **first-class version semantics** -- the "remote of record" for versioned releases. Skills upload as bundles, versioned server-side; map local git tag/commit -> API version. |
| **claude.ai (web/Desktop)** | per-user zip upload via Settings > Features | **UI only -- no documented public API.** claudesync already authenticates against claude.ai internal endpoints (projects/convos); the same session likely extends to skills/capabilities endpoints. Best-effort; **gate behind `--unstable-surfaces`** (the "risky adapter"). |
| **Cowork** | TBD -- appears to consume the same surface as claude.ai / Claude Code plugins | **Investigate** whether it reads `~/.claude/skills/`, plugins, or the account surface; one of the above adapters should already cover it. |

---

## Functional Requirements

### FR-1: Canonical git store

Skills are directories under the claudesync homelab repo (e.g. `skills/<name>/`),
each `SKILL.md` + assets, versioned by git. Git is canonical; every sync is
relative to it.

### FR-2: Per-skill sync manifest

A per-skill sidecar (or one repo-level `sync-manifest.json`) tracks the canonical
content hash and per-surface sync state (verbatim from the design doc):

```json
{
  "skill": "design-prototyping-best-practices",
  "content_hash": "sha256:...",
  "surfaces": {
    "claude_code_personal": { "synced_at": "...", "hash": "..." },
    "api": { "skill_id": "sk_...", "version": 3, "synced_at": "..." },
    "claude_ai": { "uploaded_at": "...", "hash": "..." }
  }
}
```

Note the per-surface key naming: the manifest uses long keys
(`claude_code_personal` / `api` / `claude_ai`) while the CLI's `--surface` flag
uses short aliases (`code` / `api` / `web`); the adapter layer maps between them.
`api` carries `skill_id` + integer `version` (server-side versioning);
`claude_ai` records `uploaded_at` (upload-only surface).

### FR-3: Drift detection (three-way)

Compare canonical hash vs per-surface hash. Three states:

- **in-sync** -- canonical hash == surface hash.
- **local-ahead** -- canonical changed; **push** to surface.
- **remote-ahead** -- surface changed; **pull -> diff -> commit**.

### FR-4: Conflict policy

- **Git is canonical.** Remote-ahead changes land as a commit on a `sync/` branch
  for review, **never auto-merged to `main`.**
- **Frontmatter normalization on ingest.** The API enforces constraints (e.g.
  lowercase-hyphen names <= 64 chars) -- normalize once at the canonical layer so
  every surface receives a compliant bundle.

### FR-5: CLI surface (new `skills` subcommand group)

```
claudesync skills list [--surface all|code|api|web]
claudesync skills pull <name|--all> [--surface ...]
claudesync skills push <name|--all> [--surface ...]
claudesync skills status            # drift report across surfaces
claudesync skills diff <name>       # canonical vs surface
claudesync skills rm <name> [--surface ...]
claudesync skills publish <name>    # tag + push versioned release to /v1/skills
```

### FR-6: Indexer integration

Treat `skills/**/SKILL.md` as a first-class document type alongside conversation
exports: full-text over `SKILL.md` bodies, frontmatter as structured metadata.
**Cross-link:** when an indexed conversation mentions a skill by name, link to the
skill doc -- enabling "which conversations led to this skill?"

---

## MVP cut

In order (verbatim from the design doc):

1. **Filesystem adapter + manifest + `status`/`push`/`pull` for Claude Code
   personal skills.** Pure local, zero API risk, immediately useful.
2. **Indexer ingestion** of the skills directory.
3. **API adapter (`/v1/skills`)** with publish/versioning.
4. **claude.ai adapter** behind the `--unstable-surfaces` flag.

---

## Relationship to PRD 001 (remote surfaces)

Skill sync is a **second instance of the same surface-adapter pattern** and should
reuse PRD 001's seam where it fits:

- Each surface (code/api/web) is an adapter with read/write/list capabilities --
  analogous to `SourceSurface`/`SinkSurface`, but **bidirectional** (Skills push
  *and* pull, unlike conversations which are read-only from claude.ai).
- The `--unstable-surfaces` gate is **shared** with PRD 001's Class B sources.
- The drift/manifest model generalizes the `.claudesync-state.json` +
  `sync/diff.ts` logic to a multi-remote, two-way setting.

Decision needed: build skill sync as its own subsystem now, or wait for PRD 001
Phase 0's seam and model skills as bidirectional surfaces on top of it. (Leaning:
ship the filesystem MVP standalone -- it is zero-risk and immediately useful --
then refactor onto the seam when API/web adapters arrive.)

---

## Open Questions

(Verbatim from the design doc, plus the standing identity question.)

- Does Cowork read filesystem skills, plugins, or account skills? (Empirical test
  needed.)
- Does the claude.ai per-user skill surface expose list/delete via the internal
  API, or is it upload-only? (If upload-only, two-way sync to claude.ai is
  impossible without browser automation.)
- Zip bundle structure parity: does the API accept the exact same directory layout
  claude.ai's zip upload expects? (One packer, two targets, would be nice --
  verify.)
- Skill size/count limits per surface -- affects whether heavy skills (with
  scripts/assets) sync everywhere or get a "code-only" tier.
- Plugins vs bare skills for Claude Code distribution -- plugins add update
  semantics that might replace half the FS adapter.
- Skill identity across surfaces: `skill` name vs API `skill_id` -- what is the
  join key when a skill is renamed on one surface?

## Risks

- **claude.ai/Desktop adapters are ToS-exposed and brittle** -- mitigated by the
  `--unstable-surfaces` gate and best-effort posture; never on the critical path.
- **Two-way sync data-loss** -- mitigated by git-canonical + `sync/` review branch
  (no auto-merge to `main`).
- **PRD reconstructed, not verbatim** -- mitigated by pulling the real
  `skill-sync-design.md` after the downloadArtifact fix and reconciling.

## Success Metrics

- MVP: `claudesync skills status` correctly classifies in-sync / local-ahead /
  remote-ahead for Claude Code personal skills; `push`/`pull` round-trip a skill
  with hashes matching afterward.
- Indexed skills are searchable in the corpus and cross-link to the conversations
  that produced them.

## Resolved bug (downloadArtifact)

`downloadArtifact` decided text-vs-binary purely from the HTTP `content-type`
header; the wiggle `download-file` endpoint serves text files (`.md`, `.json`)
with `application/octet-stream`, so valid UTF-8 markdown came back as a
`Uint8Array` and the MCP server rendered it as `[Binary content: N bytes]` -- which
is why this artifact could not initially be pulled. **Fixed** in
`packages/core/src/client/client.ts`: decide text vs binary by explicit text
content-type, OR a known text file extension, OR a successful strict UTF-8 decode;
only genuinely binary content (images/archives/non-UTF-8) stays bytes. The MCP
server already renders strings as text, so no server change was needed. This PRD
was then reconciled against the re-pulled verbatim doc.

## References

- Design doc: `skill-sync-design.md` (claude.ai conversation `5af90461-...`,
  "Idea capture / pre-design", 2026-06-11).
- Skills overview: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- API skills guide: https://platform.claude.com/docs/en/build-with-claude/skills-guide
- Skills repo: https://github.com/anthropics/skills
- Related: PRD 001 (surface-adapter pattern, `--unstable-surfaces` gate),
  PRD 003 (OpenViking sink -- indexed skills become a `viking://` ingest source).
