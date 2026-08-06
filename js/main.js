/* main.js — Mind Map интерактивті логикасы
   - Деректер: MINDMAP (mindmap-data.js)
   - Drag & Pan, Zoom
   - Click to expand/collapse
   - Search
   - Export (PNG / PDF / SVG / JSON / Print)
   - Minimap
   - Detail panel
*/
import { MINDMAP } from "./mindmap-data.js";

/* ---------- DOM refs ---------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const canvasWrap  = $("#canvas-wrap");
const canvas      = $("#canvas");
const nodesLayer  = $("#nodes-layer");
const connectorsG = $("#connectors-group");
const detailPanel = $("#detail-panel");
const minimap     = $("#minimap");
const minimapVp   = $("#minimap-viewport");
const searchOv    = $("#search-overlay");
const searchIn    = $("#search-input");
const searchRes   = $("#search-results");
const toastEl     = $("#toast");
const welcome     = $("#welcome");

/* ---------- State ---------- */
/* Minimum/maximum allowed scale. We allow down to 0.05 so that
   the entire 100+ node tree can be made to fit on a single screen. */
const SCALE_MIN = 0.05;
const SCALE_MAX = 2.5;

const state = {
  scale: 1,
  tx: 0,
  ty: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  // We deliberately do NOT include "1" here so that the root's
  // children stay hidden. The root itself is always shown because
  // `isVisible` returns true when there is no parent.
  expanded: new Set(),
  selected: null,         // currently selected node id
  activePath: new Set(), // highlighted path
  panning: false,         // middle/right-button drag for panning
  panStart: { x: 0, y: 0, tx: 0, ty: 0 },
};

/* Positions are computed recursively; this map holds x/y for each node id. */
const positions = new Map();
const NODE_W = 220;   // estimated node width
const NODE_H = 80;    // estimated node height
const H_GAP = 60;     // horizontal gap
const V_GAP = 40;     // vertical gap

/* ---------- Initial tree computation ---------- */
function buildSubtree(id, depth = 0) {
  const node = MINDMAP[id];
  if (!node) return { id, height: 0 };
  const children = (node.children || []).map((cid) => buildSubtree(cid, depth + 1));
  return { id, depth, height: children.length, children };
}

/* Assigns x/y for each node id using a horizontal mind-map layout.

   For the root, L1 children are laid out across two columns:
   one to the right of the root, one to the left. For deeper
   levels, the L1 ancestor's horizontal direction determines
   where its descendants go (right of root → children to the
   right; left of root → children to the left).

   Within a column, sibling subtrees are placed one above the
   other, centred on the y-extent of the subtree. */
function layoutTree() {
  positions.clear();
  const root = MINDMAP.root;
  const H_GAP = 320;   // horizontal distance from a parent to its column
  const V_GAP = 24;    // vertical gap between siblings in a column
  const SUBTREE_BASE = 28; // min vertical unit per subtree
  if (!root) return;

  // Split L1 children between right and left columns.
  const l1 = root.children || [];
  const half = Math.ceil(l1.length / 2);
  const rightL1 = l1.slice(0, half);
  const leftL1  = l1.slice(half);

  // Subtree height (in V units) for a node — used for vertical spacing.
  const subHeight = (id) => {
    const n = MINDMAP[id];
    if (!n || !n.children || n.children.length === 0) return SUBTREE_BASE;
    let total = 0;
    for (const c of n.children) total += subHeight(c);
    return Math.max(SUBTREE_BASE, total + V_GAP * (n.children.length - 1));
  };

  // Place a list of L1 children in a column to the right (sign = +1)
  // or left (sign = -1) of the root. Returns the total height used.
  const placeColumn = (ids, sign) => {
    const subtreeHeights = ids.map(subHeight);
    const total = subtreeHeights.reduce((a, b) => a + b, 0) + V_GAP * Math.max(0, ids.length - 1);
    let yCursor = -total / 2;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const sh = subtreeHeights[i];
      const yCentre = yCursor + sh / 2;
      positions.set(id, { x: sign * H_GAP, y: yCentre });
      // Recurse into this L1's children
      placeSubtree(id, sign * 2 * H_GAP, yCentre - sh / 2, sh, sign);
      yCursor += sh + V_GAP;
    }
  };

  // Recursive subtree placement: pack all children of `id` in a column
  // starting at (x0, y0) with the given column height.
  const placeSubtree = (id, x0, y0, columnHeight, sign) => {
    const n = MINDMAP[id];
    if (!n || !n.children || !n.children.length) return;
    const children = n.children;
    const subHs = children.map(subHeight);
    const total = subHs.reduce((a, b) => a + b, 0) + V_GAP * Math.max(0, children.length - 1);
    // If children are too tall, scale them down within columnHeight.
    const yScale = total > columnHeight ? columnHeight / total : 1;
    let yCursor = y0 + (columnHeight - total * yScale) / 2;
    for (let i = 0; i < children.length; i++) {
      const cid = children[i];
      const sh = subHs[i] * yScale;
      const yCentre = yCursor + sh / 2;
      positions.set(cid, { x: x0, y: yCentre });
      // Recurse further
      placeSubtree(cid, x0 + sign * H_GAP, yCursor, sh, sign);
      yCursor += sh + V_GAP * yScale;
    }
  };

  // Place root at origin
  positions.set("1", { x: 0, y: 0 });
  placeColumn(rightL1, +1);
  placeColumn(leftL1, -1);
}

