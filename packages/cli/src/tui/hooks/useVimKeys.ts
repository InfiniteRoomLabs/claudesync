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
