---
title: "ClaudeSync -- Remote Surfaces & rsync-style URI Transport"
description: Re-architect the hardcoded one-source/one-sink pipeline into a pluggable Location/SourceSurface/SinkSurface seam driven by an rsync/s3-style URI grammar, then extend sources to local AI-agent datastores.
author: Wes Gilleland
version: 0.1.0
status: draft
date: 2026-06-17
source: "claude.ai conversation 4119ad38-21cc-4cdd-897f-8a29e27a55e7 (\"Augmenting claudesync with remote URI archiving\"), artifact claudesync-remote-surface-design.md"
tags: [claudesync, architecture, rsync, s3, uri, surfaces, adapters, acp, claude-code, sync]
---

# ClaudeSync -- Remote Surfaces & rsync-style URI Transport (PRD)

> Source of truth: this PRD is derived verbatim from the design doc
> `claudesync-remote-surface-design.md` authored in claude.ai conversation
> `4119ad38-21cc-4cdd-897f-8a29e27a55e7`. Technical sections (interfaces, URI
> grammar, phasing, source taxonomy, CLI) are reproduced faithfully; PRD framing
> (goals, requirements, success metrics) is added around them.

---

## Executive Summary

ClaudeSync today is a **one-source, one-sink** pipeline: claude.ai web API in,
local filesystem out, both ends hardcoded across `client/`, `cli/commands/`, and
`sync/`. This PRD turns the two hardcoded ends into implementations of a single
`Location` / `SourceSurface` / `SinkSurface` interface, addressable by an
**rsync/s3-style URI grammar**, so ClaudeSync can: (a) read from many local
AI-agent datastores (Claude Code, Cursor, Aider, ...), (b) write to many sinks
(local git/files, S3/Garage, rsync) in one pass, and (c) eventually tap live
agent sessions.

**Scope discipline (load-bearing):** Phase 0 (the seam, zero behavior change) is
the only piece approved to build first. Do not implement S3/rsync transports
until the seam exists and a non-API source (`cc://`) has proven it.

**Phase 0 -- DONE** (branch `feat/surface-seam-phase0`): the
`Location`/`SourceSurface`/`SinkSurface` seam ships in
`packages/core/src/surface/` (`parseLocationUri`, `ClaudeSource` = `claude://`,
`FileSink` = `file://`, `sync()` fan-out orchestrator). The materialization was
extracted to `sync/materialize.ts` and is now shared by the legacy
`syncConversation` (so `export-all` and `projects` are behavior-preserved) and the
new `FileSink`. The `export` command parses `--output` to `file://` and dispatches
through the sink. Zero behavior change is proven by a parity test
(`surface/__tests__/seam.test.ts`) asserting seam output is byte-identical to
`syncConversation`; full suite green. **Next increment** (not a behavior change):
migrate `export-all`'s parallel scheduler and `projects` to construct surfaces
explicitly -- they already share `materializeConversation`.

**Already shipped (Phase 1, separate branch):** the `claudesync claude-code`
subcommand (branch `feat/claude-code-source`) is **Phase 1 built pragmatically
ahead of Phase 0** -- it reads `~/.claude/projects/**/*.jsonl` and writes the
canonical tree, but as a standalone command rather than behind the `cc://` source
surface. Folding it behind the seam (which now exists) is the next integration
this PRD enables.

---

## Problem / Motivation

- The **locality of the destination** is an unstated assumption living inside
  `cli/commands/export.ts` and `export-all.ts` (`--output` is just `resolve()`'d
  to a local absolute path). The architecture never exposes "where the bytes go"
  as a decision.
- The user owns conversation history scattered across many tools (Claude Code,
  Cursor, Aider, opencode, Gemini CLI, ChatGPT exports). Each is a bespoke format
  with no unifying normalization layer -- which `bundle-builder.ts`'s canonical
  tree already is, latently.
- The user wants to archive to **more than one place at once** (local git +
  homelab Garage S3) and to pull from **more than claude.ai**.

## Goals

1. Express both existing ends as one adapter interface with **zero behavior
   change** (Phase 0).
2. Add a URI grammar that selects **transport** (where bytes live) and
   **surface/format** (what the data is) as two orthogonal axes.
3. Add `cc://` and other **Class D local-datastore** sources behind the seam.
4. Support **fan-out**: one source read, N sinks written, in a single pass.
5. Add **rsync-style UX** (trailing slash, include/exclude/filter, `--delete`,
   `--dry-run`) on the local sink, then real transports (S3, rsync).