/* ---------- Build DOM ---------- */
function buildNodes() {
  nodesLayer.innerHTML = "";
  const ids = Object.keys(MINDMAP);
  for (const id of ids) {
    if (id === "meta") continue;
    const data = MINDMAP[id];
    const pos = positions.get(id);
    if (!pos) continue;
    const div = document.createElement("button");
    div.className = `node l${dataDepth(id)}`;
    if (id === "1") div.classList.add("root");
    if (data.children?.length) div.classList.add("has-children");
    div.style.left = pos.x + "px";
    div.style.top  = pos.y + "px";
    div.dataset.id = id;
    div.setAttribute("type", "button");
    div.setAttribute("aria-label", data.title);
    div.innerHTML = `
      <span class="node-icon">${data.icon || "•"}</span>
      <span class="node-title">${escapeHTML(data.short || data.title)}</span>
      <span class="node-meta">${id === "1" ? "Орталық түйін" : (data.children?.length ? `${data.children.length} тармақ` : "Толығырақ")}</span>
    `;
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      onNodeClick(id);
    });
    nodesLayer.appendChild(div);
  }
  // Initially mark which children should be visible
  applyVisibility();
}

function dataDepth(id) {
  // id like "1", "1.1", "1.1.1", "1.1.1.1", "1.1.1.1.1" (5 max if user over-clicks)
  if (id === "1") return 0;
  return (id.match(/\./g) || []).length;
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------- Visibility & expand/collapse ---------- */
function applyVisibility() {
  // Walk the tree; for each node, show only if all ancestors are expanded.
  const isVisible = (id) => {
    const parent = parentId(id);
    if (!parent) return true;
    if (!state.expanded.has(parent)) return false;
    return isVisible(parent);
  };
  $$(".node").forEach((el) => {
    const id = el.dataset.id;
    el.style.display = isVisible(id) ? "block" : "none";
    el.classList.toggle("expanded", state.expanded.has(id) && MINDMAP[id]?.children?.length > 0);
  });
  drawConnectors();
  updateMinimap();
}

function parentId(id) {
  const i = id.lastIndexOf(".");
  if (i <= 0) return id === "1" ? null : "1";
  return id.slice(0, i);
}

function expandNode(id) {
  if (MINDMAP[id]?.children?.length) {
    state.expanded.add(id);
    applyVisibility();
  }
}
function collapseNode(id) {
  state.expanded.delete(id);
  // also collapse any descendants
  for (const k of Array.from(state.expanded)) {
    if (k.startsWith(id + ".")) state.expanded.delete(k);
  }
  applyVisibility();
}
function expandAll() {
  for (const k of Object.keys(MINDMAP)) {
    if (k !== "meta" && MINDMAP[k]?.children?.length) state.expanded.add(k);
  }
  applyVisibility();
  // Fit the entire tree into the viewport so the user truly sees
  // everything on one screen. The scale is allowed to go down to
  // SCALE_MIN (0.05) so even 100+ nodes fit. They can then click
  // any node to zoom in on it.
  fitToScreen();
  updateMinimap();
  toast("Барлығы бір экранға сыйды — тармақты басып, үлкейтіңіз", "success");
}
function collapseAll() {
  // Clear all expansions. The root itself is always visible (it
  // has no parent that can hide it), so we don't need to add "1"
  // to `state.expanded` — that would re-show its children.
  state.expanded.clear();
  applyVisibility();
  centreRoot();
  updateMinimap();
  toast("Барлық тармақтар жабылды", "success");
}

/* Fit any set of points into the viewport. */
function fitToView(pts) {
  pts = [...pts];
  if (!pts.length) return;
  const NODE_W = 200, NODE_H = 60, padding = 40;
  const minX = Math.min(...pts.map((p) => p.x)) - NODE_W / 2 - padding;
  const maxX = Math.max(...pts.map((p) => p.x)) + NODE_W / 2 + padding;
  const minY = Math.min(...pts.map((p) => p.y)) - NODE_H / 2 - padding;
  const maxY = Math.max(...pts.map((p) => p.y)) + NODE_H / 2 + padding;
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  if (w <= 0 || h <= 0) return;
  const scale = clamp(Math.min(w / (maxX - minX), h / (maxY - minY)), SCALE_MIN, SCALE_MAX);
  state.scale = scale;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  state.tx = w / 2 - cx * scale;
  state.ty = h / 2 - cy * scale;
  applyTransform();
}

function onNodeClick(id) {
  const data = MINDMAP[id];
  if (!data) return;
  // If the node has children, toggle expansion
  if (data.children?.length) {
    if (state.expanded.has(id)) collapseNode(id);
    else expandNode(id);
  }
  // Show the detail panel only for non-root nodes. The root
  // already has its description on the welcome card, and
  // auto-opening the panel on the very first click gets in
  // the way of the user just exploring the tree.
  if (id !== "1") {
    showDetail(id);
  } else {
    // If the detail panel is already open for the root, close
    // it; otherwise leave it alone.
    if (state.selected === "1") closeDetail();
  }
  // Choose a target scale that lets the user see the clicked
  // node, its parent, and its first row of children. The
  // deeper the user goes, the smaller the scale becomes.
  let target;
  if (state.scale < 0.4) {
    // We were zoomed-out (e.g. just after "Fit all"). Zoom
    // in to a comfortable reading level.
    target = 0.9;
  } else {
    const depth = dataDepth(id);
    // 0 = root, 1 = L1, 2 = L2, 3 = L3
    if (depth === 0) target = 0.9;       // root → L1 visible
    else if (depth === 1) target = 0.75;  // L1 → L2 visible
    else if (depth === 2) target = 0.6;   // L2 → L3 visible
    else target = 0.5;                    // L3 → L4 visible
  }
  focusOnNode(id, target);
}

/* ---------- Detail panel ---------- */
function showDetail(id) {
  const data = MINDMAP[id];
  if (!data) return;
  state.selected = id;
  state.activePath = computePath(id);
  $("#detail-icon").textContent = data.icon || "•";
  $("#detail-title").textContent = data.title;
  $("#detail-id").textContent = `§ ${id} · ${dataDepth(id) === 0 ? "Түбір" : dataDepth(id) + "-деңгей"}`;
  $("#detail-desc").textContent = data.description || "";
  const children = $("#detail-children");
  children.innerHTML = "";
  if (data.children?.length) {
    const h = document.createElement("h4");
    h.textContent = "Тармақтары";
    children.appendChild(h);
    for (const cid of data.children) {
      const c = MINDMAP[cid];
      if (!c) continue;
      const btn = document.createElement("button");
      btn.textContent = `${c.icon || "•"}  ${c.short || c.title}`;
      btn.addEventListener("click", () => {
        expandNode(id);
        showDetail(cid);
        focusOnNode(cid);
      });
      children.appendChild(btn);
    }
  }
  detailPanel.hidden = false;
  drawConnectors();
  highlightActive();
}

function closeDetail() {
  detailPanel.hidden = true;
  state.selected = null;
  state.activePath = new Set();
  highlightActive();
  drawConnectors();
}

function computePath(id) {
  const path = new Set();
  let cur = id;
  while (cur) {
    path.add(cur);
    if (cur === "1") break;
    cur = parentId(cur);
  }
  return path;
}

function highlightActive() {
  $$(".node").forEach((el) => {
    el.classList.toggle("active", state.activePath.has(el.dataset.id));
  });
}

function focusOnNode(id, targetScale) {
  const pos = positions.get(id);
  if (!pos) return;
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  // If a target scale is provided, jump to it. Otherwise keep the
  // current scale.
  if (typeof targetScale === "number") {
    state.scale = clamp(targetScale, SCALE_MIN, SCALE_MAX);
  }
  // Centre the node in the viewport
  state.tx = w / 2 - pos.x * state.scale;
  state.ty = h / 2 - pos.y * state.scale;
  applyTransform();
  updateMinimap();
}

/* ---------- Connectors (SVG lines between nodes) ---------- */
function drawConnectors() {
  if (!connectorsG) return;
  connectorsG.innerHTML = "";
  for (const id of Object.keys(MINDMAP)) {
    if (id === "meta") continue;
    const node = MINDMAP[id];
    if (!node?.children?.length) continue;
    const p1 = positions.get(id);
    if (!p1) continue;
    for (const cid of node.children) {
      const p2 = positions.get(cid);
      if (!p2) continue;
      // Skip drawing if either end is hidden
      if (!isNodeVisible(id) || !isNodeVisible(cid)) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      // Smooth bezier curve
      const mx = (p1.x + p2.x) / 2;
      const d = `M ${p1.x + NODE_W/2} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x - NODE_W/2} ${p2.y}`;
      line.setAttribute("d", d);
      line.dataset.from = id;
      line.dataset.to = cid;
      if (state.activePath.has(id) && state.activePath.has(cid)) {
        line.classList.add("active");
      }
      connectorsG.appendChild(line);
    }
  }
}

function isNodeVisible(id) {
  let p = parentId(id);
  while (p) {
    if (!state.expanded.has(p) && p !== id) return false;
    if (p === "1") return true;
    p = parentId(p);
  }
  return true;
}

/* ---------- Pan / Zoom / Drag ---------- */
function applyTransform() {
  canvas.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
}

canvasWrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvasWrap.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const delta = -e.deltaY * 0.0015;
  const newScale = clamp(state.scale * (1 + delta), SCALE_MIN, SCALE_MAX);
  // Keep the mouse position fixed
  const wx = (mx - state.tx) / state.scale;
  const wy = (my - state.ty) / state.scale;
  state.scale = newScale;
  state.tx = mx - wx * state.scale;
  state.ty = my - wy * state.scale;
  applyTransform();
  updateMinimap();
}, { passive: false });

