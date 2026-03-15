import { Fragment } from "react";
import { Box, Text } from "ink";

interface KeyBarProps {
  extraKeys?: Array<{ key: string; action: string }>;
}

export function KeyBar({ extraKeys = [] }: KeyBarProps) {
  const keys = [
    { key: "h", action: "<- back" },
    { key: "j", action: "v down" },
    { key: "k", action: "^ up" },
    { key: "l", action: "-> into" },
    ...extraKeys,
    { key: "/", action: "search" },
    { key: "e", action: "export" },
    { key: "q", action: "quit" },
  ];

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      {keys.map((k, i) => (
        <Fragment key={k.key}>
          <Text bold color="yellow">{k.key}</Text>
          <Text dimColor> {k.action}</Text>
          {i < keys.length - 1 && <Text dimColor>  </Text>}
        </Fragment>
      ))}
    </Box>
  );
}
