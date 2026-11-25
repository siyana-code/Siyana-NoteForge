import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";

interface Props {
  error: string | null;
  onOpen(path: string, create: boolean): void;
}

export function WelcomeScreen({ error, onOpen }: Props) {
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    api.defaultVaultPath().then(setDefaultPath).catch(() => {});
    api.recentVaults().then(setRecent).catch(() => {});
  }, []);

  const pick = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Choose a folder for your notes" });
    if (typeof dir === "string") onOpen(dir, false);
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <img src="/icon.svg" alt="" width={72} height={72} />
        <h1>NoteForge</h1>
        <p className="muted">
          Your notes are plain Markdown files in a folder you choose. They stay on your computer.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="welcome-actions">
          {defaultPath && (
            <button className="btn primary large" onClick={() => onOpen(defaultPath, true)}>
              Create a vault in {defaultPath.replace(/^\/home\/[^/]+/, "~")}
            </button>
          )}
          <button className="btn large" onClick={pick}>
            Open a folder…
          </button>
        </div>
        {recent.length > 0 && (
          <div className="recent">
            <h4>Recent vaults</h4>
            <ul>
              {recent.map((r) => (
                <li key={r}>
                  <button className="link" onClick={() => onOpen(r, false)}>
                    {r}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