canvasWrap.addEventListener("mousedown", (e) => {
  if (e.target !== canvasWrap && !e.target.classList.contains("canvas") && e.target.tagName !== "svg" && !e.target.classList.contains("connectors")) return;
  state.panning = true;
  state.panStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
  canvasWrap.classList.add("dragging");
});
window.addEventListener("mousemove", (e) => {
  if (!state.panning) return;
  state.tx = state.panStart.tx + (e.clientX - state.panStart.x);
  state.ty = state.panStart.ty + (e.clientY - state.panStart.y);
  applyTransform();
  updateMinimap();
});
window.addEventListener("mouseup", () => {
  if (state.panning) {
    state.panning = false;
    canvasWrap.classList.remove("dragging");
  }
});

// Touch support
canvasWrap.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    state.panning = true;
    state.panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx: state.tx, ty: state.ty };
  } else if (e.touches.length === 2) {
    // pinch zoom — store initial distance
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    state.pinching = { dist: Math.hypot(dx, dy), scale: state.scale };
  }
}, { passive: true });
canvasWrap.addEventListener("touchmove", (e) => {
  if (state.pinching && e.touches.length === 2) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const d = Math.hypot(dx, dy);
    const newScale = clamp(state.pinching.scale * (d / state.pinching.dist), SCALE_MIN, SCALE_MAX);
    state.scale = newScale;
    applyTransform();
    updateMinimap();
  } else if (state.panning && e.touches.length === 1) {
    state.tx = state.panStart.tx + (e.touches[0].clientX - state.panStart.x);
    state.ty = state.panStart.ty + (e.touches[0].clientY - state.panStart.y);
    applyTransform();
    updateMinimap();
  }
}, { passive: false });
canvasWrap.addEventListener("touchend", () => {
  state.panning = false;
  state.pinching = null;
});

