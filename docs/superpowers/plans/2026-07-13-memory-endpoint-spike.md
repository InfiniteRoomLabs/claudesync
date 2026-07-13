# Project Memory Endpoint Discovery Spike (Phase 0) Implementation Plan

> **STATUS: EXECUTED 2026-07-13** (run live via the claude-in-chrome extension rather than handed off). Results: `docs/spike-results/memory-findings.md`. The design spec (`../specs/2026-07-13-project-memory-sync-design.md`) is revised to match. This plan is retained for provenance; the task steps below are the method that was followed. Notable deviation: endpoints were discovered by in-page `fetch` probing (not just passive capture), because the memory GET fires before network tracking attaches.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This spike is INTERACTIVE -- it drives the operator's live claude.ai session in Chrome and needs their account. Do NOT dispatch blind subagents for capture tasks; run them inline with the operator present.

**Goal:** Discover, verify, and document every claude.ai API endpoint behind the per-project memory feature (read memory, list/submit/delete/clear edits, regenerate, pencil direct-edit), producing `docs/spike-results/memory-findings.md` with redacted shapes and draft Zod schemas, satisfying the exit criteria in section 3 of `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md`.

**Architecture:** Capture network traffic from the claude.ai web app in Chrome via the claude-in-chrome MCP tools (`read_network_requests`), exercising each memory UI operation against a throwaway test project. Fall back to Electron remote debugging of the Linux desktop app only if the web app lacks the feature. Replay read endpoints through plain Node 24 `fetch` with the session cookie to prove the existing SDK transport path works. Document everything redacted; write no production code (schemas ship in Phase 1).

**Tech Stack:** claude-in-chrome MCP (network capture), Node 24 (replay verification), zod (schema drafting in-doc), existing cookie-harvest broker (`scripts/lib/harvest-cookie.sh`).

## Global Constraints

- **Node 24 via mise shims is already on the agent's PATH** -- call `node`/`pnpm` directly; do NOT run `nvm use` (nvm is absent in the agent shell).
- **Privacy is a hard gate:** memory content is highly sensitive. NEVER paste real memory text, edit-instruction text, org UUIDs, or account identifiers into the findings doc, commit messages, or terminal output that lands in logs. All response bodies in the findings doc must be synthetic reconstructions of the SHAPE, not copies.
- **All mutation captures (submit/delete/clear/regenerate) run ONLY against the throwaway test project created in Task 1** -- never against a real project. Real-project captures are read-only.
- **ASCII only, no hard-wrapped prose** in all markdown written.
- **Cookie hygiene:** the session cookie is read into `CLAUDE_AI_COOKIE` for replay and never echoed, logged, or written to disk.
- **Commits to `main` require a staged `CHANGELOG.md` entry** (changelog-guard hook) and staging + commit as separate Bash calls (version-guard hook).
- This spike ships documentation only. No changes under `packages/`.

---

### Task 1: Recon -- confirm the feature surface and create the throwaway project

**Files:**
- None written yet (findings accumulate in the session; doc is written in Task 5).

**Interfaces:**
- Produces: a throwaway project UUID (call it `TEST_PROJECT_ID` below) with enough synthetic chat content to have memory; confirmation of whether claude.ai WEB has the memory UI or whether the desktop-app fallback (Task 6) is needed.

- [ ] **Step 1: Load browser tools**

One ToolSearch call: `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__read_network_requests`

- [ ] **Step 2: Open claude.ai projects in a new tab**

Call `tabs_context_mcp`, then `tabs_create_mcp`, then `navigate` to `https://claude.ai/projects`. The operator must already be logged in; if not, stop and ask them to log in.

- [ ] **Step 3: Check an existing project for the Memory card**

Open any existing project the operator owns. Use `read_page` to look for a "Memory" section/card (the desktop app shows: Memory card with "Only you" badge, pencil icon, "Last updated ..." line). Record: present on web? exact UI affordances?

- If ABSENT on web: mark Task 6 (desktop fallback) as required and still complete Steps 4-5 (the test project is needed either way).

