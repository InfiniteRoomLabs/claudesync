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
