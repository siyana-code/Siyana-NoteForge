import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface NoteMeta {
  path: string;
  title: string;
  mtime: number;
  tags: string[];
}

export interface VaultInfo {
  path: string;
  name: string;
  notes: NoteMeta[];
  folders: string[];
}

export interface SearchHit {
  path: string;
  title: string;
  /** Matches are wrapped in \u0001 ... \u0002. */
  snippet: string;
}

export interface Backlink {
  path: string;
  title: string;
  context: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface GraphData {
  nodes: { id: string; title: string; degree: number }[];
  edges: { source: string; target: string }[];
}

export interface SyncReport {
  changed: string[];
  removed: string[];
}

export const api = {
  lastVault: () => invoke<string | null>("get_last_vault"),
  recentVaults: () => invoke<string[]>("get_recent_vaults"),
  defaultVaultPath: () => invoke<string | null>("default_vault_path"),
  openVault: (path: string, create = false) => invoke<VaultInfo>("open_vault", { path, create }),
  closeVault: () => invoke<void>("close_vault"),
  snapshot: () => invoke<VaultInfo>("vault_snapshot"),
  rescan: () => invoke<SyncReport>("rescan"),
  read: (path: string) => invoke<string>("read_note", { path }),
  write: (path: string, content: string) => invoke<void>("write_note", { path, content }),
  createNote: (dir: string, name?: string, content?: string) =>
    invoke<string>("create_note", { dir, name: name ?? null, content: content ?? null }),
  createFolder: (path: string) => invoke<void>("create_folder", { path }),
  rename: (from: string, to: string, updateLinks = true) =>
    invoke<string[]>("rename_path", { from, to, updateLinks }),
  trash: (path: string) => invoke<void>("trash_path", { path }),
  search: (query: string, limit = 50) => invoke<SearchHit[]>("search", { query, limit }),
  backlinks: (path: string) => invoke<Backlink[]>("backlinks", { path }),
  tags: () => invoke<TagCount[]>("tags"),
  graph: () => invoke<GraphData>("graph"),
  onVaultChanged: (cb: (r: SyncReport) => void): Promise<UnlistenFn> =>
    listen<SyncReport>("vault-changed", (e) => cb(e.payload)),
};

export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
