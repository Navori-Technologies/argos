/**
 * `argos workspace graph`'s bridge visualization (spec 0007 §Visualización):
 * renders `<out>/bridge-graph.html`, a self-contained (zero external
 * dependencies — no CDN, no vendored vis.js) canvas viewer of the subgraph
 * that participates in cross-repo bridge edges (`_origin === "bridge"`).
 *
 * `renderBridgeVizHtml` is a pure function: same merged graph in, same HTML
 * out. Layout is computed here in TypeScript (not in browser JS) so it's
 * deterministic and directly testable — nodes are grouped by repo into
 * circular clusters, clusters placed around a big circle, everything mapped
 * to final canvas pixel coordinates before being embedded. The browser-side
 * `<script>` is just a dumb renderer + interaction layer (hover tooltip,
 * click-to-inspect panel, legend checkboxes to toggle a repo's visibility)
 * over that precomputed data.
 */

// --- merged graph shape (node-link JSON produced by `graphify merge-graphs`
// and enriched in place by the bundled `graphify-bridge.py`) --------------

/**
 * A node in the merged workspace graph. Node ids are `<repo>::<local_id>`
 * (see `graphify-bridge.py`'s docstring) — `repo`/`label`/`norm_label` are
 * read defensively since the exact set of fields a given graphify node
 * carries isn't contractual outside of `id`.
 */
export interface MergedGraphNode {
  id: string;
  repo?: string;
  label?: string;
  norm_label?: string;
  local_id?: string;
  source_file?: string;
  [key: string]: unknown;
}

/** A link in the merged workspace graph; bridge edges carry `_origin: "bridge"`. */
export interface MergedGraphLink {
  source: string;
  target: string;
  relation?: string;
  _origin?: string;
  context?: string;
  source_file?: string;
  source_location?: string;
  [key: string]: unknown;
}

/** Node-link JSON as written by `graphify merge-graphs` / `graphify-bridge.py`. */
export interface MergedGraph {
  nodes: MergedGraphNode[];
  links: MergedGraphLink[];
  [key: string]: unknown;
}

export interface BridgeVizOptions {
  /** Used in the page title (`<workspaceName> — bridge graph`). */
  workspaceName: string;
}

// --- precomputed viz data (embedded verbatim into the HTML) ---------------

interface VizNode {
  id: string;
  label: string;
  repo: string;
  color: string;
  x: number;
  y: number;
  sourceFile?: string;
}

interface VizEdge {
  source: string;
  target: string;
  relation: string;
  context?: string;
  sourceFile?: string;
  sourceLocation?: string;
}

interface VizLegendItem {
  repo: string;
  color: string;
  count: number;
}

interface VizData {
  title: string;
  canvasWidth: number;
  canvasHeight: number;
  nodes: VizNode[];
  edges: VizEdge[];
  legend: VizLegendItem[];
  empty: boolean;
}

// Fixed 14-color palette, assigned by alphabetical repo order — deterministic
// regardless of discovery order.
const PALETTE = [
  "#e6194b",
  "#3cb44b",
  "#ffe119",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#bcf60c",
  "#fabebe",
  "#008080",
  "#e6beff",
  "#9a6324",
  "#fffac8",
];

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;
const CANVAS_PADDING = 70;

function repoOf(node: MergedGraphNode): string {
  if (typeof node.repo === "string" && node.repo) return node.repo;
  const idx = node.id.indexOf("::");
  return idx > 0 ? node.id.slice(0, idx) : "unknown";
}

function labelOf(node: MergedGraphNode): string {
  if (typeof node.label === "string" && node.label) return node.label;
  if (typeof node.norm_label === "string" && node.norm_label) return node.norm_label;
  if (typeof node.local_id === "string" && node.local_id) return node.local_id;
  const idx = node.id.indexOf("::");
  return idx > 0 ? node.id.slice(idx + 2) : node.id;
}

/** Raw (unscaled) layout position, centered on the origin. */
interface RawPosition {
  x: number;
  y: number;
}

/**
 * Deterministic geometric layout: repos become circular clusters arranged
 * around a big circle; nodes within a repo are arranged around a smaller
 * circle centered on their cluster. No physics/simulation — same input
 * always yields the same coordinates.
 */
