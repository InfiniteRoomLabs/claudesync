---
title: "ClaudeSync -- OpenViking Sink (viking:// destination)"
description: A SinkSurface that ingests the ClaudeSync canonical tree into OpenViking (the homelab context database) so the whole conversation/session/skill corpus is semantically searchable by every agent.
author: Wes Gilleland
version: 0.1.0
status: draft
date: 2026-06-17
source: "Builds on PRD 001 (remote surfaces); OpenViking idea 086; openviking-mcp-bridge REST client"
tags: [claudesync, openviking, sink, rag, semantic-search, agent-memory, parallax, homelab, ingestion]
---

# ClaudeSync -- OpenViking Sink (PRD)

> This is a **new** PRD that builds directly on **PRD 001 (Remote Surfaces &
> rsync-style URI Transport)**. It adds a `viking://` `SinkSurface` that pushes the
> ClaudeSync canonical tree into **OpenViking**, the homelab "context database for
> AI agents." It is the concrete implementation of idea 086's **Phase 2 (Ingest)**:
> "Claude Code JSONL / conversations -> OpenViking," replacing the planned "~200
> lines of Python preprocessing" with ClaudeSync's existing canonical markdown.

---

## Executive Summary

ClaudeSync already renders conversations and local Claude Code sessions into a
clean canonical tree (`conversation.md`, `artifacts/`, `tool-outputs/`,
`README.md`). OpenViking already ingests markdown/dirs and exposes them to every
agent via semantic `search`/`query` over a `viking://` filesystem namespace. This
PRD connects the two: a **`viking://` sink** that, for each item ClaudeSync syncs,
ingests its canonical tree into OpenViking under a stable `viking://` path -- so
the entire corpus (claude.ai chats + Claude Code sessions + later, Skills) becomes
one semantically searchable knowledge layer.

**Why this is the right fit:** OpenViking wants clean, file-shaped markdown;
ClaudeSync's canonical tree already *is* that. The brittle preprocessing idea 086
anticipated is unnecessary -- the sink is "materialize the tree where OpenViking
can read it, then `POST /api/v1/resources`."

**Dependency:** requires PRD 001 Phase 0 (the `SinkSurface` seam). The sink is a
new `SinkSurface` impl; it does not change conversation rendering.

---

## Problem / Motivation

- Idea 086's pain point: knowledge is scattered (laptop, claude.ai, server, docs)
  and "every agent spawned today starts cold; every search is keyword-only."
- ClaudeSync solves *extraction + normalization*; OpenViking solves *semantic
  retrieval + tiered context loading (L0/L1/L2) + agent memory*. The missing piece
  is the **pipe** between them.
- Without it, OpenViking ingestion of ClaudeSync output is a manual, bespoke
  script (idea 086 Phase 2, "not started"). A first-class sink makes it a flag.

## Goals

1. Add a `viking://` **`SinkSurface`** that ingests each item's `CanonicalTree`
   into OpenViking under a deterministic namespace path.
2. **Fan-out compatible** (PRD 001 FR-4): the same `sync` run writes local git +
   Garage S3 + OpenViking in one source read.
3. **Incremental**: re-ingest only changed items; avoid duplicate OpenViking
   entries on re-sync.
4. Map ClaudeSync's project/conversation/session structure onto OpenViking's
   `viking://` namespaces so retrieval is directory-scopable.

## Non-Goals

- Replacing OpenViking's own `search`/`query` -- this PRD only *writes*; agents
  read via the OpenViking MCP server as today.
- Deploying/operating OpenViking (covered by idea 086 / infra Helm chart).
- Building a `viking://` **source** (re-reading OpenViking back out). Possible
  later (search-as-source); out of scope here.

---

## OpenViking interface (verified against the homelab REST client)

From `openviking-mcp-bridge/src/openviking_mcp/client.py` (the IRL bridge already
talking to the homelab instance) and idea 086:

- **Base:** `http://<host>:1933` (homelab NodePort 31933 /
  `context.internal.lab.infiniteroomlabs.cloud`).
- **Auth headers:** `Authorization: Bearer <root_api_key>`,
  `X-OpenViking-Account: <account>`, `X-OpenViking-User: <user>`.
- **Ingest:** `POST /api/v1/resources` with body `{ "path": <str>, "to": <viking-uri>, "wait": <bool> }`
  -- ingests a doc/dir/URL/GitHub repo at `path` into the `to` namespace. `wait`
  false enqueues async.
- **Async progress:** `GET /api/v1/observer/queue` (queue status),
  `GET /api/v1/observer/system`.
- **Existence/diff:** `GET /api/v1/fs/stat?uri=<viking-uri>`,
  `GET /api/v1/fs/ls?uri=&recursive=`.
- **Verify ingest:** `POST /api/v1/search/find { query, target_uri, limit }`,
  `GET /api/v1/content/read?uri=`.