6. Align the canonical message model to **ACP** so every ACP agent maps in thin.

## Non-Goals

- Rewriting ClaudeSync as rclone. We borrow rsync's **grammar and UX, not its
  rolling-checksum block-delta protocol** -- our delta is logical, already solved
  in `sync/diff.ts`.
- Bidirectional sync / pushing conversations back up to claude.ai (ToS-risky,
  mostly not a thing). The dominant flow is API/datastore-source -> storage-sink.
- Cross-end rename detection.
- Arbitrary N-source x M-sink. Fan-out is one-source -> N-sinks only.
- First-party live scrapers for proprietary web UIs (Class C). Punt to
  `import://` archive parsers.

---

## Current State (verified against source, not memory)

```
SOURCE (hardcoded)        TRANSFORM                      SINK (hardcoded)
claude.ai web API   ->    fetch -> bundle-builder ->     local filesystem
client/  auth/            diff -> incremental sync       git-exporter.ts (git history)
                          sync/  export/                 files-mode.ts   (dir tree)
```

Keystone facts that shape the design:

- **`export/bundle-builder.ts`** already canonicalizes everything
  (`conversation.md`, `artifacts/`, `branches/<leaf>/...`) into a neutral file
  tree before anything touches disk. **This is already a wire format.** Remotes
  just need a reader/writer for it.
- **`sync/diff.ts`** already computes logical deltas at the conversation/leaf
  level. "What changed" is solved.
- **`sync/files-mode.ts` -> `replaceWithPreserve`** does stash-and-rebuild with a
  preserve list -- that list is already an inverse rsync `protect` filter.
- **`util/glob.ts`** is a zero-dep matcher (`*`, `**`, `?`, `[abc]`; no negation,
  no first-match ordering). Reusable for filter rules; needs negation + ordering
  added for rsync semantics.
- **`--format git|json|files`** is a materialization choice at the sink, NOT a
  transport choice -- the new design must preserve that distinction.

---

## The two axes (keep orthogonal)

A URI conflates two independent decisions; keep them separate or you get scheme
explosion (`git+s3://`).

- **Transport** -- where the bytes physically live (local FS, rsync/ssh, S3).
  Selected by the URI scheme/host.
- **Surface / format** -- what the data semantically is (claude.ai conversations,
  CC JSONL sessions, the canonical markdown tree, git history, json). `git` /
  `json` / `files` stay a **property of a sink** (`?format=git`), not a scheme.
  `s3://bucket/x?format=git` is legal: "materialize git history, store objects in
  S3." No `git+s3` needed.

---

## Functional Requirements

### FR-1: The `Location` / `Surface` seam (Phase 0)

Re-express the two hardcoded ends as implementations of one interface;
orchestrators take `(source, sinks, filters, opts)` instead of
`(client -> localPath)`.

```ts
// A parsed addressable endpoint.
interface Location {
  readonly uri: ParsedUri;          // { scheme, user?, host?, port?, path, query }
  readonly caps: SurfaceCaps;       // { read, write, delete, list }
}

// The neutral interchange format == what bundle-builder already emits.
type CanonicalTree = Map<string, Uint8Array | string>;  // relPath -> content

// A logical unit at a surface (a conversation, a project, a CC session).
interface ItemRef { id: string; kind: "conversation" | "project" | "session"; name: string; }

interface SourceSurface extends Location {
  list(selector: Selector, filters: FilterRules): AsyncIterable<ItemRef>;
  read(ref: ItemRef): Promise<CanonicalTree>;
}

interface SinkSurface extends Location {
  stat(ref: ItemRef): Promise<SinkState | null>;     // for diff/skip
  write(ref: ItemRef, tree: CanonicalTree, opts: ApplyOpts): Promise<ApplyResult>;
}

interface ApplyOpts {
  format: "git" | "json" | "files";
  delete: boolean;                  // mirror deletions
  dryRun: boolean;
  preserve: FilterRules;            // existing protect semantics
  authorName?: string; authorEmail?: string;
}
```

Mapping current code onto this **without changing behavior**:

- `claude://` -> `SourceSurface`. `list` wraps org/conversation listing; `read`
  wraps `fetchAndBuild` -> `bundle-builder`. Read-only.
- `file://` -> `SinkSurface` (and later `SourceSurface`). `write` is today's path:
  `replaceWithPreserve` for `files`, `exportToGit`/`appendToGit` for `git`.
  `stat` reads `.claudesync-state.json`.
