import { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import { EnvAuth, ClaudeSyncClient } from "@infinite-room-labs/claudesync-core";
import type { Organization, ConversationSummary, Project, Conversation } from "@infinite-room-labs/claudesync-core";
import { useNavigation } from "./hooks/useNavigation.js";
import { useData } from "./hooks/useData.js";
import { useVimKeys } from "./hooks/useVimKeys.js";
import { Column } from "./components/Column.js";
import { DetailPane } from "./components/DetailPane.js";
import { KeyBar } from "./components/KeyBar.js";
import { SearchOverlay } from "./components/SearchOverlay.js";
import type { ColumnItem, NavigationLevel } from "./types.js";

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const columnHeight = termHeight - 4;

  // SDK
  const [client] = useState(() => {
    const auth = new EnvAuth();
    return new ClaudeSyncClient(auth);
  });

  const nav = useNavigation();
  const data = useData(client);

  // Column data
  const [columns, setColumns] = useState<Array<{ title: string; items: ColumnItem[]; rawData: unknown[] }>>([]);
  const [detailItem, setDetailItem] = useState<{ item: ConversationSummary | Project | null; type: "conversation" | "project" | null }>({ item: null, type: null });

  // Search state
  const [searchActive, setSearchActive] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");

  // Fetch data when navigation changes
  useEffect(() => {
    void loadColumns();
  }, [nav.state.path.length, nav.focusedColumn, JSON.stringify(nav.state.selections)]);

  async function loadColumns() {
    const cols: typeof columns = [];

    for (let i = 0; i < nav.visiblePath.length; i++) {
      const level = nav.visiblePath[i];
      const rawData = await data.fetchForLevel(level);
      let items = levelToItems(level, rawData);

      // Apply search filter to focused column
      if (searchFilter && i === nav.focusedColumn) {
        const lower = searchFilter.toLowerCase();
        items = items.filter((item) => item.label.toLowerCase().includes(lower));
      }

      cols.push({ title: levelTitle(level), items, rawData: Array.isArray(rawData) ? rawData : [] });
    }

    setColumns(cols);
    updateDetailForSelection(cols);
  }

  function updateDetailForSelection(cols: typeof columns) {
    const focusedCol = cols[nav.focusedColumn];
    if (!focusedCol) return;

    const sel = nav.getSelection(nav.focusedColumn);
    const item = focusedCol.items[sel];
    if (!item) {
      setDetailItem({ item: null, type: null });
      return;
    }

    const level = nav.visiblePath[nav.focusedColumn];
    const rawItem = focusedCol.rawData.find((r: any) => r?.uuid === item.id);

    if (level?.type === "org-contents" && rawItem) {
      setDetailItem({ item: rawItem as ConversationSummary, type: "conversation" });
    } else if (level?.type === "project-list" && rawItem) {
      setDetailItem({ item: rawItem as Project, type: "project" });
    } else {
      setDetailItem({ item: null, type: null });
    }
  }

  const handleDrillRight = useCallback(() => {
    const col = columns[nav.focusedColumn];
    if (!col) return;
    const sel = nav.getSelection(nav.focusedColumn);
    const item = col.items[sel];
    if (!item?.drillable) return;

    const currentLevel = nav.visiblePath[nav.focusedColumn];
    const nextLevel = getNextLevel(currentLevel, item.id);
    if (nextLevel) {
      setSearchFilter("");
      nav.drillIn(nextLevel);
    }
  }, [columns, nav]);

  // Keyboard navigation
  useVimKeys({
    onLeft: () => {
      setSearchFilter("");
      nav.drillOut();
    },
    onDown: () => {
      const col = columns[nav.focusedColumn];
      if (col) nav.moveSelection(1, col.items.length);
    },
    onUp: () => {
      const col = columns[nav.focusedColumn];
      if (col) nav.moveSelection(-1, col.items.length);
    },
    onRight: handleDrillRight,
    onSearch: () => setSearchActive(true),
    onExport: () => {
      // TODO: trigger export for selected item
    },
    onQuit: () => exit(),
  }, !searchActive);

  return (
    <Box flexDirection="column" height={termHeight}>
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color="cyan">ClaudeSync</Text>
          {data.dataState.loading && <Text dimColor>  loading...</Text>}
          {data.dataState.error && <Text color="red">  {data.dataState.error}</Text>}
        </Box>
        {searchFilter && (
          <Text dimColor>filter: {searchFilter}</Text>
        )}
      </Box>

      {searchActive && (
        <SearchOverlay
          visible={searchActive}
          onSubmit={(query) => {
            setSearchFilter(query);
            setSearchActive(false);
          }}
          onCancel={() => {
            setSearchFilter("");
            setSearchActive(false);
          }}
        />
      )}

      <Box flexGrow={1}>
        {columns.map((col, i) => (
          <Column
            key={`${i}-${col.title}`}
            title={col.title}
            items={col.items}
            selectedIndex={nav.getSelection(i)}
            focused={i === nav.focusedColumn && !searchActive}
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
  if (!rawData) return [];

  switch (level.type) {
    case "orgs":
      return (rawData as Organization[]).map((o) => ({
        id: o.uuid, label: o.name, drillable: true, icon: "▸",
      }));
    case "org-contents": {
      const convs: ColumnItem[] = (rawData as ConversationSummary[]).map((c) => ({
        id: c.uuid, label: c.name,
        sublabel: c.model?.replace("claude-", "") ?? "",
        icon: c.is_starred ? "★" : " ",
        drillable: true,
      }));
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

function getNextLevel(current: NavigationLevel, selectedId: string): NavigationLevel | null {
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
