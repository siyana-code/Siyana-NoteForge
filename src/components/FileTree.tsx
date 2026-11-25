import { useState } from "react";
import type { TreeFolder, TreeNode } from "../lib/tree";
import { Icon } from "./Icon";

export interface TreeActions {
  open(path: string): void;
  newNote(dir: string): void;
  newFolder(dir: string): void;
  rename(path: string, isFolder: boolean): void;
  remove(path: string, isFolder: boolean): void;
  move(from: string, toDir: string): void;
}

interface Props {
  root: TreeFolder;
  current: string | null;
  expanded: Set<string>;
  setExpanded(next: Set<string>): void;
  actions: TreeActions;
}

interface Menu {
  x: number;
  y: number;
  node: TreeNode | null;
}

export function FileTree({ root, current, expanded, setExpanded, actions }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };

  const openMenu = (e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const dropProps = (dir: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("text/x-noteforge-path")) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(dir);
    },
    onDragLeave: () => setDropTarget((d) => (d === dir ? null : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const from = e.dataTransfer.getData("text/x-noteforge-path");
      if (from) actions.move(from, dir);
    },
  });

  const render = (node: TreeNode, depth: number): React.ReactNode => {
    const pad = { paddingLeft: 8 + depth * 14 };
    const drag = {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData("text/x-noteforge-path", node.path);
        e.dataTransfer.effectAllowed = "move";
      },
    };
    if (node.kind === "folder") {
      const open = expanded.has(node.path);
      return (
        <li key={node.path}>
          <div
            className={`tree-row folder ${dropTarget === node.path ? "drop" : ""}`}
            style={pad}
            onClick={() => toggle(node.path)}
            onContextMenu={(e) => openMenu(e, node)}
            {...drag}
            {...dropProps(node.path)}
          >
            <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
            <span className="tree-name">{node.name}</span>
          </div>
          {open && <ul>{node.children.map((c) => render(c, depth + 1))}</ul>}
        </li>
      );
    }
    return (
      <li key={node.path}>
        <div
          className={`tree-row note ${node.path === current ? "active" : ""}`}
          style={pad}
          onClick={() => actions.open(node.path)}
          onContextMenu={(e) => openMenu(e, node)}
          title={node.path}
          {...drag}
        >
          <Icon name="file" size={14} />
          <span className="tree-name">{node.name}</span>
        </div>
      </li>
    );
  };

  const close = () => setMenu(null);
  const menuDir = menu?.node
    ? menu.node.kind === "folder"
      ? menu.node.path
      : menu.node.path.split("/").slice(0, -1).join("/")
    : "";

  return (
    <div
      className={`tree ${dropTarget === "" ? "drop" : ""}`}
      onContextMenu={(e) => openMenu(e, null)}
      {...dropProps("")}
    >
      {root.children.length === 0 ? (
        <p className="empty">No notes yet. Press Ctrl+N to create one.</p>
      ) : (
        <ul>{root.children.map((c) => render(c, 0))}</ul>
      )}
      {menu && (
        <>
          <div className="menu-backdrop" onClick={close} onContextMenu={(e) => (e.preventDefault(), close())} />
          <div className="menu" style={{ left: menu.x, top: menu.y }}>
            <button onClick={() => (close(), actions.newNote(menuDir))}>New note</button>
            <button onClick={() => (close(), actions.newFolder(menuDir))}>New folder</button>
            {menu.node && (
              <>
                <hr />
                <button onClick={() => (close(), actions.rename(menu.node!.path, menu.node!.kind === "folder"))}>
                  Rename…
                </button>
                <button
                  className="danger"
                  onClick={() => (close(), actions.remove(menu.node!.path, menu.node!.kind === "folder"))}
                >
                  Move to trash
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