- `runOrgSync` / `syncConversation` become thin orchestrators over the interface;
  the fan-out loop (FR-4) lives here.

**Acceptance:** existing CLI behavior byte-identical; the only diff is `--output
./x` is parsed to `file:///abs/x` internally and dispatched through
`SinkSurface`. No new schemes shipped. Tests green.

### FR-2: URI grammar

```
<scheme>://[user@][host][:port]/<path>[?opt=val&opt=val]

claude://me/org/<orgId>                 source: claude.ai (today's behavior)
claude://me/conversations               source: all convos for default org
cc://local/projects/<project>           source: Claude Code JSONL sessions  (Phase 1)
cc://local/projects                     source: all CC projects

# multi-platform sources (FR-5)
import://chatgpt/path/to/export.zip     source: ingest a ChatGPT account export (Class A)
import://gemini/path/to/takeout         source: ingest a Google Takeout/Gemini activity (Class A)
import://openwebui/path/to/chats.json   source: ingest an Open WebUI JSON export (Class A/D)
cursor://local/workspaces               source: read Cursor state.vscdb SQLite (Class D)
aider://local/<repo>                    source: read .aider.chat.history.md (Class D)
opencode://local/projects               source: read ~/.local/share/opencode storage (Class D)
gemini-cli://local/projects             source: read ~/.gemini/tmp/<hash>/chats JSON (Class D)

# live tap -- NOT a readable datastore, a passive interceptor (Class E)
ollama://tap/localhost:11434            mode:   logging proxy in front of Ollama
acp://tap/<agent-command>               mode:   ACP proxy, log any ACP agent's stream

# sinks
file:///abs/path?format=git             sink:   local git repo (today's --format git)
file://./relative?format=files          sink:   local dir tree
s3://garage/claude-archive?format=files sink:   Garage / S3-compatible        (Phase 3)
rsync://host/module/path                sink:   rsync daemon                   (Phase 3)
user@host:/path                         sink:   rsync-over-ssh shorthand       (Phase 3)
viking://resources/claudesync/...       sink:   OpenViking context DB (see PRD 003)
```

- `import://<platform>/<path>` is the generic **archive-ingest** source: point it
  at a file/dir a platform handed you; a per-platform parser normalizes into
  `CanonicalTree`. One scheme, pluggable parsers -- not one scheme per vendor.
- Live-datastore sources (`cursor://`, `aider://`, `cc://`) get their own schemes
  because they enumerate live state rather than ingesting a frozen file.
- **Trailing-slash semantics** (verbatim from rsync): `read src/` writes the
  *contents* of the item tree into the sink path; `read src` nests under
  `sink/<item-name>/`.
- A bare local path (no scheme) is sugar for `file://` (preserves current CLI).

### FR-3: rsync-style behaviors (Phase 2)

| rsync concept | claudesync meaning | cost |
|---|---|---|
| trailing slash (`src/` vs `src`) | "contents into DEST" vs "DEST/`<name>`/" | low |
| `--include` / `--exclude` / `--filter` (first-match-wins) | select which conversations/projects/artifacts/branches sync | low-med |
| `--delete` | mirror source deletions into sink | med (per-sink semantics) |
| `--dry-run` | plan output, no writes | low, high value |
| `protect` rule (`P`) | **already exists** as `--preserve` | done |
| rolling-checksum delta | **not needed** -- diff is logical, not byte-level | n/a |

Per-sink `--delete` semantics MUST be spelled out, not papered over with one flag:

- **`files` sink:** existing stash-and-rebuild (delete-except-preserved).
- **`git` sink:** `--delete` must **not** rewrite history -- tombstone /
  stop-tracking and commit the removal, because the git history *is* the archive.

Filter ordering is the one genuinely new matcher behavior: `matchAnyGlob` is
order-insensitive any-match; rsync filters are first-match-wins and
order-sensitive. Add `!`-negation and a rule type tag (`+`/`-`/`P`) to
`util/glob.ts`.

### FR-4: Fan-out (one source, N sinks, single read)

```ts
for await (const ref of source.list(selector, filters)) {
  const tree = await source.read(ref);
  await Promise.all(sinks.map(s => s.write(ref, tree, optsFor(s))));
}
```

Read each item from the source once; write the same `CanonicalTree` to every
sink. Arbitrary N-source x M-sink is out of scope.

### FR-5: Multi-platform sources -- taxonomy by extraction mechanism

How you get the data out -- not the brand -- determines the adapter. Four classes
(plus a live-tap mode):