- **Namespaces** (multi-tenant): `viking://resources/` (account-wide),
  `viking://user/{space}/`, `viking://agent/{space}/`, `viking://session/{id}/`.

**Key constraint:** `add_resource` is **path-based** -- OpenViking reads from a
`path` *it* can reach (local FS on the server, or a URL/S3 it can fetch). The
ClaudeSync host (laptop) and the OpenViking server (k3s) do not share a
filesystem. This drives the transport design (FR-3).

---

## Functional Requirements

### FR-1: `viking://` SinkSurface

Implement `SinkSurface` (PRD 001 FR-1):

```ts
// viking://<namespace>/<prefix>   e.g. viking://resources/claudesync/
class OpenVikingSink implements SinkSurface {
  // GET /api/v1/fs/stat on the target path; returns stored content-hash metadata
  // (or null) for skip/diff.
  stat(ref: ItemRef): Promise<SinkState | null>;

  // 1. stage tree to a reachable transport (FR-3)
  // 2. POST /api/v1/resources { path, to: vikingUriFor(ref), wait }
  // 3. if !wait, poll /api/v1/observer/queue to completion
  write(ref: ItemRef, tree: CanonicalTree, opts: ApplyOpts): Promise<ApplyResult>;
}
```

`ApplyOpts.format` for `viking://` is effectively fixed to **`files`** -- OpenViking
ingests the markdown tree; `git`/`json` materializations do not map. A
non-`files` format against a `viking://` sink is a config error.

### FR-2: Namespace mapping

Deterministic, directory-scopable, mirrors the ClaudeSync corpus layout:

```
viking://resources/claudesync/<source>/<project-slug>/<item-slug>/
  conversation.md
  README.md
  artifacts/...            (claude.ai artifacts)
  tool-outputs/...         (Claude Code tool I/O)
```

- `<source>` = `claude` | `claude-code` | `cursor` | ... (the PRD 001 source
  scheme), so retrieval can be scoped to a platform:
  `search(query, target_uri="viking://resources/claudesync/claude-code/")`.
- `<project-slug>` / `<item-slug>` reuse the existing `disambiguateSlugs` naming
  so a conversation maps to one stable viking path across re-syncs.
- Default namespace `resources/` (account-wide). A `--viking-namespace` flag MAY
  target `agent/<space>/` or `user/<space>/` for scoped corpora.

### FR-3: Transport / staging (reachability)

OpenViking ingests from a `path` it can read. Three modes, in preference order:

1. **S3 staging (default for laptop runs)** -- compose PRD 001's `s3://` sink:
   write the `CanonicalTree` to Garage (`s3://garage/...`), then
   `add_resource(path=<s3-or-presigned-url>, to=viking://...)`. OpenViking fetches
   it. Requires confirming OpenViking accepts an S3/HTTP URL as `path`
   (open question Q1).
2. **Co-located run** -- ClaudeSync runs in-cluster (k3s Job) writing to a PVC
   OpenViking also mounts; `add_resource(path=<shared-fs-path>)`. Heaviest, most
   reliable.
3. **Direct content write** -- if OpenViking exposes an AGFS/content **write**
   endpoint (the bridge client only wraps `/content/read`), push bytes straight to
   `viking://...` and skip staging entirely (open question Q2 -- preferred if it
   exists).

The sink abstracts this behind a `VikingTransport` strategy; v1 ships whichever of
{S3, direct-write} is confirmed first.

### FR-4: Incremental ingest (no duplicates)

- On `write`, compute a content hash of the `CanonicalTree` (reuse the
  `sync/diff.ts` logical hash where possible).
