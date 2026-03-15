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