// Click on empty canvas — close detail
canvasWrap.addEventListener("click", (e) => {
  if (e.target === canvasWrap || e.target.classList.contains("canvas") || e.target.classList.contains("connectors")) {
    closeDetail();
  }
});

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* ---------- Minimap ---------- */
function updateMinimap() {
  if (!minimap) return;
  const allX = [...positions.values()].map((p) => p.x);
  const allY = [...positions.values()].map((p) => p.y);
  if (!allX.length) return;
  const minX = Math.min(...allX) - 200;
  const maxX = Math.max(...allX) + 200;
  const minY = Math.min(...allY) - 100;
  const maxY = Math.max(...allY) + 100;
  const W = maxX - minX;
  const H = maxY - minY;
  const mw = minimap.clientWidth;
  const mh = minimap.clientHeight - 28;
  const scale = Math.min(mw / W, mh / H);
  const offX = (mw - W * scale) / 2;
  const offY = 14 + (mh - H * scale) / 2;
  // Render a simple set of dots (one per node)
  minimap.querySelectorAll(".mm-dot").forEach((d) => d.remove());
  for (const [id, p] of positions) {
    if (!isNodeVisible(id)) continue;
    const d = document.createElement("div");
    d.className = "mm-dot";
    d.style.cssText = `position:absolute;left:${offX + (p.x - minX) * scale}px;top:${offY + (p.y - minY) * scale}px;width:6px;height:6px;border-radius:50%;background:${state.activePath.has(id) ? "#FFDA27" : "#4f8cff"};transform:translate(-50%,-50%);pointer-events:none;`;
    minimap.appendChild(d);
  }
  // Viewport rectangle
  const vw = canvasWrap.clientWidth / state.scale;
  const vh = canvasWrap.clientHeight / state.scale;
  const vx = -state.tx / state.scale;
  const vy = -state.ty / state.scale;
  minimapVp.style.left = (offX + (vx - minX) * scale) + "px";
  minimapVp.style.top  = (offY + (vy - minY) * scale) + "px";
  minimapVp.style.width = (vw * scale) + "px";
  minimapVp.style.height = (vh * scale) + "px";
}