- **Class A -- official batch export** (`import://<platform>/<path>`): platform
  hands you a file; adapter = a parser. Stable, ToS-clean, but whole-account,
  manual, no incremental, often lossy. ChatGPT (`conversations.json` zip, link
  expires ~24h, memory/custom-instructions excluded), Gemini (Google Takeout,
  activity-shaped, ~18mo retention), Open WebUI (JSON message tree).
- **Class B -- undocumented web endpoints** (what `claude://` already does):
  brittle, ToS-risky. **Gate behind `--unstable-surfaces`.** Don't lead with these.
- **Class C -- DOM/browser-extension capture** (Grok, Perplexity, DeepSeek,
  Mistral, Copilot -- no official bulk export): incompatible with a headless CLI.
  **Explicitly punt** -- "use an existing exporter extension, then feed through
  `import://`."
- **Class D -- local datastore (you own it)** <- the real win. ToS-clean, stable,
  incremental-friendly, same source-surface seam as `cc://`:
  - Claude Code -- `~/.claude/projects/**/*.jsonl` (Phase 1, partially shipped).
  - Cursor -- SQLite `state.vscdb` (`cursorDiskKV`: `composerData:<id>`,
    `bubbleId:<id>:<id>`); per-workspace `workspaceStorage/<hash>/state.vscdb` +
    `workspace.json` maps hash -> path. Copy the DB (WAL/locking) before querying.
  - Aider -- `.aider.chat.history.md` (trivial). Open WebUI -- `webui.db` SQLite.
  - opencode -- `~/.local/share/opencode/` (format drifts; check the install).
  - Gemini CLI -- `~/.gemini/tmp/<hash>/chats/` JSON (**30-day auto-cleanup -- a
    reason to archive**). VS Code AI forks (Windsurf) -- VS Code `state.vscdb`.
  - JetBrains (Junie CLI / AI Assistant / Air) -- proprietary/undocumented and
    moving; **watch, don't build readers yet** -- rely on the ACP tap.
- **Class E -- live tap / interceptor** (separate runtime, see FR-6).

**Strategic cut:** proprietary SaaS (A/B/C) are low ROI / high maintenance /
ToS-exposed -- support only as `import://` parsers, only for tools you use. The
durable extensions are **Class D** (ride Phase 1's seam) and **ACP** (FR-6).

### FR-6: ACP alignment + live tap (Class E, Phase 4)

- **ACP (Agent Client Protocol)** -- JSON-RPC 2.0 over stdio between editor/client
  and agent ("LSP for coding agents", JetBrains + Zed, Apache 2.0), already spoken
  by Claude Agent, Codex, Gemini CLI, Junie, Kiro, Cursor (adapter), Zed. A
  claudesync **ACP proxy** sits in the middle and logs a standardized session
  stream (turns, `ContentBlock`s, tool calls) for **any ACP agent at once**.
- **The keystone (nearly free if done early):** align the internal canonical
  message model to ACP's session / `ContentBlock` schema during Phase 0/1 model
  design. Then every ACP-persisted session and every ACP tap maps in with a thin
  parser, and the Phase 4 tap gets a free target shape.
- **Ollama tap:** `/api/chat` + `/api/generate` are stateless (no transcript on
  disk; `~/.ollama/history` is readline input only). Only viable capture is a
  **logging reverse-proxy** in front of `localhost:11434`. Upside: clients resend
  full history each turn, so the last request carries the whole thread.
- Build `acp://` before `ollama://` (one impl captures the whole ACP ecosystem).
- **MCP servers are a tool surface, not a history surface** -- the conversation
  lives at the driving agent, already covered. Do not build history adapters for
  MCP integrations. Likewise, build your own (e.g. Koog/JVM) agents to *emit* the
  canonical/ACP schema rather than writing readers for them.

---

## Phasing (the actual plan)

| Phase | Scope | Gate |
|---|---|---|
| **0** | The seam. Extract `Location`/`SourceSurface`/`SinkSurface`; re-express claude.ai as `claude://`, local FS as `file://`; route `--output`/`--format`/`--preserve` through it. **Zero behavior change.** | **DONE.** Byte-identical output proven by `surface/__tests__/seam.test.ts`; full suite green. `export` dispatches through the sink. |
| **1** | `cc://` Claude Code session reader -> `CanonicalTree` -> existing sink. Validates the source abstraction against a very different source, no network. **Shape the canonical message type to ACP during this phase (nearly free).** | Verify the real JSONL schema first. (Reader logic already exists in the `claude-code` subcommand -- refactor it behind `cc://`.) |
| **1.5** | Additional Class D sources as needed: `aider://` + `cursor://` first, then `opencode://`/`gemini-cli://`; `import://chatgpt` (clean export). Each an independent `SourceSurface`. | Verify each tool's on-disk format on the install first -- they drift. |
| **2** | rsync grammar on the local sink: trailing-slash, include/exclude/filter (first-match), `--delete` (per-sink), `--dry-run`. No remote transport yet. | Useful local-only. |
| **3** | Real transports: `s3://` first (Garage; request/response simpler than rsync wire), then `rsync://` / `user@host:path`. Transport-only concerns (`--bwlimit`, `--partial`, compression) land here and nowhere else. | -- |
| **4** | Live-capture mode (Class E), optional, separate runtime. `acp://` first, then `ollama://`. | Pays off only once the Phase-1 canonical model is ACP-aligned. |

---

## Target CLI surface (end-state)

```
claudesync sync <SRC-URI> <DEST-URI>... [filters] [behaviors]

# today's export-all, in the new grammar:
claudesync sync claude://me/conversations ./org-export?format=files

# fan-out to homelab object storage in the same pass:
claudesync sync claude://me/conversations \
  ./org-export?format=git \
  s3://garage/claude-archive?format=files

# archive local Claude Code sessions (Phase 1):
claudesync sync cc://local/projects ./cc-archive?format=files

# filters + dry run (Phase 2):
claudesync sync claude://me/conversations ./out \
  --include 'project:INFIN/**' --exclude '**' --delete --dry-run
```

`export` / `export-all` / `claude-code` stay as back-compat aliases that desugar
into `sync`.

---

## Open Questions

- CC JSONL schema -- exact shape, branch/leaf representation, artifact handling.
  (Largely answered by the `claude-code` subcommand build; reuse those findings.)
- Cursor `state.vscdb` read while Cursor runs -- copy DB (`-wal`/`-shm`) first;
  key patterns drift between versions (best-effort, version-tolerant parser).
- `import://` normalization -- each platform's message-tree shape (ChatGPT mapping
  graph, Open WebUI `parentId`/`childrenIds`) mapped into the message-tree model
  once per parser.
