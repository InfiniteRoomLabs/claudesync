# Project Memory Sync -- Phase 1 (Pull) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull a project's memory (the server-generated doc + its `controls` edit list) from claude.ai into a local `memory/` subtree (`MEMORY.md` + `edits.md` + a hash sidecar), idempotently and atomically, exposed through the SDK, the CLI (`projects memory show|pull|status`), and a read-only MCP tool. No writes to claude.ai in this phase.

**Architecture:** One new SDK read method (`getProjectMemory`) validated by a Zod schema, plus a self-contained `packages/core/src/memory/` module holding: content canonicalization + `edits.md` (de)serialization + SHA-256 hashing, a memory-scoped state sidecar (mirroring `sync/state.ts`), and a pull engine that fetches, computes a per-entity merge decision, and atomically materializes the two files + sidecar. CLI and MCP are thin shells over the engine. Does NOT depend on the (unbuilt) txn core -- atomicity uses the existing tmp-file + rename pattern.

**Tech Stack:** TypeScript (strict, ESM, NodeNext -- every relative import ends in `.js`), Node 24, Vitest, Zod, `node:crypto`, `node:fs`, commander (CLI), `@modelcontextprotocol/sdk` (MCP).

## Global Constraints

- **Node 24 is on the agent PATH via mise shims** -- call `node`/`pnpm` directly; do NOT run `nvm use` (nvm is absent in the agent shell).
- **pnpm only** (never npm/yarn/npx). Run one core test file: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/<name>.test.ts`.
- **ESM + NodeNext:** every relative import MUST end in `.js` (e.g. `import { hashContent } from "./hash.js"`).
- **Strict TypeScript, no `any`.**
- **Tests live in `packages/core/test/**/*.test.ts`** and import source via the `@core` alias (e.g. `import { ... } from "@core/memory/pull.js"`). Mirror the source path under `test/`. Vitest globals are NOT enabled -- import `{ describe, it, expect }` (and `vi`, `beforeEach`) from `vitest`.
- **Full TSDoc coverage (MANDATORY, per `CLAUDE.md`):** every declaration AND member gets a `/** */`. No `{type}` annotations, no `@property`/`@interface`. Use `@param name - desc`, `@returns`, `@throws`, `{@link}`. A task is not done until its TSDoc is complete. Pass this requirement into any subagent prompt.
- **ASCII only** in all files: `--` not em dash, `->` not arrow, straight quotes. No hard-wrapped markdown prose.
- **Ground truth is the spike:** `docs/spike-results/memory-findings.md`. The design is `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md`.
- **API facts (do not re-derive):** `GET /api/organizations/<org>/memory?project_uuid=<project>` returns `{ memory: string, controls: string[] | null, updated_at: string | null }`. Only `project_uuid` selects the project; other param names silently fall back to account memory. An ungenerated project returns `{ memory: "", controls: null, updated_at: null }`.
- **Privacy (hard):** memory + edit text NEVER appears in changelogs, progress output, errors, logs, or the sidecar. Fixtures are synthetic only. New `memory/` files get mode `0600` where the platform supports it.
- **Implementation branch:** work on `feat/memory-pull` (not `main`), so per-commit changelog-guard does not gate each TDD commit; add the CHANGELOG entry once in the final task. Create it before Task 1: `git checkout -b feat/memory-pull`.
- **Commit hooks:** `git add` and `git commit` are SEPARATE Bash calls (version-guard blocks combined add+commit and `-a`/`-am`).

## File Structure

- `packages/core/src/client/endpoints.ts` -- add `memory(orgId, projectId)` builder (MODIFY).
- `packages/core/src/models/schemas.ts` -- add `ProjectMemorySchema` (MODIFY).
- `packages/core/src/models/types.ts` -- add `ProjectMemory` type (MODIFY).
- `packages/core/src/client/client.ts` -- add `getProjectMemory` method (MODIFY).
- `packages/core/src/memory/hash.ts` -- `hashContent` (CREATE).
- `packages/core/src/memory/edits.ts` -- canonicalize + `edits.md` (de)serialize (CREATE).
- `packages/core/src/memory/state.ts` -- memory sidecar schema + read/write (CREATE).
- `packages/core/src/memory/pull.ts` -- pull engine: fetch + merge decision + materialize (CREATE).
- `packages/core/src/index.ts` -- re-export the public memory surface (MODIFY).
- `packages/cli/src/commands/projects.ts` -- add `memory show|pull|status` subcommands (MODIFY).
- `packages/mcp-server/src/server.ts` -- add `get_project_memory` read tool (MODIFY).
- `CHANGELOG.md` -- one Unreleased entry (MODIFY, final task).

---

### Task 1: SDK read -- endpoint, schema, client method

**Files:**
- Modify: `packages/core/src/client/endpoints.ts`
- Modify: `packages/core/src/models/schemas.ts`
- Modify: `packages/core/src/models/types.ts`
- Modify: `packages/core/src/client/client.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/models/project-memory-schema.test.ts`

**Interfaces:**
- Consumes: existing `request`, `buildUrl`, `ENDPOINTS` patterns.
- Produces:
  - `ENDPOINTS.memory(orgId: string, projectId: string): string`
  - `ProjectMemorySchema` (Zod), `ProjectMemory = { memory: string; controls: string[] | null; updated_at: string | null }`
  - `ClaudeSyncClient.getProjectMemory(orgId: string, projectId: string): Promise<ProjectMemory>`

- [ ] **Step 1: Write the failing schema test**

Create `packages/core/test/models/project-memory-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ProjectMemorySchema } from "@core/models/schemas.js";