function layoutClusters(nodesByRepo: Map<string, MergedGraphNode[]>): Map<string, RawPosition> {
  const positions = new Map<string, RawPosition>();
  const repos = [...nodesByRepo.keys()].sort((a, b) => a.localeCompare(b));
  const repoCount = repos.length;
  const bigRadius = Math.max(220, repoCount * 90);

  repos.forEach((repo, repoIndex) => {
    const clusterAngle = repoCount === 1 ? 0 : (2 * Math.PI * repoIndex) / repoCount;
    const clusterCenter: RawPosition = {
      x: repoCount === 1 ? 0 : bigRadius * Math.cos(clusterAngle),
      y: repoCount === 1 ? 0 : bigRadius * Math.sin(clusterAngle),
    };

    const nodes = [...(nodesByRepo.get(repo) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const clusterRadius = Math.max(24, Math.min(140, nodes.length * 14));

    nodes.forEach((node, nodeIndex) => {
      if (nodes.length === 1) {
        positions.set(node.id, clusterCenter);
        return;
      }
      const nodeAngle = (2 * Math.PI * nodeIndex) / nodes.length;
      positions.set(node.id, {
        x: clusterCenter.x + clusterRadius * Math.cos(nodeAngle),
        y: clusterCenter.y + clusterRadius * Math.sin(nodeAngle),
      });
    });
  });

  return positions;
}

/** Maps raw (centered-on-origin) positions to final canvas pixel coordinates, fit with padding. */
function fitToCanvas(raw: Map<string, RawPosition>): Map<string, RawPosition> {
  if (raw.size === 0) return raw;
  const xs = [...raw.values()].map((p) => p.x);
  const ys = [...raw.values()].map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const scale = Math.min(
    (CANVAS_WIDTH - 2 * CANVAS_PADDING) / spanX,
    (CANVAS_HEIGHT - 2 * CANVAS_PADDING) / spanY,
    3, // never zoom in past 3x — keeps small graphs from spreading edge to edge
  );

  const fitted = new Map<string, RawPosition>();
  for (const [id, pos] of raw) {
    fitted.set(id, {
      x: CANVAS_WIDTH / 2 + (pos.x - centerX) * scale,
      y: CANVAS_HEIGHT / 2 + (pos.y - centerY) * scale,
    });
  }
  return fitted;
}

function buildVizData(mergedGraph: MergedGraph, opts: BridgeVizOptions): VizData {
  const title = `${opts.workspaceName} — bridge graph`;
  const nodesById = new Map(mergedGraph.nodes.map((n) => [n.id, n] as const));

  const bridgeLinks = mergedGraph.links.filter(
    (l) => l._origin === "bridge" && nodesById.has(l.source) && nodesById.has(l.target),
  );

  if (bridgeLinks.length === 0) {
    return { title, canvasWidth: CANVAS_WIDTH, canvasHeight: CANVAS_HEIGHT, nodes: [], edges: [], legend: [], empty: true };
  }

  const participantIds = new Set<string>();
  for (const link of bridgeLinks) {
    participantIds.add(link.source);
    participantIds.add(link.target);
  }

  const participantNodes = [...participantIds]
    .map((id) => nodesById.get(id))
    .filter((n): n is MergedGraphNode => n !== undefined);

  const nodesByRepo = new Map<string, MergedGraphNode[]>();
  for (const node of participantNodes) {
    const repo = repoOf(node);
    const list = nodesByRepo.get(repo) ?? [];
    list.push(node);
    nodesByRepo.set(repo, list);
  }

  const repos = [...nodesByRepo.keys()].sort((a, b) => a.localeCompare(b));
  const colorByRepo = new Map(repos.map((repo, i) => [repo, PALETTE[i % PALETTE.length] as string] as const));

  const positions = fitToCanvas(layoutClusters(nodesByRepo));

  const vizNodes: VizNode[] = participantNodes.map((node) => {
    const repo = repoOf(node);
    const pos = positions.get(node.id) ?? { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
    return {
      id: node.id,
      label: labelOf(node),
      repo,
      color: colorByRepo.get(repo) ?? "#999999",
      x: pos.x,
      y: pos.y,
      sourceFile: node.source_file,
    };
  });

  const vizEdges: VizEdge[] = bridgeLinks.map((link) => ({
    source: link.source,
    target: link.target,
    relation: link.relation ?? "bridge",
    context: link.context,
    sourceFile: link.source_file,
    sourceLocation: link.source_location,
  }));

  const legend: VizLegendItem[] = repos.map((repo) => ({
    repo,
    color: colorByRepo.get(repo) ?? "#999999",
    count: nodesByRepo.get(repo)?.length ?? 0,
  }));

  return { title, canvasWidth: CANVAS_WIDTH, canvasHeight: CANVAS_HEIGHT, nodes: vizNodes, edges: vizEdges, legend, empty: false };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Anti-XSS embedding of arbitrary JSON data inside a `<script>` tag: escaping
 * every `<` (not just `</script>`) is the standard defense — it also
 * neutralizes `<!--` and any other tag-opening sequence a malicious label
 * could carry.
 */
function embedJson(data: VizData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Renders the fully self-contained bridge graph HTML for `mergedGraph`
 * (node-link JSON from `graphify merge-graphs` + `graphify-bridge.py`).
 * Pure function — `runWorkspaceGraph` is the only caller that writes the
 * result to disk.
 */
export function renderBridgeVizHtml(mergedGraph: MergedGraph, opts: BridgeVizOptions): string {
  const data = buildVizData(mergedGraph, opts);
  const dataJson = embedJson(data);
  const titleHtml = escapeHtml(data.title);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${titleHtml}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    display: flex;
    height: 100vh;
    overflow: hidden;
  }
  #app { display: flex; width: 100%; height: 100%; }
  #canvas-wrap { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; }
  canvas { display: block; background: #0d1117; cursor: default; max-width: 100%; max-height: 100%; height: auto; }
  #empty-msg {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    color: #8b949e; font-size: 16px; text-align: center;
  }
  #legend {
    width: 260px;
    padding: 16px;
    border-left: 1px solid #30363d;
    overflow-y: auto;
    flex-shrink: 0;
  }
  #legend h1 { font-size: 14px; margin: 0 0 12px; color: #f0f6fc; }
  .legend-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; }
  .legend-swatch { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .legend-count { margin-left: auto; color: #8b949e; }
  #tooltip {
    position: absolute; pointer-events: none; background: #161b22; border: 1px solid #30363d;
    border-radius: 6px; padding: 8px 10px; font-size: 12px; max-width: 320px; display: none; z-index: 10;
  }
  #tooltip strong { color: #f0f6fc; }
  #panel {
    position: absolute; right: 12px; bottom: 12px; width: 320px; max-height: 40%;
    background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px;
    font-size: 12px; overflow-y: auto; display: none;
  }
  #panel h2 { font-size: 13px; margin: 0 0 8px; color: #f0f6fc; }
  #panel .edge { padding: 6px 0; border-top: 1px solid #21262d; }
  #panel .edge:first-of-type { border-top: none; }
</style>
</head>
<body>
<div id="app">
  <div id="canvas-wrap">
    <canvas id="c"></canvas>
    <div id="empty-msg"></div>
    <div id="tooltip"></div>
    <div id="panel"></div>
  </div>
  <div id="legend">
    <h1>Repos</h1>
    <div id="legend-list"></div>
  </div>
</div>
<script>
const DATA = ${dataJson};
(function () {
  document.title = DATA.title;
  const canvas = document.getElementById("c");
  const emptyMsg = document.getElementById("empty-msg");
  const tooltip = document.getElementById("tooltip");
  const panel = document.getElementById("panel");
  const legendList = document.getElementById("legend-list");

  if (DATA.empty) {
    canvas.style.display = "none";
    emptyMsg.textContent = "sin contratos cross-repo detectados";
    emptyMsg.style.display = "block";
    return;
  }

  canvas.width = DATA.canvasWidth;
  canvas.height = DATA.canvasHeight;
  const ctx = canvas.getContext("2d");

  const nodesById = new Map(DATA.nodes.map(function (n) { return [n.id, n]; }));
  const visibleRepos = new Set(DATA.legend.map(function (l) { return l.repo; }));

  // Defense in depth: DATA fields (labels, repo names, contexts) come from
  // scanned source code and aren't guaranteed HTML-safe — escape before any
  // innerHTML interpolation, even though the embedding itself (see
  // embedJson) already prevents breaking out of the <script> tag.
  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function edgeColor(relation) {
    return relation === "http_call" ? "rgba(88,166,255,0.75)" : "rgba(210,153,34,0.75)";
  }

  function visibleNodes() {
    return DATA.nodes.filter(function (n) { return visibleRepos.has(n.repo); });
  }
  function visibleEdges() {
    return DATA.edges.filter(function (e) {
      const s = nodesById.get(e.source);
      const t = nodesById.get(e.target);
      return s && t && visibleRepos.has(s.repo) && visibleRepos.has(t.repo);
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const edges = visibleEdges();
    for (const e of edges) {
      const s = nodesById.get(e.source);
      const t = nodesById.get(e.target);
      if (!s || !t) continue;
      ctx.beginPath();
      ctx.strokeStyle = edgeColor(e.relation);
      ctx.lineWidth = 1.5;
      ctx.setLineDash(e.relation === "shared_constant" ? [4, 4] : []);
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of visibleNodes()) {
      ctx.beginPath();
      ctx.fillStyle = n.color;
      ctx.arc(n.x, n.y, 6, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  function nodeAt(px, py) {
    let closest = null;
    let bestDist = 10; // hit radius in px
    for (const n of visibleNodes()) {
      const d = Math.hypot(n.x - px, n.y - py);
      if (d < bestDist) { bestDist = d; closest = n; }
    }
    return closest;
  }

  canvas.addEventListener("mousemove", function (ev) {
    const rect = canvas.getBoundingClientRect();
    // The canvas can be CSS-scaled down to fit the viewport (max-width/height),
    // so map client coords back into the fixed drawing space before hit-testing.
    const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
    const n = nodeAt(px, py);
    if (!n) { tooltip.style.display = "none"; return; }
    tooltip.innerHTML = "<strong>" + esc(n.label) + "</strong><br>repo: " + esc(n.repo) +
      (n.sourceFile ? "<br>" + esc(n.sourceFile) : "");
    tooltip.style.left = (px + 14) + "px";
    tooltip.style.top = (py + 14) + "px";
    tooltip.style.display = "block";
  });

  canvas.addEventListener("click", function (ev) {
    const rect = canvas.getBoundingClientRect();
    // The canvas can be CSS-scaled down to fit the viewport (max-width/height),
    // so map client coords back into the fixed drawing space before hit-testing.
    const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
    const n = nodeAt(px, py);
    if (!n) { panel.style.display = "none"; return; }
    const related = DATA.edges.filter(function (e) { return e.source === n.id || e.target === n.id; });
    let html = "<h2>" + esc(n.label) + " (" + esc(n.repo) + ")</h2>";
    if (related.length === 0) {
      html += "<div>sin edges puente</div>";
    } else {
      for (const e of related) {
        const other = e.source === n.id ? nodesById.get(e.target) : nodesById.get(e.source);
        const dir = e.source === n.id ? "&#8594;" : "&#8592;";
        html += "<div class=\\"edge\\">" + dir + " " + esc(other ? other.label : "?") +
          "<br>" + esc(e.relation) + (e.context ? ": " + esc(e.context) : "") + "</div>";
      }
    }
    panel.innerHTML = html;
    panel.style.display = "block";
  });

  for (const item of DATA.legend) {
    const row = document.createElement("label");
    row.className = "legend-item";
    row.innerHTML = "<input type=\\"checkbox\\" checked> " +
      "<span class=\\"legend-swatch\\" style=\\"background:" + esc(item.color) + "\\"></span> " +
      esc(item.repo) + "<span class=\\"legend-count\\">" + item.count + "</span>";
    const checkbox = row.querySelector("input");
    checkbox.addEventListener("change", function () {
      if (checkbox.checked) visibleRepos.add(item.repo);
      else visibleRepos.delete(item.repo);
      draw();
    });
    legendList.appendChild(row);
  }

  draw();
})();
</script>
</body>
</html>
`;
}