- [ ] **Step 4: Create the throwaway test project**

Via the UI: create project named `claudesync-memory-spike` with description `Throwaway project for API capture. Synthetic content only.` Record its UUID from the URL (`/project/<uuid>`). This is `TEST_PROJECT_ID`.

- [ ] **Step 5: Seed synthetic chats**

Start 2-3 short conversations inside the test project with purely synthetic content (e.g. "Let's plan a fictional bakery's menu", "The bakery mascot is a penguin named Gerald"). Memory may only materialize after the server-side evening regeneration; that is fine -- Task 3's regenerate capture may itself populate it. Note whether a memory doc already exists after seeding.

---

### Task 2: Capture read operations (safe on any project)

**Files:**
- Create: `/tmp/claude-1000/.../scratchpad/memory-capture-notes.md` (scratchpad working notes; raw shapes live here until redacted into the findings doc, then the file is deleted)

**Interfaces:**
- Consumes: `TEST_PROJECT_ID` from Task 1.
- Produces: for each read endpoint -- method, path template, query params, response shape sketch, and which UI action fired it.

- [ ] **Step 1: Clear the network slate and open the project page**

Navigate to `https://claude.ai/project/<TEST_PROJECT_ID>`. Immediately call `read_network_requests` with pattern `memory` (and if empty, retry with patterns `projects` then `api`) to catch the initial memory-summary fetch that populates the Memory card.

- [ ] **Step 2: Open the "Manage project memory" modal**

Click the Memory card / manage affordance via `computer`. Call `read_network_requests` again (pattern `memory`). Record any full-document fetch distinct from the card summary.

- [ ] **Step 3: Open the "Manage edits" view**

Click "Manage edits". Capture the edits-list request. Record: are edits embedded in the memory response or a separate endpoint? Do entries carry stable `id`/`uuid` fields? Creation timestamps? Ordering field?

- [ ] **Step 4: Record shapes in scratchpad notes**

For every captured request write: verb, path (UUIDs replaced with `<org>`, `<project>`), request headers of interest (anything beyond the known cookie/UA baseline), response status, and a field-by-field shape sketch with types -- values replaced by synthetic placeholders. Note pagination/limit params if any.

- [ ] **Step 5: Checkpoint with the operator**

Report what was found so far (endpoint count, whether IDs are stable). No commit yet.

---

### Task 3: Capture mutations (throwaway project ONLY)

**Files:**
- Modify: scratchpad `memory-capture-notes.md`

**Interfaces:**
- Consumes: `TEST_PROJECT_ID`, read-endpoint knowledge from Task 2.
- Produces: method/path/request-body/response shapes for submit-edit, delete-edit, clear-edits, regenerate, and pencil direct-edit (if it exists); async-job semantics for regenerate; concurrency tokens (etag/revision headers) if any.

- [ ] **Step 1: Submit an edit instruction**

In the Manage modal prompt box, submit a synthetic instruction: `Gerald the penguin prefers rye flour.` Capture the POST: body shape, response (does it return the created edit with an id? the updated memory doc? 202 + job?). Then reload the edits list and note whether the new entry appears immediately and whether memory text changed immediately (answers the "edits apply now vs at next regen" exit criterion).

- [ ] **Step 2: Submit a second edit, then delete the first**

Second synthetic instruction (needed so delete does not empty the list before the clear test). Then trash-icon the first entry. Capture the DELETE (or POST): is the edit id in the path or body? Response shape? Does deletion trigger an immediate memory rewrite?

- [ ] **Step 3: Clear edits**

Click "Clear edits". Capture: single bulk endpoint or N per-entry deletes? Confirmation semantics?

- [ ] **Step 4: Regenerate**

Trigger regeneration (the modal/card affordance). Capture: sync response with new content, or job id? If a job: capture the polling/streaming mechanism and completion signal. Time it. Note any revision/etag change on the subsequent memory GET.

- [ ] **Step 5: Probe the pencil icon**