describe("ProjectMemorySchema", () => {
  it("parses a generated memory response", () => {
    const r = ProjectMemorySchema.parse({
      memory: "**Purpose**\n\nSynthetic memory.",
      controls: ["Prefer rye flour.", "Open at 6am."],
      updated_at: "2026-07-12T07:38:26.626000+00:00",
    });
    expect(r.controls).toEqual(["Prefer rye flour.", "Open at 6am."]);
  });

  it("parses an ungenerated project (null controls, empty memory)", () => {
    const r = ProjectMemorySchema.parse({ memory: "", controls: null, updated_at: null });
    expect(r.controls).toBeNull();
    expect(r.memory).toBe("");
  });

  it("passes through unknown fields (forward compat)", () => {
    const r = ProjectMemorySchema.parse({
      memory: "x", controls: [], updated_at: null, future_field: 1,
    }) as Record<string, unknown>;
    expect(r.future_field).toBe(1);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/models/project-memory-schema.test.ts`
Expected: FAIL -- `ProjectMemorySchema` is not exported.

- [ ] **Step 3: Add the endpoint builder**

In `packages/core/src/client/endpoints.ts`, inside the `ENDPOINTS` object under the Projects group, add:

```ts
  /**
   * A project's memory: the server-generated memory doc plus its `controls`
   * edit list. Only the `project_uuid` query parameter selects the project;
   * other names silently fall back to account-level memory (spike-confirmed).
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID, sent as `project_uuid`.
   */
  memory: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/memory?project_uuid=${projectId}`,
```

- [ ] **Step 4: Add the schema and type**

In `packages/core/src/models/schemas.ts` (near `ProjectSchema`):

```ts
/**
 * A project's memory payload from `GET .../memory?project_uuid=`. `controls` is
 * the ordered edit-instruction list (plain strings, no server IDs); it is
 * `null` for a project whose memory has never been generated. `memory` is the
 * generated markdown doc ("" when ungenerated). `.passthrough()` keeps unknown
 * fields for forward compatibility.
 */
export const ProjectMemorySchema = z
  .object({
    /** Server-generated markdown memory document; "" if never generated. */
    memory: z.string(),
    /** Ordered edit-instruction list; null if memory was never generated. */
    controls: z.array(z.string()).nullable(),
    /** ISO 8601 last-generation timestamp; null if never generated. */
    updated_at: z.string().nullable(),
  })
  .passthrough();
```

In `packages/core/src/models/types.ts` (near `Project`):

```ts
/** A project's memory doc + edit-control list. Inferred from {@link ProjectMemorySchema}. */
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;
```

(Ensure `ProjectMemorySchema` is imported into `types.ts` the same way sibling schemas are.)

- [ ] **Step 5: Add the client method**

In `packages/core/src/client/client.ts`, add `ProjectMemorySchema` to the schema import block and `ProjectMemory` to the type import block, then add under the Projects section:

```ts
  /**
   * Fetch a project's memory: the generated doc and its `controls` edit list.
   *
   * A project whose memory has never been generated returns
   * `{ memory: "", controls: null, updated_at: null }` -- callers treat that as
   * "no memory yet", not an error.
   *
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID.
   * @returns The validated memory payload.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async getProjectMemory(
    orgId: string,
    projectId: string
  ): Promise<ProjectMemory> {
    const data = await this.request(
      buildUrl(ENDPOINTS.memory(orgId, projectId))
    );
    return ProjectMemorySchema.parse(data);
  }
```

- [ ] **Step 6: Re-export from index**

In `packages/core/src/index.ts`, add `ProjectMemorySchema` to the schemas export block and `ProjectMemory` to the types export block (follow the existing `Project`/`ProjectSchema` grouping).

- [ ] **Step 7: Run the test, expect pass**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/models/project-memory-schema.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/client/endpoints.ts packages/core/src/models/schemas.ts packages/core/src/models/types.ts packages/core/src/client/client.ts packages/core/src/index.ts packages/core/test/models/project-memory-schema.test.ts
```
```bash
git commit -m "feat(core): getProjectMemory SDK read + schema"
```

---

### Task 2: Hashing helper

**Files:**
- Create: `packages/core/src/memory/hash.ts`
- Test: `packages/core/test/memory/hash.test.ts`

**Interfaces:**
- Produces: `hashContent(data: string): string` -- lowercase hex SHA-256 of the UTF-8 bytes.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/memory/hash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hashContent } from "@core/memory/hash.js";

describe("hashContent", () => {
  it("returns the known SHA-256 of the empty string", () => {
    expect(hashContent("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
  it("is deterministic and 64-char hex", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/hash.test.ts`
Expected: FAIL -- cannot resolve `@core/memory/hash.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/memory/hash.ts`:

```ts
import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256 of a string's UTF-8 encoding. Used to fingerprint
 * canonicalized memory content and edit entries for the sidecar merge base and
 * the idempotency no-op check.
 *
 * @param data - The content to hash.
 * @returns The 64-character lowercase hex digest.
 */
export function hashContent(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/hash.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/hash.ts packages/core/test/memory/hash.test.ts
```
```bash
git commit -m "feat(core): memory content hashing helper"
```

---

### Task 3: Canonicalization + edits.md (de)serialization

**Files:**
- Create: `packages/core/src/memory/edits.ts`
- Test: `packages/core/test/memory/edits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `canonicalize(text: string): string` -- strip BOM, CRLF/CR -> LF, ensure exactly one trailing newline. Applied to the whole memory doc.
  - `serializeEdits(controls: string[]): string` -- render the array to `edits.md`: each entry canonicalized (trimmed, single trailing newline internally) joined by a delimiter line `---`. Empty array -> "".
  - `parseEdits(fileText: string): string[]` -- inverse: split on lines that are exactly `---`, trim each block, drop empty blocks.

**Design note:** `serializeEdits` then `parseEdits` MUST round-trip any `string[]` whose entries contain no line that is exactly `---` (that delimiter is reserved). Entries may otherwise be multi-line.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/memory/edits.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canonicalize, serializeEdits, parseEdits } from "@core/memory/edits.js";

describe("canonicalize", () => {
  it("strips BOM, normalizes newlines, ends with exactly one newline", () => {
    expect(canonicalize("\uFEFFa\r\nb\r\n\n\n")).toBe("a\nb\n");
    expect(canonicalize("no newline")).toBe("no newline\n");
    expect(canonicalize("")).toBe("");
  });
});

describe("serializeEdits / parseEdits round-trip", () => {
  it("round-trips single-line entries", () => {
    const c = ["Prefer rye flour.", "Open at 6am."];
    expect(parseEdits(serializeEdits(c))).toEqual(c);
  });
  it("round-trips a multi-line entry", () => {
    const c = ["Line one\nline two of the same instruction.", "Second."];
    expect(parseEdits(serializeEdits(c))).toEqual(c);
  });
  it("empty array serializes to empty string and parses back to []", () => {
    expect(serializeEdits([])).toBe("");
    expect(parseEdits("")).toEqual([]);
  });
  it("parse drops blank blocks and trims", () => {
    expect(parseEdits("  a  \n---\n\n---\nb\n")).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/edits.test.ts`
Expected: FAIL -- module missing.

- [ ] **Step 3: Implement**

Create `packages/core/src/memory/edits.ts`:

```ts
/** Delimiter line separating entries in `edits.md`. A control entry must not contain a line equal to this. */
const DELIMITER = "---";

/**
 * Canonicalize text for stable hashing and on-disk form: strip a leading UTF-8
 * BOM, convert CRLF and lone CR to LF, and collapse trailing blank lines to
 * exactly one terminal newline. Empty input stays "".
 *
 * @param text - Raw text.
 * @returns The canonical form.
 */
export function canonicalize(text: string): string {
  const noBom = text.replace(/^\uFEFF/, "");
  const lf = noBom.replace(/\r\n?/g, "\n");
  const trimmed = lf.replace(/\n+$/, "");
  return trimmed === "" ? "" : trimmed + "\n";
}

/**
 * Render the `controls` array to `edits.md`. Each entry is trimmed and the
 * entries are joined by a lone `---` delimiter line. An empty array renders to
 * "". Inverse of {@link parseEdits} for entries containing no `---` line.
 *
 * @param controls - Ordered edit instructions.
 * @returns The file text.
 */
export function serializeEdits(controls: string[]): string {
  const blocks = controls.map((c) => c.trim()).filter((c) => c !== "");
  if (blocks.length === 0) return "";
  return blocks.join(`\n${DELIMITER}\n`) + "\n";
}

/**
 * Parse `edits.md` back into the ordered `controls` array: split on lines equal
 * to `---`, trim each block, and drop empties. Inverse of {@link serializeEdits}.
 *
 * @param fileText - The `edits.md` contents.
 * @returns The ordered edit instructions.
 */
export function parseEdits(fileText: string): string[] {
  return fileText
    .split(/^---$/m)
    .map((b) => b.trim())
    .filter((b) => b !== "");
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/edits.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/edits.ts packages/core/test/memory/edits.test.ts
```
```bash
git commit -m "feat(core): edits.md serialize/parse + canonicalize"
```

---

### Task 4: Memory state sidecar

**Files:**
- Create: `packages/core/src/memory/state.ts`
- Test: `packages/core/test/memory/state.test.ts`

**Interfaces:**
- Consumes: nothing (fs + zod).
- Produces:
  - `MEMORY_STATE_FILENAME = ".claudesync-memory-state.json"`
  - `MemoryState` (Zod-inferred): `{ schema_version: 1; project_uuid: string; principal_fingerprint: string; memory_content_sha256: string; controls_base: string[]; remote_snapshot_sha256: string; last_pull_at: string; remote_updated_at: string | null }` where `controls_base` is the ordered per-entry hashes.
  - `readMemoryState(dir: string): MemoryState | undefined`
  - `writeMemoryState(dir: string, state: MemoryState): void` -- atomic tmp+rename, `0600`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/memory/state.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMemoryState, writeMemoryState, MEMORY_STATE_FILENAME } from "@core/memory/state.js";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const sample = {
  schema_version: 1 as const,
  project_uuid: "proj-uuid",
  principal_fingerprint: "a".repeat(64),
  memory_content_sha256: "b".repeat(64),
  controls_base: ["c".repeat(64)],
  remote_snapshot_sha256: "d".repeat(64),
  last_pull_at: "2026-07-13T00:00:00.000Z",
  remote_updated_at: "2026-07-12T07:38:26.626000+00:00",
};

describe("memory state", () => {
  it("returns undefined when no file exists", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    expect(readMemoryState(dir)).toBeUndefined();
  });
  it("round-trips through atomic write", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    writeMemoryState(dir, sample);
    expect(fs.existsSync(path.join(dir, MEMORY_STATE_FILENAME))).toBe(true);
    expect(readMemoryState(dir)).toEqual(sample);
  });
  it("throws on corrupt JSON rather than silently resetting", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    fs.writeFileSync(path.join(dir, MEMORY_STATE_FILENAME), "{not json", "utf-8");
    expect(() => readMemoryState(dir)).toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/state.test.ts`
Expected: FAIL -- module missing.

- [ ] **Step 3: Implement**

Create `packages/core/src/memory/state.ts` following the exact pattern of `sync/state.ts` (Zod schema, `readMemoryState` existence-check + parse, `writeMemoryState` tmp+rename). Full content:

```ts
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

/**
 * Sidecar filename written into a project's `memory/` directory. Leading dot
 * keeps it out of casual listings; it holds only hashes and metadata, never
 * memory or edit text.
 */
export const MEMORY_STATE_FILENAME = ".claudesync-memory-state.json";

/**
 * Persisted merge base for a project's memory pull. `controls_base` is the
 * ordered list of per-entry SHA-256 hashes of the last-synced `controls`, so
 * Phase 2's three-way merge can tell local from remote edit changes without
 * storing instruction text. `remote_snapshot_sha256` fingerprints the whole
 * observed state for the idempotency no-op check.
 */
export const MemoryStateSchema = z.object({
  /** State format version; bumped only on backward-incompatible changes. */
  schema_version: z.literal(1),
  /** Project UUID this state belongs to (the `project_uuid` value). */
  project_uuid: z.string(),
  /** sha256 of the account identifier; a mismatch fails closed on the next run. */
  principal_fingerprint: z.string(),
  /** sha256 of the canonicalized memory doc at last pull. */
  memory_content_sha256: z.string(),
  /** Ordered per-entry sha256 of the `controls` array at last pull. */
  controls_base: z.array(z.string()),
  /** sha256 of the canonical snapshot (memory hash + ordered control hashes). */
  remote_snapshot_sha256: z.string(),
  /** Wall-clock time of the last pull (ISO 8601). */
  last_pull_at: z.string(),
  /** Server `updated_at` seen at last pull; null if the project had no memory. */
  remote_updated_at: z.string().nullable(),
});

/** Parsed, validated memory sidecar. Inferred from {@link MemoryStateSchema}. */
export type MemoryState = z.infer<typeof MemoryStateSchema>;

/**
 * Read and validate the memory sidecar from a `memory/` directory.
 *
 * @param dir - The `memory/` directory containing {@link MEMORY_STATE_FILENAME}.
 * @returns The parsed state, or undefined if no sidecar exists (first pull).
 * @throws If the file exists but is not valid JSON or fails schema validation --
 * corruption is surfaced, not silently reset.
 */
export function readMemoryState(dir: string): MemoryState | undefined {
  const filePath = path.join(dir, MEMORY_STATE_FILENAME);
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf-8");
  return MemoryStateSchema.parse(JSON.parse(raw));
}

/**
 * Write the memory sidecar atomically (tmp file + rename) with owner-only
 * permissions. If the process dies mid-write the previous sidecar is left
 * intact. Creates `dir` recursively if needed.
 *
 * @param dir - The `memory/` directory to write {@link MEMORY_STATE_FILENAME} into.
 * @param state - State to persist as pretty-printed JSON.
 */
export function writeMemoryState(dir: string, state: MemoryState): void {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, MEMORY_STATE_FILENAME);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/state.ts packages/core/test/memory/state.test.ts
```
```bash
git commit -m "feat(core): memory state sidecar (atomic, 0600)"
```

---

### Task 5: Pull engine (fetch + decide + materialize)

**Files:**
- Create: `packages/core/src/memory/pull.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/memory/pull.test.ts`

**Interfaces:**
- Consumes: `hashContent` (Task 2), `canonicalize`/`serializeEdits` (Task 3), `readMemoryState`/`writeMemoryState`/`MemoryState` (Task 4), `ProjectMemory` (Task 1).
- Produces:
  - `computePrincipalFingerprint(accountId: string): string` = `hashContent(accountId)`.
  - `snapshotHash(memoryHash: string, controlHashes: string[]): string` -- stable hash over `memoryHash + "\n" + controlHashes.join("\n")`.
  - `MemoryPullOutcome = { action: "written" | "unchanged" | "conflict" | "no-memory"; memoryChanged: boolean; controlsCount: number }`
  - `pullProjectMemory(opts: { remote: ProjectMemory; accountId: string; projectId: string; dir: string; now: string; force?: boolean }): MemoryPullOutcome` -- pure of the network (caller fetches via `getProjectMemory` and passes `remote`), does all fs work. Writes `MEMORY.md`, `edits.md`, sidecar atomically; idempotent; principal-mismatch and local-dirty guarded.

**Behavior (from design section 5, two managed entities):**
- If `remote.controls === null` and `remote.memory === ""` -> outcome `no-memory`, write nothing.
- Principal mismatch vs existing sidecar -> throw (fail closed) unless `force`.
- Compute remote hashes (canonicalize memory; per-entry hash of `controls`). No prior sidecar -> initial write. Prior sidecar with `remote_snapshot_sha256` equal to the new snapshot AND local files still match their base hashes -> `unchanged` (touch nothing, not even the sidecar timestamp when the API `updated_at` is unchanged).
- Local `MEMORY.md`/`edits.md` modified since base (local hash != base) while remote also changed -> `conflict` for that entity: do not overwrite; report. `MEMORY.md` is GET-only so a local edit there is always "you edited a read-only mirror"; with `force`, re-pull overwrites it.
- Otherwise write both files (canonicalized memory -> `MEMORY.md`; `serializeEdits(controls)` -> `edits.md`) via tmp+rename, then the sidecar.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/memory/pull.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pullProjectMemory, computePrincipalFingerprint } from "@core/memory/pull.js";
import { readMemoryState } from "@core/memory/state.js";
import { parseEdits } from "@core/memory/edits.js";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
function mkdir() { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-")); return dir; }

const base = { accountId: "acct-1", projectId: "proj-1", now: "2026-07-13T00:00:00.000Z" };
const remote = (memory: string, controls: string[] | null, updated_at: string | null = "2026-07-12T00:00:00Z") =>
  ({ memory, controls, updated_at });

describe("pullProjectMemory", () => {
  it("no-memory: ungenerated project writes nothing", () => {
    const d = mkdir();
    const out = pullProjectMemory({ ...base, dir: d, remote: remote("", null, null) });
    expect(out.action).toBe("no-memory");
    expect(fs.existsSync(path.join(d, "MEMORY.md"))).toBe(false);
  });

  it("initial pull writes MEMORY.md, edits.md, and sidecar", () => {
    const d = mkdir();
    const out = pullProjectMemory({ ...base, dir: d, remote: remote("**Memory**\n", ["Prefer rye.", "Open 6am."]) });
    expect(out.action).toBe("written");
    expect(out.controlsCount).toBe(2);
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("**Memory**\n");
    expect(parseEdits(fs.readFileSync(path.join(d, "edits.md"), "utf-8"))).toEqual(["Prefer rye.", "Open 6am."]);
    const st = readMemoryState(d);
    expect(st?.project_uuid).toBe("proj-1");
    expect(st?.principal_fingerprint).toBe(computePrincipalFingerprint("acct-1"));
  });

  it("is idempotent: second identical pull is unchanged", () => {
    const d = mkdir();
    const r = remote("**Memory**\n", ["Prefer rye."]);
    pullProjectMemory({ ...base, dir: d, remote: r });
    const mtime1 = fs.statSync(path.join(d, "MEMORY.md")).mtimeMs;
    const out = pullProjectMemory({ ...base, dir: d, remote: r });
    expect(out.action).toBe("unchanged");
    expect(fs.statSync(path.join(d, "MEMORY.md")).mtimeMs).toBe(mtime1);
  });

  it("nightly regen: changed remote memory rewrites the doc", () => {
    const d = mkdir();
    pullProjectMemory({ ...base, dir: d, remote: remote("v1\n", ["a"]) });
    const out = pullProjectMemory({ ...base, dir: d, remote: remote("v2 regenerated\n", ["a"], "2026-07-13T07:00:00Z") });
    expect(out.action).toBe("written");
    expect(out.memoryChanged).toBe(true);
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("v2 regenerated\n");
  });

  it("principal mismatch fails closed", () => {
    const d = mkdir();
    pullProjectMemory({ ...base, dir: d, remote: remote("m\n", ["a"]) });
    expect(() =>
      pullProjectMemory({ ...base, accountId: "different-acct", dir: d, remote: remote("m2\n", ["a"]) })
    ).toThrow(/principal/i);
  });

  it("local edit to MEMORY.md + changed remote = conflict, no overwrite (without force)", () => {
    const d = mkdir();
    pullProjectMemory({ ...base, dir: d, remote: remote("v1\n", ["a"]) });
    fs.writeFileSync(path.join(d, "MEMORY.md"), "locally hand-edited\n", "utf-8");
    const out = pullProjectMemory({ ...base, dir: d, remote: remote("v2\n", ["a"], "2026-07-13T07:00:00Z") });
    expect(out.action).toBe("conflict");
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("locally hand-edited\n");
  });

  it("force overrides conflict and re-pulls", () => {
    const d = mkdir();
    pullProjectMemory({ ...base, dir: d, remote: remote("v1\n", ["a"]) });
    fs.writeFileSync(path.join(d, "MEMORY.md"), "locally hand-edited\n", "utf-8");
    const out = pullProjectMemory({ ...base, dir: d, force: true, remote: remote("v2\n", ["a"], "2026-07-13T07:00:00Z") });
    expect(out.action).toBe("written");
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("v2\n");
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/pull.test.ts`
Expected: FAIL -- module missing.

- [ ] **Step 3: Implement**

Create `packages/core/src/memory/pull.ts`. Implement exactly the behavior enumerated above. Key points the implementer must honor:
- `MEMORY.md` and `edits.md` are written via tmp+rename with mode `0600` (add a small local `writeFileAtomic(filePath, text)` helper, or reuse the pattern from state.ts).
- Canonicalize the memory doc before writing and before hashing. `edits.md` on disk = `serializeEdits(remote.controls ?? [])`; its base hash for change detection = `hashContent(serializeEdits(...))` (hash the serialized file form so local file re-read compares apples to apples).
- "Local dirty" detection: read the on-disk `MEMORY.md`/`edits.md` if present, `hashContent(canonicalize(read))` / `hashContent(read)`, compare to sidecar base.
- `unchanged` requires: sidecar exists, `remote_snapshot_sha256` equals the freshly computed snapshot, AND neither local file is dirty. In that case return without writing (idempotent).
- Full TSDoc on every export and the outcome type's members.

Add to `packages/core/src/index.ts` a memory export block:

```ts
export {
  pullProjectMemory,
  computePrincipalFingerprint,
} from "./memory/pull.js";
export type { MemoryPullOutcome } from "./memory/pull.js";
export { readMemoryState, writeMemoryState, MEMORY_STATE_FILENAME } from "./memory/state.js";
export type { MemoryState } from "./memory/state.js";
export { canonicalize, serializeEdits, parseEdits } from "./memory/edits.js";
export { hashContent } from "./memory/hash.js";
```

- [ ] **Step 4: Run it, expect pass**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/pull.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Full core suite + typecheck**

Run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run` then `pnpm --filter @infinite-room-labs/claudesync-core exec tsc --noEmit`
Expected: all green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/memory/pull.ts packages/core/src/index.ts packages/core/test/memory/pull.test.ts
```
```bash
git commit -m "feat(core): memory pull engine (idempotent, atomic, conflict-guarded)"
```

---

### Task 6: CLI `projects memory show | pull | status`

**Files:**
- Modify: `packages/cli/src/commands/projects.ts`
- Test: manual (CLI shell over the engine; core logic is already unit-tested).

**Interfaces:**
- Consumes: `ClaudeSyncClient.getProjectMemory`, `pullProjectMemory`, `computePrincipalFingerprint`, `readMemoryState` from core; `createClient`, `resolveOrgId`, `outputJson` from `../utils.js`.
- Produces: a `memory` sub-subcommand group under the existing `projectsCommand`.

**Semantics:**
- `projects memory show <project-id> [--org] [--json]` -- fetch and print the memory doc; `--json` prints the raw `{memory, controls, updated_at}`. Non-JSON prints the doc, then a footer `N edit(s)`.
- `projects memory pull <project-id> [--org] [--output <dir>] [--force]` -- fetch, then `pullProjectMemory` into `<output>/memory/` (default output `./<project-slug>/`); print the outcome action. `no-memory` prints a hint: "This project has no generated memory yet -- chat in it and wait for the nightly generation." `conflict` prints which file and suggests `--force`.
- `projects memory status <project-id> [--org] [--output <dir>]` -- fetch remote, read local sidecar, and report one of: `no local pull`, `clean`, `remote changed (pull to update)`, `local edit to edits.md (pending push -- phase 2)`, `conflict`. Content-free.

- [ ] **Step 1: Implement the subcommand group**

In `packages/cli/src/commands/projects.ts`, add imports for `pullProjectMemory`, `computePrincipalFingerprint`, `readMemoryState` and (for the account id) whatever `createClient`/auth exposes as the account/org identifier used as the principal. Use `resolveOrgId` for org, and the org id (or account id if available) consistently as `accountId` for the fingerprint -- WHATEVER is chosen, document it inline and use the same value in pull and status so fingerprints match. Add:

```ts
const memoryCommand = projectsCommand
  .command("memory")
  .description("View and sync a project's memory (the generated doc + edit list)");

memoryCommand
  .command("show")
  .argument("<project-id>", "Project UUID")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--json", "Output raw memory JSON")
  .action(async (projectId: string, options: { org?: string; json?: boolean }) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const mem = await client.getProjectMemory(orgId, projectId);
    if (options.json) { outputJson(mem); return; }
    if (mem.controls === null && mem.memory === "") {
      console.log("This project has no generated memory yet.");
      return;
    }
    console.log(mem.memory);
    console.log(`\n  ${mem.controls?.length ?? 0} edit(s)`);
  });
```

Add `pull` and `status` subcommands following the same shape, calling `pullProjectMemory({ remote, accountId, projectId, dir: resolve(output, "memory"), now: new Date().toISOString(), force })` and printing `outcome.action` with the hints above. For `status`, compute the same values `pull` would but branch on `readMemoryState` + local-file hashes without writing.

- [ ] **Step 2: Build the workspace**

Run: `pnpm build`
Expected: no TypeScript errors across packages.

- [ ] **Step 3: Smoke test against the throwaway or a real project (read-only)**

Run (uses your live cookie via the CLI's normal auth path):
```bash
node packages/cli/dist/index.js projects memory show <a-real-project-uuid>
```
Expected: prints the memory doc + edit count. Then:
```bash
node packages/cli/dist/index.js projects memory pull <a-real-project-uuid> --output /tmp/mem-smoke
node packages/cli/dist/index.js projects memory pull <a-real-project-uuid> --output /tmp/mem-smoke
```
Expected: first prints `written`, second prints `unchanged` (idempotency proven end to end). Inspect `/tmp/mem-smoke/memory/` for `MEMORY.md`, `edits.md`, `.claudesync-memory-state.json`. Then `rm -rf /tmp/mem-smoke`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/projects.ts
```
```bash
git commit -m "feat(cli): projects memory show/pull/status"
```

---

### Task 7: MCP read tool `get_project_memory`

**Files:**
- Modify: `packages/mcp-server/src/server.ts`
- Test: manual (thin shell; server smoke).

**Interfaces:**
- Consumes: `client.getProjectMemory`, the existing `withErrorHandling` + `auth.getOrganizationId()` patterns in `server.ts`.
- Produces: one read-only tool `get_project_memory`.

- [ ] **Step 1: Register the tool**

In `packages/mcp-server/src/server.ts`, alongside the existing `server.tool(...)` registrations, add:

```ts
  // --- get_project_memory ---
  server.tool(
    "get_project_memory",
    "Get a claude.ai project's memory: the server-generated memory document plus its ordered edit-instruction list (controls). Read-only.",
    {
      projectId: z.string().describe("The project UUID"),
      orgId: z.string().optional().describe("Organization UUID. Omit to auto-detect from session."),
    },
    async ({ projectId, orgId }) => {
      return withErrorHandling(async () => {
        const resolvedOrgId = orgId ?? (await auth.getOrganizationId());
        const mem = await client.getProjectMemory(resolvedOrgId, projectId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(mem, null, 2) }],
        };
      });
    }
  );
```

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: no errors.

- [ ] **Step 3: Smoke test the tool over stdio**

Start the server and confirm the tool lists and returns. Minimal check:
```bash
node packages/mcp-server/dist/index.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
EOF
```
Expected: `get_project_memory` appears in the tool list. (A full call requires a live session and a real project UUID; verify at least registration.)

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/server.ts
```
```bash
git commit -m "feat(mcp): get_project_memory read tool"
```

---

### Task 8: Changelog + finish branch

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the Unreleased entry**

Under `## [Unreleased]` add an `### Added` section (or append to it) with one entry, content-free:

```markdown
### Added
- **Project memory pull (Phase 1).** New SDK `getProjectMemory` read, a
  `packages/core/src/memory/` module (canonicalization, `edits.md` serialization,
  hash sidecar, idempotent + atomic pull engine with conflict and
  principal-mismatch guards), CLI `projects memory show|pull|status`, and a
  read-only `get_project_memory` MCP tool. Pull materializes `memory/MEMORY.md`
  (server-generated doc) + `memory/edits.md` (the `controls` list) + a hash
  sidecar. Read-only; no writes to claude.ai (Phase 2 adds push). See
  `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md`.
```

- [ ] **Step 2: Full test + build gate**

Run: `pnpm build && pnpm test`
Expected: all green.

- [ ] **Step 3: Stage and commit**

```bash
git add CHANGELOG.md
```
```bash
git commit -m "docs: changelog for project memory pull (phase 1)"
```

- [ ] **Step 4: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to merge `feat/memory-pull` (present PR vs direct-merge options).

---

## Self-Review Notes

- **Spec coverage (design section 5 + P1 list):** getProjectMemory (T1), local layout `MEMORY.md`+`edits.md`+sidecar (T4/T5), hash merge with the six-row table (T5 behavior + tests), idempotent no-op + nightly churn (T5 tests), principal mismatch fail-closed (T5), CLI show/pull/status (T6), read-only MCP tool (T7), changelog/git (each task commits; T8 changelog). `--include-memory` project-export integration is INTENTIONALLY DEFERRED to keep this plan shippable on its own -- it is a small follow-on (wire memory into `assembleProjectBundle`/`writeProjectBundle`) that can be its own plan; flagged here so it is not forgotten.
- **No txn-core dependency:** atomicity uses tmp+rename (matching `sync/state.ts`), so this phase does not block on the unbuilt idea-099 module. Phase 2 (push) revisits journaling.
- **Placeholder scan:** none -- every code step has complete content.
- **Type consistency:** `ProjectMemory` (T1) flows into `pullProjectMemory`'s `remote` (T5); `MemoryState` fields (T4) are exactly what T5 reads/writes; `computePrincipalFingerprint` (T5) is the single fingerprint source used by CLI pull + status (T6).
- **Open risk carried from spike:** an ungenerated project returns `controls: null` -> handled explicitly as the `no-memory` outcome (T5) with a user hint (T6), not a false success.
