import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface SearchOverlayProps {
  visible: boolean;
  onSubmit: (query: string) => void;
  onCancel: () => void;
}

export function SearchOverlay({ visible, onSubmit, onCancel }: SearchOverlayProps) {
  const [query, setQuery] = useState("");

  useInput((_input, key) => {
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