- ACP -- confirm the current `ContentBlock` / session schema; does ACP define any
  persisted on-disk form, or only the wire protocol? (Assume protocol-only.)
- ACP tap mechanics -- cleanest stdio JSON-RPC interposition (wrap agent command
  vs shim client spawn); reassembling streamed `ContentBlock`s into whole turns.
- Does `claude://` ever need to be a **sink** (project-knowledge upload)? Defer;
  assume read-only.
- State-file location for non-FS sinks -- where does `.claudesync-state.json` live
  for `s3://`? (Sidecar object vs manifest key.) Decide in Phase 3.
- Filter-rule merge files (rsync `merge`/`.rsync-filter`) -- YAGNI until needed.

## Risks

- **Scope creep into rclone.** Mitigation: the phase gates; Phase 0 must ship
  byte-identical before transports.
- **Per-sink `--delete` footguns** (history rewrite on git). Mitigation: explicit
  per-sink semantics in FR-3; default `--delete` off.
- **Datastore format drift** (Cursor/opencode/Gemini CLI/JetBrains). Mitigation:
  best-effort version-tolerant parsers; "verify on the install first" gate.

## Success Metrics

- Phase 0: 100% byte-identical output vs current `export`/`export-all` on a
  fixture corpus; full test suite green; no new public CLI flags.
- Phase 1: `cc://` produces the same layout the `claude-code` subcommand does, now
  behind the seam; `export`/`export-all`/`claude-code` aliases unchanged.
- Phase 3: a single `sync` invocation fan-outs claude.ai -> local git + Garage S3
  with one source read.

## References

- Design doc: `claudesync-remote-surface-design.md` (claude.ai conversation
  `4119ad38-21cc-4cdd-897f-8a29e27a55e7`).
- Already-built Phase 1 reader: `packages/core/src/claude-code/` + CLI
  `packages/cli/src/commands/claude-code.ts` (branch `feat/claude-code-source`).
- Keystone code: `export/bundle-builder.ts`, `sync/diff.ts`,
  `sync/files-mode.ts` (`replaceWithPreserve`), `util/glob.ts`,
  `export/git-exporter.ts`.
- Related: PRD 002 (skill sync, shares the `--unstable-surfaces` gate and the
  surface-adapter pattern), PRD 003 (OpenViking `viking://` sink).
