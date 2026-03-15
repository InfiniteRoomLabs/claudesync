# ClaudeSync TUI — Miller Columns Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive terminal UI (TUI) to the ClaudeSync CLI that launches when no subcommand is given. Uses Miller Columns (macOS Finder-style) to browse orgs, conversations, projects, and artifacts with vim keybinds.

**Architecture:** React + Ink renders to the terminal. Three-column Miller layout where `h/l` navigate between columns (drill in/out) and `j/k` scroll within a column. The rightmost column shows either a child list or a detail preview depending on the data type. State machine tracks the current navigation path (org > conversations > conversation > messages/artifacts).

**Tech Stack:** `ink` (React terminal renderer), `react` (component model), `ink-text-input` (search), `@infinite-room-labs/claudesync-core` (SDK)

---

## File Structure

```
packages/cli/src/
├── index.ts                          # Modified: launch TUI when no subcommand
├── tui/
│   ├── App.tsx                       # Root component: layout + column orchestration
│   ├── hooks/
│   │   ├── useNavigation.ts          # Navigation state machine (path stack, selection per level)
│   │   ├── useData.ts                # Async data fetching with loading/error states
│   │   └── useVimKeys.ts             # h/j/k/l + /, e, q key bindings
│   ├── components/
│   │   ├── Column.tsx                # Single scrollable column with selectable items
│   │   ├── DetailPane.tsx            # Right-most column: metadata + action buttons
│   │   ├── MessagePreview.tsx        # Conversation message list preview
│   │   ├── KeyBar.tsx                # Bottom bar showing available keybinds
│   │   └── SearchOverlay.tsx         # / search modal overlay
│   └── types.ts                      # Navigation path types, column item types
```

---

## Chunk 1: Dependencies + Scaffolding

### Task 1: Add React + Ink Dependencies

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/tsconfig.json`

- [ ] **Step 1: Install dependencies**

```bash
cd packages/cli
pnpm add ink react ink-text-input
pnpm add -D @types/react @inkjs/ui
```

- [ ] **Step 2: Update tsconfig.json for JSX**

Add `"jsx": "react-jsx"` to compilerOptions. Ink uses React's JSX transform.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 3: Verify build works**

Run: `pnpm build`
Expected: Compiles with no errors (no TSX files yet, just config)

- [ ] **Step 4: Commit**

```bash
git add packages/cli/package.json packages/cli/tsconfig.json pnpm-lock.yaml
git commit -m "feat(cli): add React + Ink dependencies for TUI"
```

---

### Task 2: Navigation Types + State Machine Hook

**Files:**
- Create: `packages/cli/src/tui/types.ts`
- Create: `packages/cli/src/tui/hooks/useNavigation.ts`

- [ ] **Step 1: Define navigation types**

`packages/cli/src/tui/types.ts`:

```typescript
// Each level in the Miller Columns hierarchy
export type NavigationLevel =
  | { type: "orgs" }
  | { type: "org-contents"; orgId: string }
  | { type: "project-list"; orgId: string }
  | { type: "project-detail"; orgId: string; projectId: string }
  | { type: "conversation-detail"; orgId: string; conversationId: string }
  | { type: "messages"; orgId: string; conversationId: string }
  | { type: "artifacts"; orgId: string; conversationId: string };

export interface ColumnItem {
  id: string;
  label: string;
  sublabel?: string;
  icon?: string;  // "★" for starred, "▸" for drillable
  drillable: boolean;
}

export interface NavigationState {
  // Stack of levels -- rightmost is the deepest. Always 1-3 items shown.
  path: NavigationLevel[];
  // Selected index per level (keyed by level index in path)
  selections: Map<number, number>;
  // Which column is focused (0 = leftmost visible, 1, 2)
  focusedColumn: number;
}
```

- [ ] **Step 2: Implement useNavigation hook**

`packages/cli/src/tui/hooks/useNavigation.ts`:

The hook manages a path stack and selection indices. Key operations:
- `drillIn(level)` -- push a new level, shift focus right
- `drillOut()` -- pop the rightmost level, shift focus left
- `moveSelection(delta)` -- move selection up/down in focused column
- `focusColumn(index)` -- switch focus between visible columns

The visible columns are always the last 3 (or fewer) items in the path stack. When the path has 4+ levels, earlier levels scroll off the left edge.

```typescript
import { useState, useCallback } from "react";
import type { NavigationLevel, NavigationState } from "../types.js";

