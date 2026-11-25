import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphData } from "../api";

interface Node extends SimulationNodeDatum {
  id: string;
  title: string;
  degree: number;
}
type Link = SimulationLinkDatum<Node>;

interface Props {
  data: GraphData;
  current: string | null;
  onOpen(path: string): void;
  onClose(): void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Restrict the graph to notes within `depth` links of `center`. */
function localSubgraph(data: GraphData, center: string, depth: number): GraphData {
  const adj = new Map<string, Set<string>>();
  for (const e of data.edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  const keep = new Set([center]);
  let frontier = [center];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const n of frontier) for (const m of adj.get(n) ?? []) if (!keep.has(m)) (keep.add(m), next.push(m));
    frontier = next;
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    edges: data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

export function GraphView({ data, current, onOpen, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [local, setLocal] = useState(false);
  const [depth, setDepth] = useState(1);
  const [showOrphans, setShowOrphans] = useState(true);
  const [filter, setFilter] = useState("");

  const view = useMemo(() => {
    let g = local && current ? localSubgraph(data, current, depth) : data;
    if (!showOrphans) g = { ...g, nodes: g.nodes.filter((n) => n.degree > 0 || n.id === current) };
    return g;
  }, [data, local, current, depth, showOrphans]);

  // Keep the filter out of the simulation deps; it only affects drawing.
  const filterRef = useRef(filter);
  filterRef.current = filter.toLowerCase();
  // Likewise the open note and callback: re-laying out on every click would be jarring.
  const currentRef = useRef(current);
  currentRef.current = current;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const fitRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const nodes: Node[] = view.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: Link[] = view.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));
    const neighbors = new Map<string, Set<string>>();
    for (const l of view.edges) {
      if (!neighbors.has(l.source)) neighbors.set(l.source, new Set());
      if (!neighbors.has(l.target)) neighbors.set(l.target, new Set());
      neighbors.get(l.source)!.add(l.target);
      neighbors.get(l.target)!.add(l.source);
    }

    let width = 0;
    let height = 0;
    const transform = { x: 0, y: 0, k: 1 };
    let hover: Node | null = null;
    let dragging: Node | null = null;
    let panning: { x: number; y: number } | null = null;
    let moved = false;

    const colors = {
      node: cssVar("--graph-node"),
      current: cssVar("--accent"),
      edge: cssVar("--graph-edge"),
      text: cssVar("--text"),
      dim: cssVar("--text-faint"),
      bg: cssVar("--bg"),
    };

    const radius = (n: Node) => 4 + Math.sqrt(n.degree) * 2.2;

    const sim = forceSimulation(nodes)
      .force("link", forceLink<Node, Link>(links).id((n) => n.id).distance(110).strength(0.5))
      .force("charge", forceManyBody().strength(-420).distanceMax(600))
      .force("center", forceCenter(0, 0))
      .force("x", forceX(0).strength(0.04))
      .force("y", forceY(0).strength(0.04))
      .force("collide", forceCollide<Node>().radius((n) => radius(n) + 4));

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    const toWorld = (sx: number, sy: number) => ({
      x: (sx - width / 2 - transform.x) / transform.k,
      y: (sy - height / 2 - transform.y) / transform.k,
    });

    const nodeAt = (sx: number, sy: number): Node | null => {
      const p = toWorld(sx, sy);
      let best: Node | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y);
        if (d < radius(n) + 6 / transform.k && d < bestD) (best = n), (bestD = d);
      }
      return best;
    };

    function draw() {
      const current = currentRef.current;
      ctx.save();
      ctx.clearRect(0, 0, width, height);
      ctx.translate(width / 2 + transform.x, height / 2 + transform.y);
      ctx.scale(transform.k, transform.k);

      const focus = hover?.id ?? null;
      const near = focus ? neighbors.get(focus) ?? new Set<string>() : null;
      const q = filterRef.current;
      const matches = (n: Node) => !q || n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q);

      ctx.lineWidth = 1 / transform.k;
      for (const l of links) {
        const s = l.source as Node;
        const t = l.target as Node;
        const lit = focus && (s.id === focus || t.id === focus);
        ctx.strokeStyle = lit ? colors.current : colors.edge;
        ctx.globalAlpha = focus && !lit ? 0.25 : lit ? 0.9 : 0.6;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
        ctx.stroke();
      }

      for (const n of nodes) {
        const dim = (focus && n.id !== focus && !near!.has(n.id)) || !matches(n);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = n.id === current || n.id === focus ? colors.current : colors.node;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2);
        ctx.fill();
      }

      const fontSize = 12 / Math.max(transform.k, 0.6);
      ctx.font = `${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodes) {
        const important = n.id === current || n.id === focus || (near?.has(n.id) ?? false) || (q && matches(n));
        if (!important && transform.k < 1.1 && nodes.length > 30) continue;
        const dim = (focus && !important) || !matches(n);
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = important ? colors.text : colors.dim;
        ctx.fillText(n.title, n.x!, n.y! + radius(n) + 3);
      }
      ctx.restore();
    }

    /** Zoom and centre so the whole graph fits, leaving room for labels. */
    const fit = () => {
      if (!nodes.length || !width) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) {
        x0 = Math.min(x0, n.x!);
        y0 = Math.min(y0, n.y!);
        x1 = Math.max(x1, n.x!);
        y1 = Math.max(y1, n.y!);
      }
      const pad = 80;
      const k = Math.min(1.6, Math.max(0.15, Math.min((width - pad * 2) / (x1 - x0 || 1), (height - pad * 2) / (y1 - y0 || 1))));
      transform.k = k;
      transform.x = -((x0 + x1) / 2) * k;
      transform.y = -((y0 + y1) / 2) * k;
      draw();
    };
    fitRef.current = fit;

    // Keep the graph framed while it settles, until the user takes over.
    let autoFit = true;
    sim.on("tick", () => (autoFit ? fit() : draw()));

    const pos = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: PointerEvent) => {
      const p = pos(e);
      moved = false;
      canvas.setPointerCapture(e.pointerId);
      const n = nodeAt(p.x, p.y);
      if (n) {
        dragging = n;
        n.fx = n.x;
        n.fy = n.y;
        sim.alphaTarget(0.3).restart();
      } else {
        autoFit = false;
        panning = { x: p.x - transform.x, y: p.y - transform.y };
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = pos(e);
      if (dragging) {
        moved = true;
        const w = toWorld(p.x, p.y);
        dragging.fx = w.x;
        dragging.fy = w.y;
      } else if (panning) {
        moved = true;
        transform.x = p.x - panning.x;
        transform.y = p.y - panning.y;
        draw();
      } else {
        const n = nodeAt(p.x, p.y);
        if (n !== hover) {
          hover = n;
          canvas.style.cursor = n ? "pointer" : "grab";
          draw();
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      canvas.releasePointerCapture(e.pointerId);
      if (dragging) {
        if (!moved) onOpenRef.current(dragging.id);
        dragging.fx = null;
        dragging.fy = null;
        sim.alphaTarget(0);
      }
      dragging = null;
      panning = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      autoFit = false;
      const p = pos(e);
      const before = toWorld(p.x, p.y);
      transform.k = Math.min(6, Math.max(0.15, transform.k * Math.exp(-e.deltaY * 0.0015)));
      transform.x = p.x - width / 2 - before.x * transform.k;
      transform.y = p.y - height / 2 - before.y * transform.k;
      draw();
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    const redraw = setInterval(() => sim.alpha() < 0.01 && draw(), 250); // keep filter changes visible

    return () => {
      sim.stop();
      ro.disconnect();
      clearInterval(redraw);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [view]);

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <strong>Graph</strong>
        <input
          className="input small"
          placeholder="Highlight notes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={local} disabled={!current} onChange={(e) => setLocal(e.target.checked)} />
          Local
        </label>
        {local && (
          <label className="check">
            Depth
            <input type="range" min={1} max={4} value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
            {depth}
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} />
          Orphans
        </label>
        <span className="muted">
          {view.nodes.length} notes · {view.edges.length} links
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => fitRef.current()} title="Fit graph to window">
          Fit
        </button>
        <button className="btn ghost" onClick={onClose} title="Close graph (Esc)">
          ✕
        </button>
      </div>
      <canvas ref={canvasRef} className="graph-canvas" />
    </div>
  );
}