Click the pencil on the Memory card. Determine what it actually is (direct text editor? shortcut to the edit prompt?). If a direct editor exists: make a one-word synthetic change and capture the write endpoint + any precondition headers. This resolves the design's Phase-3 gate.

- [ ] **Step 6: Cross-client check (desktop app)**

With mutations done, open the same test project in the Linux desktop app and confirm the state matches (edits list, memory text). Confirms web and desktop share the same backend resource -- one sentence in the notes.

---

### Task 4: Replay verification through Node 24

**Files:**
- Create: `/tmp/claude-1000/.../scratchpad/replay-memory.mjs` (throwaway; never committed)

**Interfaces:**
- Consumes: discovered GET endpoints from Tasks 2-3; session cookie via the harvest broker.
- Produces: proof that the SDK's transport path (Node 24 fetch + `sessionKey` cookie + browser UA) passes Cloudflare for the memory endpoints, and confirmed response JSON parses against the drafted shapes.

- [ ] **Step 1: Write the replay script**

```js
// replay-memory.mjs -- throwaway spike script. Reads CLAUDE_AI_COOKIE, hits the
// discovered memory GET endpoints, prints STATUS + top-level key names ONLY
// (never values), so nothing sensitive lands in the terminal.
const cookie = process.env.CLAUDE_AI_COOKIE;
if (!cookie) throw new Error("CLAUDE_AI_COOKIE not set");
delete process.env.CLAUDE_AI_COOKIE;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const base = "https://claude.ai";
// Fill in real paths discovered in Tasks 2-3 before running:
const paths = [
  "/api/organizations/<org>/projects/<TEST_PROJECT_ID>/<memory-path>",
  "/api/organizations/<org>/projects/<TEST_PROJECT_ID>/<edits-path>",
];
for (const p of paths) {
  const res = await fetch(base + p, {
    headers: { cookie: `sessionKey=${cookie}`, "user-agent": UA },
  });
  const body = await res.json().catch(() => null);
  console.log(res.status, p.replace(/[0-9a-f-]{36}/g, "<uuid>"),
    body ? Object.keys(body) : "(non-JSON)");
}
```

- [ ] **Step 2: Run it**

```bash
CLAUDE_AI_COOKIE="$(bash scripts/lib/harvest-cookie.sh 2>/dev/null || true)" node /tmp/claude-1000/.../scratchpad/replay-memory.mjs
```

(If the broker path differs, ask the operator to supply the cookie via `! export`-style interactive command rather than pasting it into chat.)

Expected: `200` for each path with the same top-level keys seen in the browser capture. A `403`/Cloudflare block or shape drift is itself a finding -- record it.

- [ ] **Step 3: Delete the replay script**

```bash
rm /tmp/claude-1000/.../scratchpad/replay-memory.mjs
```

---

### Task 5: Write redacted findings + draft schemas, commit

**Files:**
- Create: `docs/spike-results/memory-findings.md`
- Modify: `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md` (fill the confirmed-endpoint facts into section 3 exit criteria)
- Modify: `CHANGELOG.md` (Unreleased > Documentation entry)

**Interfaces:**
- Consumes: scratchpad capture notes (Tasks 2-4).
- Produces: the Phase-1 ground-truth document; Phase 1 implements ONLY what this doc confirms.

- [ ] **Step 1: Write `docs/spike-results/memory-findings.md`**

Structure (mirror the existing `docs/spike-results/findings.md` style):