minimap.addEventListener("click", (e) => {
  const rect = minimap.getBoundingClientRect();
  // Jump to clicked location
  const lx = (e.clientX - rect.left) / rect.width;
  const ly = (e.clientY - rect.top)  / rect.height;
  const allX = [...positions.values()].map((p) => p.x);
  const allY = [...positions.values()].map((p) => p.y);
  const minX = Math.min(...allX) - 200, maxX = Math.max(...allX) + 200;
  const minY = Math.min(...allY) - 100, maxY = Math.max(...allY) + 100;
  const W = maxX - minX, H = maxY - minY;
  const mw = rect.width, mh = rect.height - 28;
  const scale = Math.min(mw / W, mh / H);
  const wx = minX + (lx * W);
  const wy = minY + (ly * H);
  state.tx = canvasWrap.clientWidth / 2 - wx * state.scale;
  state.ty = canvasWrap.clientHeight / 2 - wy * state.scale;
  applyTransform();
  updateMinimap();
});

/* ---------- Search ---------- */
function openSearch() {
  searchOv.hidden = false;
  searchIn.value = "";
  searchRes.innerHTML = "";
  setTimeout(() => searchIn.focus(), 50);
}
function closeSearch() { searchOv.hidden = true; }

function performSearch(q) {
  searchRes.innerHTML = "";
  if (!q || q.length < 2) return;
  const ql = q.toLowerCase();
  const matches = [];
  for (const [id, node] of Object.entries(MINDMAP)) {
    if (id === "meta") continue;
    const text = (node.title + " " + node.short + " " + (node.description || "")).toLowerCase();
    if (text.includes(ql)) {
      matches.push({ id, node, idx: text.indexOf(ql) });
    }
  }
  if (!matches.length) return;
  matches.slice(0, 20).forEach(({ id, node }) => {
    const b = document.createElement("button");
    b.className = "search-result";
    b.innerHTML = `
      <span class="sr-id">§ ${id}</span>
      <span class="sr-text">${node.icon || ""} ${escapeHTML(node.short || node.title)}</span>`;
    b.addEventListener("click", () => {
      // Expand all ancestors so the node becomes visible
      let p = parentId(id);
      while (p) { state.expanded.add(p); if (p === "1") break; p = parentId(p); }
      applyVisibility();
      showDetail(id);
      focusOnNode(id);
      closeSearch();
    });
    searchRes.appendChild(b);
  });
}