export function useNavigation() {
  const [state, setState] = useState<NavigationState>({
    path: [{ type: "orgs" }],
    selections: new Map([[0, 0]]),
    focusedColumn: 0,
  });

  const drillIn = useCallback((level: NavigationLevel) => {
    setState((prev) => {
      const newPath = [...prev.path, level];
      const newSelections = new Map(prev.selections);
      newSelections.set(newPath.length - 1, 0);
      return {
        path: newPath,
        selections: newSelections,
        focusedColumn: Math.min(prev.focusedColumn + 1, 2),
      };
    });
  }, []);

  const drillOut = useCallback(() => {
    setState((prev) => {
      if (prev.path.length <= 1) return prev;
      const newPath = prev.path.slice(0, -1);
      return {
        path: newPath,
        selections: prev.selections,
        focusedColumn: Math.max(prev.focusedColumn - 1, 0),
      };
    });
  }, []);

  const moveSelection = useCallback((delta: number, maxItems: number) => {
    setState((prev) => {
      const pathIndex = getPathIndexForColumn(prev);
      const current = prev.selections.get(pathIndex) ?? 0;
      const next = Math.max(0, Math.min(maxItems - 1, current + delta));
      const newSelections = new Map(prev.selections);
      newSelections.set(pathIndex, next);
      return { ...prev, selections: newSelections };
    });
  }, []);

  // The visible columns are the last 3 in the path
  const visibleStart = Math.max(0, state.path.length - 3);
  const visiblePath = state.path.slice(visibleStart);

  const getSelection = (columnIndex: number): number => {
    const pathIndex = visibleStart + columnIndex;
    return state.selections.get(pathIndex) ?? 0;
  };

  return {
    state,
    visiblePath,
    focusedColumn: state.focusedColumn,
    getSelection,
    drillIn,
    drillOut,
    moveSelection,
  };
}