1. **Summary table**: one row per operation (read memory, list edits, create edit, delete edit, clear edits, regenerate, direct edit) -> verb, path template, confirmed/absent.
2. **Per-endpoint detail**: request/response shape sketches with SYNTHETIC values, status codes, error responses observed, concurrency headers.
3. **Draft Zod schemas** (fenced ```ts blocks, `.passthrough()`, not shipped code): `ProjectMemorySchema`, `ProjectMemoryEditSchema`, plus regenerate-job schema if async.
4. **Design-spec exit criteria checklist** (from spec section 3), each marked met/unmet with one-line evidence.
5. **Surprises / risks** section (feature flags seen, rollout gating, anything that changes the design).

Redaction pass before saving: grep the draft for the operator's org UUID, real project UUIDs (other than noting `TEST_PROJECT_ID` was throwaway), email, and any memory text. `grep -nP '[^\x00-\x7F]'` for encoding.

- [ ] **Step 2: Update the design spec**

In the spec's section 3, annotate each exit criterion with its outcome (met/unmet + pointer to the findings doc). If any criterion failed (e.g. no stable edit IDs), add the consequence already defined by the spec (deletion/clear stay disabled in Phase 2) as a note.

- [ ] **Step 3: Add CHANGELOG entry**

Under `## [Unreleased]` > `### Documentation`, one bullet: memory endpoint spike findings added (`docs/spike-results/memory-findings.md`); design spec exit criteria annotated. No content specifics.

- [ ] **Step 4: Delete scratchpad capture notes**

```bash
rm /tmp/claude-1000/.../scratchpad/memory-capture-notes.md
```

- [ ] **Step 5: Stage, then commit (separate calls -- hook requirement)**

```bash
git add docs/spike-results/memory-findings.md docs/superpowers/specs/2026-07-13-project-memory-sync-design.md CHANGELOG.md
```

```bash
git commit -m "docs: memory endpoint spike findings (phase 0)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Clean up the throwaway project**

Ask the operator whether to delete `claudesync-memory-spike` from claude.ai (recommended: yes, after findings are committed -- but keeping it is useful for Phase 1 integration testing against real endpoints. Default: KEEP until Phase 1 lands, then delete).

---

### Task 6 (CONDITIONAL -- only if Task 1 found no memory UI on claude.ai web): Desktop app capture fallback

**Files:**
- Modify: scratchpad `memory-capture-notes.md`

**Interfaces:**
- Consumes: Task 1's determination that the feature is desktop-only.
- Produces: the same captures as Tasks 2-3, gathered from the Linux desktop app.

- [ ] **Step 1: Try Electron remote debugging**

The Linux desktop app is Electron (see `docs/claude-desktop-linux.md` for install layout). Quit the app, relaunch with a debugging port:

```bash
claude-desktop --remote-debugging-port=9222 &
```

(Adjust the launcher name per `docs/claude-desktop-linux.md`.) Then open `http://localhost:9222` in Chrome, attach to the app's page target, and use the DevTools Network tab manually with the operator, OR connect claude-in-chrome if it can target the debug endpoint.

- [ ] **Step 2: If remote debugging is blocked, use a logging proxy as last resort**

`HTTPS_PROXY` + mitmproxy is likely to FAIL Cloudflare TLS fingerprinting on the upstream hop (same class of block as curl/Bun, per `docs/spike-results/findings.md`). Try it only to confirm, expect failure, and if so fall back to: operator performs actions in the desktop app while a claude.ai web tab (which shares the backend) is watched for equivalent state changes, and endpoint shapes are inferred from the web app's read endpoints plus desktop behavior. Record the limitation honestly in the findings doc.

- [ ] **Step 3: Run the Task 2 and Task 3 capture sequences via the working channel**

Same operations, same redaction rules, same throwaway-project-only rule for mutations.

---

## Self-Review Notes

- Spec coverage: spec section 3 lists seven capture targets (memory load, modal load, edit submission, per-entry delete, clear, regenerate, pencil) -- covered by Task 2 (loads) and Task 3 (all five mutations). Exit criteria: stable IDs (Task 2 Step 3), regen signal (Task 3 Step 4), concurrency (Tasks 2-3 shape recording), immediate-vs-regen edit application (Task 3 Step 1), pencil resolution (Task 3 Step 5), schemas (Task 5).
- No production code: intentional; Phase 1 owns `packages/` changes. Replay script is throwaway and deleted (Task 4 Step 3).
- The `<org>` value needed in Task 4 comes from the captured paths in Task 2.
