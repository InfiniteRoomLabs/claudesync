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
  icon?: string; // "★" for starred, "▸" for drillable
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
