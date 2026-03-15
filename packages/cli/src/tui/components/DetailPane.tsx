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
            <Text>Starred:   {conv.is_starred ? "* yes" : "no"}</Text>
            {conv.project_uuid && <Text>Project:   {conv.project_uuid}</Text>}
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
