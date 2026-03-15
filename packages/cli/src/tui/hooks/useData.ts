import { useState, useRef } from "react";
import type { ClaudeSyncClient } from "@infinite-room-labs/claudesync-core";
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