/* ---------- Toolbar ---------- */
$("#btn-expand").addEventListener("click", expandAll);
$("#btn-collapse").addEventListener("click", collapseAll);
$("#btn-zoom-in").addEventListener("click", () => zoomBy(1.2));
$("#btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));
$("#btn-zoom-reset").addEventListener("click", () => {
  fitToScreen();
  toast("Барлығы бір экранға сыйды");
});
$("#btn-fit").addEventListener("click", () => {
  fitToScreen();
  toast("Барлығы бір экранға сыйды");
});
$("#btn-fullscreen").addEventListener("click", () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
});
$("#btn-search").addEventListener("click", openSearch);
$("#search-close").addEventListener("click", closeSearch);
searchIn.addEventListener("input", (e) => performSearch(e.target.value));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!searchOv.hidden) closeSearch();
    else if (!detailPanel.hidden) closeDetail();
  }
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    openSearch();
  }
  if (e.key === "+" || e.key === "=") zoomBy(1.2);
  if (e.key === "-" || e.key === "_") zoomBy(1 / 1.2);
  if (e.key === "0") fitToScreen(), toast("Барлығы бір экранға сыйды");
});
$("#detail-close").addEventListener("click", closeDetail);

function zoomBy(factor) {
  state.scale = clamp(state.scale * factor, SCALE_MIN, SCALE_MAX);
  // Zoom around centre
  const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
  const cx = w / 2, cy = h / 2;
  const wx = (cx - state.tx) / state.scale;
  const wy = (cy - state.ty) / state.scale;
  state.scale = clamp(state.scale, SCALE_MIN, SCALE_MAX);
  state.tx = cx - wx * state.scale;
  state.ty = cy - wy * state.scale;
  applyTransform();
  updateMinimap();
}

/* ---------- Export menu ---------- */
const exportMenu = $("#export-menu");
const exportBtn  = $("#btn-export");
const exportDrop = $("#export-dropdown");
exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exportDrop.hidden = !exportDrop.hidden;
});
document.addEventListener("click", () => { exportDrop.hidden = true; });
exportDrop.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const fmt = btn.dataset.fmt;
    exportDrop.hidden = true;
    doExport(fmt);
  });
});