function getPathIndexForColumn(state: NavigationState): number {
  const visibleStart = Math.max(0, state.path.length - 3);
  return visibleStart + state.focusedColumn;
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: Compiles. No tests for hooks yet (they need Ink's test renderer).

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/tui/
git commit -m "feat(cli): add TUI navigation types and useNavigation hook"
```

---

### Task 3: Column Component

**Files:**
- Create: `packages/cli/src/tui/components/Column.tsx`

- [ ] **Step 1: Implement Column**

The Column component renders a scrollable list of items with one highlighted selection. It uses Ink's `<Box>` for layout and `<Text>` for styled text. The selected item gets an inverse color treatment.

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ColumnItem } from "../types.js";

interface ColumnProps {
  title: string;
  items: ColumnItem[];
  selectedIndex: number;
  focused: boolean;
  height: number;
}

export function Column({ title, items, selectedIndex, focused, height }: ColumnProps) {
  // Calculate scroll window to keep selection visible
  const visibleCount = height - 2; // minus header and bottom padding
  const scrollStart = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), items.length - visibleCount));
  const visibleItems = items.slice(scrollStart, scrollStart + visibleCount);

  return (
    <Box flexDirection="column" borderStyle={focused ? "bold" : "single"} borderColor={focused ? "blue" : "gray"} width="33%" height={height}>
      <Box paddingX={1}>
        <Text bold color={focused ? "blue" : "white"}>{title}</Text>
      </Box>
      {visibleItems.map((item, i) => {
        const actualIndex = scrollStart + i;
        const isSelected = actualIndex === selectedIndex;
        return (
          <Box key={item.id} paddingX={1}>
            <Text
              inverse={isSelected && focused}
              color={isSelected && !focused ? "blue" : undefined}
              dimColor={!isSelected && !focused}
            >
              {item.icon ? `${item.icon} ` : "  "}
              {item.label}
              {item.sublabel ? ` ${item.sublabel}` : ""}
            </Text>
          </Box>
        );
      })}
      {items.length > visibleCount && (
        <Box paddingX={1}>
          <Text dimColor>{scrollStart + visibleCount}/{items.length}</Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Compiles with TSX support

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/components/Column.tsx
git commit -m "feat(cli): add Column component for Miller Columns layout"
```

---

### Task 4: KeyBar + DetailPane Components

**Files:**
- Create: `packages/cli/src/tui/components/KeyBar.tsx`
- Create: `packages/cli/src/tui/components/DetailPane.tsx`
- Create: `packages/cli/src/tui/components/MessagePreview.tsx`

- [ ] **Step 1: Implement KeyBar**

```tsx
import React from "react";
import { Box, Text } from "ink";

interface KeyBarProps {
  extraKeys?: Array<{ key: string; action: string }>;
}

export function KeyBar({ extraKeys = [] }: KeyBarProps) {
  const keys = [
    { key: "h", action: "← back" },
    { key: "j", action: "↓ down" },
    { key: "k", action: "↑ up" },
    { key: "l", action: "→ into" },
    ...extraKeys,
    { key: "/", action: "search" },
    { key: "e", action: "export" },
    { key: "q", action: "quit" },
  ];

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      {keys.map((k, i) => (
        <React.Fragment key={k.key}>
          <Text bold color="yellow">{k.key}</Text>
          <Text dimColor> {k.action}</Text>
          {i < keys.length - 1 && <Text dimColor>  </Text>}
        </React.Fragment>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: Implement DetailPane**

Shows metadata for the selected conversation or project. Renders action buttons.

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ConversationSummary, Project } from "@infinite-room-labs/claudesync-core";

interface DetailPaneProps {
  item: ConversationSummary | Project | null;
  type: "conversation" | "project" | null;
  focused: boolean;
  height: number;
}

export function DetailPane({ item, type, focused, height }: DetailPaneProps) {
  if (!item) {
    return (
      <Box flexDirection="column" borderStyle={focused ? "bold" : "single"} borderColor="gray" width="34%" height={height}>
        <Box paddingX={1} justifyContent="center">
          <Text dimColor>Select an item to view details</Text>
        </Box>
      </Box>
    );
  }

  const isConv = type === "conversation";
  const conv = isConv ? (item as ConversationSummary) : null;
  const proj = !isConv ? (item as Project) : null;

  return (
    <Box flexDirection="column" borderStyle={focused ? "bold" : "single"} borderColor={focused ? "blue" : "gray"} width="34%" height={height}>
      <Box paddingX={1}>
        <Text bold color="blue" wrap="truncate">{item.name}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        {conv && (
          <>
            <Text>Model:     <Text color="cyan">{conv.model ?? "unknown"}</Text></Text>
            <Text>Created:   {conv.created_at?.substring(0, 10)}</Text>
            <Text>Updated:   {conv.updated_at?.substring(0, 10)}</Text>
            <Text>Starred:   {conv.is_starred ? "★ yes" : "no"}</Text>
            {conv.project_uuid && <Text>Project:   {conv.project?.name ?? conv.project_uuid}</Text>}
          </>
        )}
        {proj && (
          <>
            <Text>Docs:      {proj.docs_count ?? 0}</Text>
            <Text>Files:     {proj.files_count ?? 0}</Text>
            <Text>Created:   {proj.created_at?.substring(0, 10)}</Text>
            <Text>Private:   {proj.is_private ? "yes" : "no"}</Text>
            {proj.description && <Text wrap="wrap">{"\n"}{proj.description}</Text>}
          </>
        )}
      </Box>
      <Box paddingX={1} paddingTop={1} gap={1}>
        <Text color="green" bold>[e]</Text><Text>xport</Text>
        <Text color="yellow" bold>[/]</Text><Text>search</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 3: Implement MessagePreview**

Shows a scrollable list of messages from a conversation.

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "@infinite-room-labs/claudesync-core";

interface MessagePreviewProps {
  messages: ChatMessage[];
  height: number;
}

export function MessagePreview({ messages, height }: MessagePreviewProps) {
  const visibleCount = height - 2;
  const visible = messages.slice(0, visibleCount);

  return (
    <Box flexDirection="column">
      {visible.map((msg) => (
        <Box key={msg.uuid} flexDirection="column" paddingX={1} paddingBottom={1}>
          <Text bold color={msg.sender === "human" ? "blue" : "magenta"}>
            {msg.sender === "human" ? "Human" : "Assistant"}
            <Text dimColor>  {msg.created_at?.substring(11, 16)}</Text>
          </Text>
          <Text wrap="truncate-end">{msg.text.substring(0, 200)}</Text>
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: All TSX components compile

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tui/components/
git commit -m "feat(cli): add KeyBar, DetailPane, and MessagePreview components"
```

---

## Chunk 2: Data Fetching + App Assembly

### Task 5: useData Hook — Async Data Fetching

**Files:**
- Create: `packages/cli/src/tui/hooks/useData.ts`

- [ ] **Step 1: Implement useData**

Hook that manages async data loading with loading/error states. Caches results so drilling out doesn't re-fetch.

```typescript
import { useState, useEffect, useRef } from "react";
import type { ClaudeSyncClient, Organization, ConversationSummary, Project, Conversation } from "@infinite-room-labs/claudesync-core";
import type { NavigationLevel } from "../types.js";

interface DataState {
  loading: boolean;
  error: string | null;
}

export function useData(client: ClaudeSyncClient) {
  const cache = useRef(new Map<string, unknown>());
  const [dataState, setDataState] = useState<DataState>({ loading: false, error: null });

  async function fetchForLevel(level: NavigationLevel): Promise<unknown> {
    const key = JSON.stringify(level);
    if (cache.current.has(key)) return cache.current.get(key);

    setDataState({ loading: true, error: null });
    try {
      let data: unknown;
      switch (level.type) {
        case "orgs":
          data = await client.listOrganizations();
          break;
        case "org-contents":
          data = await client.listConversationsAll(level.orgId);
          break;
        case "project-list":
          data = await client.listProjects(level.orgId);
          break;
        case "conversation-detail":
          data = await client.getConversation(level.orgId, level.conversationId);
          break;
        case "project-detail":
          data = await client.getProjectDocs(level.orgId, level.projectId);
          break;
        case "artifacts":
          data = await client.listArtifacts(level.orgId, level.conversationId);
          break;
        default:
          data = null;
      }
      cache.current.set(key, data);
      setDataState({ loading: false, error: null });
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDataState({ loading: false, error: msg });
      return null;
    }
  }

  return { fetchForLevel, dataState, cache: cache.current };
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/hooks/useData.ts
git commit -m "feat(cli): add useData hook for async data fetching with cache"
```

---

### Task 6: useVimKeys Hook

**Files:**
- Create: `packages/cli/src/tui/hooks/useVimKeys.ts`

- [ ] **Step 1: Implement useVimKeys**

Wraps Ink's `useInput` to map vim keys and special keys to navigation actions.

```typescript
import { useInput } from "ink";

interface VimKeyHandlers {
  onLeft: () => void;
  onDown: () => void;
  onUp: () => void;
  onRight: () => void;
  onSearch: () => void;
  onExport: () => void;
  onQuit: () => void;
}

export function useVimKeys(handlers: VimKeyHandlers, enabled = true) {
  useInput((input, key) => {
    if (!enabled) return;

    // vim keys
    if (input === "h" || key.leftArrow) handlers.onLeft();
    if (input === "j" || key.downArrow) handlers.onDown();
    if (input === "k" || key.upArrow) handlers.onUp();
    if (input === "l" || key.rightArrow) handlers.onRight();

    // actions
    if (input === "/") handlers.onSearch();
    if (input === "e") handlers.onExport();
    if (input === "q") handlers.onQuit();
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/tui/hooks/useVimKeys.ts
git commit -m "feat(cli): add useVimKeys hook for vim-style navigation"
```

---

### Task 7: App Root Component

**Files:**
- Create: `packages/cli/src/tui/App.tsx`

- [ ] **Step 1: Implement App**

The root component wires together navigation, data fetching, and rendering. It determines what data each of the 3 visible columns should show based on the current navigation path.

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import { EnvAuth, ClaudeSyncClient } from "@infinite-room-labs/claudesync-core";
import type { Organization, ConversationSummary, Project, Conversation } from "@infinite-room-labs/claudesync-core";
import { useNavigation } from "./hooks/useNavigation.js";
import { useData } from "./hooks/useData.js";
import { useVimKeys } from "./hooks/useVimKeys.js";
import { Column } from "./components/Column.js";
import { DetailPane } from "./components/DetailPane.js";
import { KeyBar } from "./components/KeyBar.js";
import { MessagePreview } from "./components/MessagePreview.js";
import type { ColumnItem, NavigationLevel } from "./types.js";

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const columnHeight = termHeight - 4; // minus header + keybar

  // SDK
  const [client] = useState(() => {
    const auth = new EnvAuth();
    return new ClaudeSyncClient(auth);
  });

  const nav = useNavigation();
  const data = useData(client);

  // Data for each visible column
  const [columns, setColumns] = useState<Array<{ title: string; items: ColumnItem[]; rawData: unknown[] }>>([]);
  const [detailItem, setDetailItem] = useState<{ item: any; type: "conversation" | "project" | null }>({ item: null, type: null });
  const [messages, setMessages] = useState<Conversation | null>(null);

  // Fetch data when navigation changes
  useEffect(() => {
    loadColumns();
  }, [nav.state.path.length, nav.focusedColumn, JSON.stringify(nav.state.selections)]);

  async function loadColumns() {
    const cols: typeof columns = [];

    for (let i = 0; i < nav.visiblePath.length; i++) {
      const level = nav.visiblePath[i];
      const rawData = await data.fetchForLevel(level);
      const items = levelToItems(level, rawData);
      cols.push({ title: levelTitle(level), items, rawData: rawData as any[] });
    }

    setColumns(cols);

    // Update detail pane based on focused column selection
    updateDetailForSelection(cols);
  }

  function updateDetailForSelection(cols: typeof columns) {
    const focusedCol = cols[nav.focusedColumn];
    if (!focusedCol) return;

    const sel = nav.getSelection(nav.focusedColumn);
    const rawItem = focusedCol.rawData?.[sel];
    const level = nav.visiblePath[nav.focusedColumn];

    if (level?.type === "org-contents" && rawItem) {
      setDetailItem({ item: rawItem, type: "conversation" });
    } else if (level?.type === "project-list" && rawItem) {
      setDetailItem({ item: rawItem, type: "project" });
    } else {
      setDetailItem({ item: null, type: null });
    }
  }

  // Keyboard navigation
  useVimKeys({
    onLeft: () => nav.drillOut(),
    onDown: () => {
      const col = columns[nav.focusedColumn];
      if (col) nav.moveSelection(1, col.items.length);
    },
    onUp: () => {
      const col = columns[nav.focusedColumn];
      if (col) nav.moveSelection(-1, col.items.length);
    },
    onRight: () => {
      const col = columns[nav.focusedColumn];
      if (!col) return;
      const sel = nav.getSelection(nav.focusedColumn);
      const item = col.items[sel];
      if (!item?.drillable) return;

      const currentLevel = nav.visiblePath[nav.focusedColumn];
      const nextLevel = getNextLevel(currentLevel, item.id, col.rawData);
      if (nextLevel) nav.drillIn(nextLevel);
    },
    onSearch: () => { /* TODO: search overlay */ },
    onExport: () => { /* TODO: export selected */ },
    onQuit: () => exit(),
  });

  return (
    <Box flexDirection="column" height={termHeight}>
      <Box paddingX={1}>
        <Text bold color="cyan">ClaudeSync</Text>
        <Text dimColor>  {data.dataState.loading ? "loading..." : ""}</Text>
        {data.dataState.error && <Text color="red">  {data.dataState.error}</Text>}
      </Box>
      <Box flexGrow={1}>
        {columns.map((col, i) => (
          <Column
            key={`${i}-${col.title}`}
            title={col.title}
            items={col.items}
            selectedIndex={nav.getSelection(i)}
            focused={i === nav.focusedColumn}
            height={columnHeight}
          />
        ))}
        {columns.length < 3 && (
          <DetailPane
            item={detailItem.item}
            type={detailItem.type}
            focused={false}
            height={columnHeight}
          />
        )}
      </Box>
      <KeyBar />
    </Box>
  );
}

// --- Helpers ---

function levelToItems(level: NavigationLevel, rawData: unknown): ColumnItem[] {
  if (!rawData || !Array.isArray(rawData)) return [];

  switch (level.type) {
    case "orgs":
      return (rawData as Organization[]).map((o) => ({
        id: o.uuid, label: o.name, drillable: true, icon: "▸",
      }));
    case "org-contents": {
      const convs = (rawData as ConversationSummary[]).map((c) => ({
        id: c.uuid, label: c.name,
        sublabel: c.model?.replace("claude-", "") ?? "",
        icon: c.is_starred ? "★" : " ",
        drillable: true,
      }));
      // Add Projects entry at the end
      convs.push({ id: "__projects__", label: "Projects", icon: "▸", drillable: true });
      return convs;
    }
    case "project-list":
      return (rawData as Project[]).map((p) => ({
        id: p.uuid, label: p.name,
        sublabel: `${p.docs_count ?? 0} docs`,
        icon: "▸", drillable: true,
      }));
    case "conversation-detail": {
      const conv = rawData as Conversation;
      return [
        { id: "__messages__", label: `Messages (${conv.chat_messages.length})`, icon: "▸", drillable: true },
        { id: "__artifacts__", label: "Artifacts", icon: "▸", drillable: true },
      ];
    }
    default:
      return [];
  }
}

function levelTitle(level: NavigationLevel): string {
  switch (level.type) {
    case "orgs": return "Organizations";
    case "org-contents": return "Conversations";
    case "project-list": return "Projects";
    case "conversation-detail": return "Conversation";
    case "messages": return "Messages";
    case "artifacts": return "Artifacts";
    case "project-detail": return "Project Docs";
    default: return "";
  }
}

function getNextLevel(current: NavigationLevel, selectedId: string, _rawData: unknown): NavigationLevel | null {
  switch (current.type) {
    case "orgs":
      return { type: "org-contents", orgId: selectedId };
    case "org-contents":
      if (selectedId === "__projects__") return { type: "project-list", orgId: current.orgId };
      return { type: "conversation-detail", orgId: current.orgId, conversationId: selectedId };
    case "project-list":
      return { type: "project-detail", orgId: current.orgId, projectId: selectedId };
    case "conversation-detail":
      if (selectedId === "__messages__") return { type: "messages", orgId: current.orgId, conversationId: current.conversationId };
      if (selectedId === "__artifacts__") return { type: "artifacts", orgId: current.orgId, conversationId: current.conversationId };
      return null;
    default:
      return null;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: All TSX compiles

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/App.tsx
git commit -m "feat(cli): add App root component with Miller Columns layout"
```

---

### Task 8: Wire TUI into CLI Entry Point

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Add TUI launch when no subcommand**

Update `packages/cli/src/index.ts` to detect when no subcommand was provided and launch the Ink app instead of showing help.

At the bottom of the file, after `program.parseAsync`, check if no command was matched:

```typescript
// Add at top of file:
import { render } from "ink";
import React from "react";
import { App } from "./tui/App.js";

// Replace the last line:
// program.parseAsync(process.argv).catch(handleError);

// With:
const parsed = program.parseAsync(process.argv);
parsed.catch(handleError);

// If no subcommand was given, launch TUI
if (process.argv.length <= 2) {
  // No subcommand -- launch interactive TUI
  render(React.createElement(App));
} else {
  parsed.catch(handleError);
}
```

The key insight: `process.argv.length <= 2` means just `node dist/index.js` with no arguments. Subcommands add argv[2]+.

- [ ] **Step 2: Build and test locally**

Run: `pnpm build`
Then: `CLAUDE_AI_COOKIE="sessionKey=..." node packages/cli/dist/index.js`
Expected: TUI launches with Miller Columns. `q` quits.

Then: `CLAUDE_AI_COOKIE="sessionKey=..." node packages/cli/dist/index.js ls`
Expected: Normal CLI `ls` command output (not TUI).

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): launch TUI when no subcommand provided"
```

---

## Chunk 3: Polish + Search

### Task 9: SearchOverlay Component

**Files:**
- Create: `packages/cli/src/tui/components/SearchOverlay.tsx`

- [ ] **Step 1: Implement search overlay**

When the user presses `/`, a text input appears at the top. It filters the current column's items by name. Pressing Enter selects, Escape cancels.

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface SearchOverlayProps {
  visible: boolean;
  onSubmit: (query: string) => void;
  onCancel: () => void;
}

export function SearchOverlay({ visible, onSubmit, onCancel }: SearchOverlayProps) {
  const [query, setQuery] = useState("");

  useInput((input, key) => {
    if (!visible) return;
    if (key.escape) {
      setQuery("");
      onCancel();
    }
    if (key.return) {
      onSubmit(query);
      setQuery("");
    }
  });

  if (!visible) return null;

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">/</Text>
      <TextInput value={query} onChange={setQuery} />
    </Box>
  );
}
```

- [ ] **Step 2: Wire into App.tsx**

Add search state to App, pass down to SearchOverlay, filter column items when search is active.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/tui/
git commit -m "feat(cli): add search overlay for TUI filtering"
```

---

### Task 10: Final Integration + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Update CHANGELOG**

Add TUI entry under a new section.

- [ ] **Step 2: Update README**

Add TUI section showing that running `claudesync` with no args launches the interactive browser.

- [ ] **Step 3: Full build + test**

```bash
pnpm build
pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(cli): interactive TUI with Miller Columns browser

Launch with 'claudesync' (no subcommand). Browse orgs, conversations,
projects, and artifacts with vim keybinds (h/j/k/l). Three-column
Miller Columns layout with detail preview pane."
```