- `stat(ref)` reads the prior hash -- from OpenViking item metadata if storable,
  else a local `.claudesync-state.json` sidecar keyed by `ref` (this is exactly
  PRD 001's "state-file location for non-FS sinks" open question; resolve here).
- Skip when unchanged. When changed, **update in place** -- requires knowing
  OpenViking's update semantics: does re-`add_resource` to the same `to` path
  update or duplicate? (open question Q3 -- idea 086 flags this too.) If it
  duplicates, delete-then-add (needs a delete endpoint, Q4).

### FR-5: `--delete` semantics (per PRD 001 FR-3)

A conversation removed at the source should tombstone in OpenViking (remove the
`viking://` path so stale context stops surfacing in search). Requires an
OpenViking delete/unlink endpoint (open question Q4). Default `--delete` off.

### FR-6: Async + observability

Default `wait=false` (enqueue) for throughput on large corpora; poll
`GET /api/v1/observer/queue` and surface progress through the existing
`onProgress` callback. A `--viking-wait` flag forces synchronous ingest per item
(useful for small runs / CI).

---

## CLI surface (built on PRD 001)

```
# fan-out: archive to local git AND index into OpenViking in one read
claudesync sync claude://me/conversations \
  ./org-export?format=git \
  viking://resources/claudesync/claude

# index local Claude Code sessions into OpenViking (idea 086 Phase 2)
claudesync sync cc://local/projects viking://resources/claudesync/claude-code

# scoped namespace + synchronous
claudesync sync cc://local/projects \
  viking://agent/research/claudesync/claude-code --viking-wait
```

Connection config (host, `root_api_key`, account, user) via env
(`CLAUDESYNC_VIKING_URL`, `CLAUDESYNC_VIKING_API_KEY`, ...) or `--viking-*` flags;
key sourced from Bitwarden / k8s secret per IRL secret policy, never committed.

---

## Phasing

| Phase | Scope | Gate |
|---|---|---|
| **V0** | Confirm OpenViking write path (Q1-Q4): does `add_resource` take a URL/S3 path? is there a direct content-write endpoint? update vs duplicate on re-ingest? delete endpoint? Smoke-test against the homelab instance with one conversation dir. | Blocks design finalization. Depends on PRD 001 Phase 0 seam. |
| **V1** | `OpenVikingSink.write` for a single source (`cc://` or `claude://`) via the confirmed transport; namespace mapping (FR-2); `--viking-wait`; verify via `search`. No incremental yet. | One-pass ingest works end to end; items findable via OpenViking `search`. |
| **V2** | Incremental (FR-4) + fan-out with other sinks (FR-4 of PRD 001) + async/observer progress (FR-6). | Re-sync ingests only changed items; no duplicates. |
| **V3** | `--delete` tombstoning (FR-5); skills corpus ingest (PRD 002 output as a `viking://` source of skills); `--viking-namespace` scoping. | -- |

---

## Open Questions

- **Q1.** Does `POST /api/v1/resources` accept an `s3://` / HTTP(S) URL as `path`,
  or only a server-local filesystem path? (Determines the default transport.)
- **Q2.** Is there an AGFS/content **write** endpoint (push bytes to `viking://`
  directly)? The bridge wraps only `/content/read`. If yes, it is the preferred
  transport (no staging).
- **Q3.** Re-ingesting the same `to` path: update-in-place or duplicate? (idea 086
  open question: "Does re-ingesting a changed file update the existing entry or
  create a duplicate?")
- **Q4.** Is there a delete/unlink endpoint for `--delete` tombstoning?
- **Q5.** Can per-item content hashes be stored as OpenViking metadata (for
  `stat`-based incremental) or must ClaudeSync keep a local sidecar state?
- **Q6.** Embedding dimension lock-in: corpus is embedded with `nomic-embed-text`
  (768 dims) -- a model change requires re-ingest. Note in docs.
- **Q7.** L0/L1/L2 tiering: does ingesting our markdown auto-summarize, and does
  conversation length blow up token/storage budgets? Benchmark per idea 086.

## Risks

- **OpenViking is Alpha** (idea 086: 2 CVEs in first 60 days; v0.2.x). Mitigation:
  homelab-only behind Tailscale, `root_api_key` set, single user; do not expose
  the sink to untrusted ClaudeSync input. Revisit before any productization
  (Parallax).
- **Duplicate/stale entries** poison retrieval. Mitigation: resolve Q3/Q4 in V0;
  incremental + tombstone in V2/V3; default `--delete` off until proven.
- **Reachability coupling** (laptop vs k3s FS). Mitigation: S3 staging (composes
  PRD 001 Phase 3) or in-cluster Job; pick per Q1/Q2.
- **Embedding cost** on CPU-only Ollama (HP Z600). Mitigation: async ingest +
  observer backpressure; batch; run large initial ingests off-hours.

## Success Metrics

- V1: a Claude Code session synced via `viking://` is returned by an OpenViking
  `search` for a phrase known to be in that session, scoped to
  `viking://resources/claudesync/claude-code/`.
- V2: a no-op re-sync ingests zero items; an edited item updates exactly one
  OpenViking entry (no duplicate); fan-out to git + `viking://` in one read.
- Idea 086 Phase 2 ("Ingest") is satisfied by `claudesync sync` flags -- no bespoke
  preprocessing script.

## References

- PRD 001 (remote surfaces / `SinkSurface` seam -- hard dependency).
- Idea 086: `ideas/ideas/086-openviking-unified-knowledge-layer.md` (architecture,
  `viking://` namespaces, Phase 2 ingest plan, Ollama/embedding config, CVEs).
- OpenViking REST contract: `openviking-mcp-bridge/src/openviking_mcp/client.py`
  (`add_resource`, `find`, `ls`, `stat`, `read`, `observer/queue`).
- OpenViking upstream: `third-party/OpenViking/` (Python SDK `openviking/`,
  `examples/mcp-query/`, `examples/k8s-helm/`).
- Homelab service: `irl-openviking` Helm chart; `context.internal.lab...` /
  NodePort 31933.