async function doExport(fmt) {
  try {
    if (fmt === "print") { window.print(); return; }
    if (fmt === "json") {
      const blob = new Blob([JSON.stringify(MINDMAP, null, 2)], { type: "application/json" });
      downloadBlob(blob, "mindmap-kazakhstan-reforms.json");
      toast("JSON сақталды", "success");
      return;
    }
    if (fmt === "svg") {
      const svg = buildFullSVG();
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      downloadBlob(blob, "mindmap-kazakhstan-reforms.svg");
      toast("SVG сақталды", "success");
      return;
    }
    if (fmt === "png") {
      const svg = buildFullSVG();
      await rasterise(svg, "image/png", "mindmap-kazakhstan-reforms.png");
      toast("PNG сақталды", "success");
      return;
    }
    if (fmt === "pdf") {
      const svg = buildFullSVG();
      await rasterise(svg, "image/png", "mindmap-temp.png").then((png) => {
        const w = window.open("", "_blank");
        if (!w) { toast("Жаңа терезе ашылмады — popup blocker өшіріңіз", "error"); return; }
        w.document.write(`<html><head><title>Mind Map — Қазақ реформалары</title>
          <style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#0a0e27}
          img{max-width:100%;max-height:100vh;background:#fff;padding:20px}</style></head>
          <body><img src="${png}" onload="window.print()"/></body></html>`);
      });
      toast("PDF басып шығару терезесі ашылды", "success");
      return;
    }
  } catch (e) {
    console.error(e);
    toast("Экспорт қатесі: " + e.message, "error");
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

function buildFullSVG() {
  // Compute bounding box of all visible nodes
  const allX = [...positions.values()].map((p) => p.x);
  const allY = [...positions.values()].map((p) => p.y);
  const minX = Math.min(...allX) - 200;
  const maxX = Math.max(...allX) + 200;
  const minY = Math.min(...allY) - 100;
  const maxY = Math.max(...allY) + 100;
  const W = maxX - minX;
  const H = maxY - minY;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${W} ${H}" width="${W}" height="${H}">`);
  parts.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a2050"/>
      <stop offset="100%" stop-color="#0a0e27"/>
    </linearGradient>
    <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#4f8cff"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="lg2" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#FFDA27"/>
      <stop offset="100%" stop-color="#fb923c"/>
    </linearGradient>
    <style>
      .node-rect { fill: rgba(20,26,64,0.85); stroke: rgba(120,145,255,0.4); stroke-width: 1.5; }
      .node-root .node-rect { fill: url(#lg2); stroke: #FFDA27; stroke-width: 2; }
      .node-text { font-family: 'Lora', serif; fill: #fff; text-anchor: middle; }
      .node-meta { font-family: 'Inter', sans-serif; fill: rgba(255,255,255,0.6); font-size: 11px; text-anchor: middle; }
      .title-main { font-size: 26px; font-weight: 700; }
      .title-l1   { font-size: 18px; font-weight: 600; }
      .title-l2   { font-size: 15px; }
      .title-l3   { font-size: 14px; }
      .title-l4   { font-size: 13px; }
      .conn { fill: none; stroke: url(#lg1); stroke-width: 2; opacity: 0.7; }
    </style>
  </defs>`);
  parts.push(`<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="url(#bg)"/>`);

  // Lines
  for (const id of Object.keys(MINDMAP)) {
    if (id === "meta") continue;
    const node = MINDMAP[id];
    if (!node?.children?.length) continue;
    const p1 = positions.get(id); if (!p1) continue;
    for (const cid of node.children) {
      const p2 = positions.get(cid); if (!p2) continue;
      const mx = (p1.x + p2.x) / 2;
      parts.push(`<path class="conn" d="M ${p1.x + NODE_W/2} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x - NODE_W/2} ${p2.y}"/>`);
    }
  }

  // Nodes
  for (const id of Object.keys(MINDMAP)) {
    if (id === "meta") continue;
    const node = MINDMAP[id]; if (!node) continue;
    const pos = positions.get(id); if (!pos) continue;
    const d = dataDepth(id);
    const w = d === 0 ? 260 : 200;
    const h = d === 0 ? 100 : 60;
    const title = node.short || node.title;
    const titleClass = `title-${d === 0 ? "main" : "l" + d}`;
    const truncated = title.length > 32 ? title.slice(0, 32) + "…" : title;
    parts.push(`<g class="node ${d === 0 ? "node-root" : ""}">
      <rect class="node-rect" x="${pos.x - w/2}" y="${pos.y - h/2}" width="${w}" height="${h}" rx="14" ry="14"/>
      <text class="node-text ${titleClass}" x="${pos.x}" y="${pos.y + (d === 0 ? 4 : -2)}">${escapeHTML(truncated)}</text>
      <text class="node-meta" x="${pos.x}" y="${pos.y + (d === 0 ? 24 : 16)}">${id}</text>
    </g>`);
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}

function rasterise(svgString, mime, filename) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const W = img.naturalWidth || 1600;
      const H = img.naturalHeight || 1000;
      const scale = Math.min(2, 3000 / Math.max(W, H));
      const canvasEl = document.createElement("canvas");
      canvasEl.width = W * scale;
      canvasEl.height = H * scale;
      const ctx = canvasEl.getContext("2d");
      ctx.fillStyle = "#0a0e27";
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
      ctx.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);
      canvasEl.toBlob((b) => {
        if (!b) { reject(new Error("toBlob failed")); return; }
        if (filename.endsWith(".png")) {
          downloadBlob(b, filename);
        }
        resolve(URL.createObjectURL(b));
        URL.revokeObjectURL(url);
      }, mime || "image/png");
    };
    img.onerror = () => { reject(new Error("Image load failed")); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/* ---------- Welcome ---------- */
$("#welcome-go").addEventListener("click", () => {
  welcome.style.display = "none";
  // Reset to a clean state: only the root is visible. The user
  // can then click any branch to drill into it.
  setTimeout(() => {
    state.expanded = new Set();
    applyVisibility();
    centreRoot();
    updateMinimap();
    toast("Реформалар түйіні — тармақты басып ашыңыз", "success");
  }, 100);
});
// Click outside dismiss
welcome.addEventListener("click", (e) => {
  if (e.target === welcome) welcome.style.display = "none";
});

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, kind = "") {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, 2500);
}

/* ---------- Boot ---------- */
function boot() {
  console.log("[mindmap] boot()");
  try {
    layoutTree();
    console.log("[mindmap] layout done, nodes:", positions.size);
    buildNodes();
    console.log("[mindmap] buildNodes done");
    drawConnectors();
    // Centre the root node nicely in the viewport. Because the
    // initial `state.expanded` only contains "1", only the root
    // is visible — we want it large and centered, not zoomed-out.
    centreRoot();
    updateMinimap();
  } catch (e) {
    console.error("[mindmap] boot error:", e);
  }
}

/* Centre the root node in the viewport at a comfortable scale
   (1.2) so it is large and readable. Called on boot and after the
   user clicks the welcome "Бастау" button. */
function centreRoot(padding = 40) {
  const pos = positions.get("1");
  if (!pos) return;
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  if (w <= 0 || h <= 0) return;
  // Choose a scale that lets the root node fit comfortably with
  // some breathing room. Root is 240×100 px (see CSS).
  const targetScale = clamp(1.0, SCALE_MIN, SCALE_MAX);
  state.scale = targetScale;
  state.tx = w / 2 - pos.x * state.scale;
  state.ty = h / 2 - pos.y * state.scale;
  applyTransform();
}

/* Fit every currently visible node into the viewport by choosing an
   appropriate scale and translation. Called on boot, after expand-all,
   after collapse-all, when the "Fit" button is pressed, and when the
   user presses "0". The minimum allowed scale is SCALE_MIN so that the
   whole 100+ node tree can be made to fit on a single screen. */
function fitToScreen(padding = 50) {
  // Gather every position that is currently visible.
  const pts = [];
  for (const [id, pos] of positions) {
    if (isNodeVisible(id)) pts.push(pos);
  }
  if (!pts.length) return;
  const NODE_W = 200, NODE_H = 60;
  const minX = Math.min(...pts.map((p) => p.x)) - NODE_W / 2 - padding;
  const maxX = Math.max(...pts.map((p) => p.x)) + NODE_W / 2 + padding;
  const minY = Math.min(...pts.map((p) => p.y)) - NODE_H / 2 - padding;
  const maxY = Math.max(...pts.map((p) => p.y)) + NODE_H / 2 + padding;
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  if (w <= 0 || h <= 0) return;
  const dx = maxX - minX;
  const dy = maxY - minY;
  // Allow scale to go as low as SCALE_MIN so the whole tree fits.
  const scale = clamp(Math.min(w / dx, h / dy), SCALE_MIN, SCALE_MAX);
  state.scale = scale;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  state.tx = w / 2 - cx * scale;
  state.ty = h / 2 - cy * scale;
  applyTransform();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// Show welcome
welcome.style.display = "grid";

// Refresh minimap on resize
window.addEventListener("resize", () => {
  applyTransform();
  updateMinimap();
});
