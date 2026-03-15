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
