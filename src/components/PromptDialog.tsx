import { useEffect, useRef, useState } from "react";

export interface PromptRequest {
  title: string;
  label?: string;
  initial: string;
  confirm: string;
  /** Select this many characters from the start (e.g. the name without ".md"). */
  selectLength?: number;
  resolve(value: string | null): void;
}

export function PromptDialog({ req }: { req: PromptRequest }) {
  const [value, setValue] = useState(req.initial);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = input.current!;
    el.focus();
    el.setSelectionRange(0, req.selectLength ?? req.initial.length);
  }, [req]);

  const submit = () => req.resolve(value.trim() ? value.trim() : null);

  return (
    <div className="modal-backdrop" onMouseDown={() => req.resolve(null)}>
      <form
        className="modal prompt"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => (e.preventDefault(), submit())}
        onKeyDown={(e) => e.key === "Escape" && req.resolve(null)}
      >
        <h3>{req.title}</h3>
        {req.label && <label className="muted">{req.label}</label>}
        <input ref={input} className="input" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => req.resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            {req.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
