"""D-016 Page 02 (Chinatown Tactical Sandbox) live Edge verification & reusable Canvas draw-ops probe.

Exports ``DRAW_OPS_INIT_SCRIPT``, ``extract_canvas_draw_frame``, ``analyze_nameplate_frame``,
``measure_canvas_label_contrast``, and ``sandbox_browser_session`` so T-017 can reuse the
exact real-draw-ops probe and fixtures without re-implementing Canvas instrumentation.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pytest
from PIL import Image

from conftest import CHINATOWN_MATCH, REPO_ROOT, build_replay_zip

RESULTS_DIR = REPO_ROOT / "Workflow" / "results"
T018_TARGET_02 = RESULTS_DIR / "T-018-art" / "targets" / "02.json"
T019_FRAMES_JSON = RESULTS_DIR / "T-019-art" / "frames.json"
SIZES: List[Tuple[int, int]] = [(1366, 768), (1440, 900), (1920, 1080)]
FAMILIES = ["Noto Serif SC", "Cinzel", "Cormorant Garamond", "LXGW WenKai Screen"]
PNG_SIG = b"\x89PNG\r\n\x1a\n"

# T-020 measured net toolbar budgets (CSS px) for expanded & collapsed desktop viewports
TOOLBAR_NET_BUDGET_OPEN = {1366: 594.53, 1440: 637.14, 1920: 931.55}
TOOLBAR_NET_BUDGET_CLOSED = {1366: 1109.94, 1440: 1179.94, 1920: 1651.94}
# Attempt-2 Chinatown footprint areas (width * height from T-018 02.json previousFootprintLTRB)
ATTEMPT2_CHINATOWN_AREA = {1366: 597 * 574, 1440: 730 * 700, 1920: 910 * 872}


def _load_helper(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


contrast_mod = _load_helper("d016_sandbox_contrast", RESULTS_DIR / "T-017-art" / "contrast.py")


def _save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- Reusable Canvas 2D draw-ops init script
DRAW_OPS_INIT_SCRIPT = r"""
(() => {
  if (globalThis.__idvDrawOpsInstalled) return;
  globalThis.__idvDrawOpsInstalled = true;

  if (!localStorage.getItem('idv.flow.v1')) {
    localStorage.setItem('idv.flow.v1', JSON.stringify({ autoFlow: false }));
  }

  // Observe Vue reactive stores cleanly in production bundle
  const NativeProxy = globalThis.Proxy;
  globalThis.Proxy = new NativeProxy(NativeProxy, {
    construct(target, args) {
      const proxy = Reflect.construct(target, args);
      if (args[0] && typeof args[0] === 'object') {
        if (Object.hasOwn(args[0], 'analyticsById')) globalThis.idvAppStore = proxy;
        if (Object.hasOwn(args[0], 'draftRegion')) globalThis.idvFlowStore = proxy;
      }
      return proxy;
    }
  });

  const proto = CanvasRenderingContext2D.prototype;
  const orig = {
    beginPath: proto.beginPath,
    closePath: proto.closePath,
    moveTo: proto.moveTo,
    lineTo: proto.lineTo,
    arc: proto.arc,
    rect: proto.rect,
    stroke: proto.stroke,
    fill: proto.fill,
    fillRect: proto.fillRect,
    clearRect: proto.clearRect,
    fillText: proto.fillText,
    strokeText: proto.strokeText,
    drawImage: proto.drawImage,
    measureText: proto.measureText,
  };

  const frames = new WeakMap();
  const footprints = new WeakMap();
  const canvasText = new WeakMap();
  globalThis.idvDrawFrames = frames;
  globalThis.idvFootprints = footprints;
  globalThis.idvCanvasText = canvasText;

  function isTrackedBase(canvas) {
    return canvas && canvas.dataset && canvas.dataset.test === 'board-canvas';
  }

  function ensureFrame(canvas) {
    let f = frames.get(canvas);
    if (!f) {
      f = { seq: 0, ops: [], path: [] };
      frames.set(canvas, f);
    }
    return f;
  }

  function snapTransform(ctx) {
    const m = ctx.getTransform();
    return [m.a, m.b, m.c, m.d, m.e, m.f];
  }

  function snapStyle(ctx) {
    return {
      ctm: snapTransform(ctx),
      font: String(ctx.font || ''),
      textAlign: String(ctx.textAlign || 'start'),
      textBaseline: String(ctx.textBaseline || 'alphabetic'),
      lineWidth: Number(ctx.lineWidth || 1),
      lineCap: String(ctx.lineCap || 'butt'),
      strokeStyle: typeof ctx.strokeStyle === 'string' ? ctx.strokeStyle.toLowerCase() : String(ctx.strokeStyle),
      fillStyle: typeof ctx.fillStyle === 'string' ? ctx.fillStyle.toLowerCase() : String(ctx.fillStyle),
      globalAlpha: Number(ctx.globalAlpha),
    };
  }

  proto.clearRect = function (x, y, w, h) {
    if (isTrackedBase(this.canvas)) {
      const m = this.getTransform();
      if (x === 0 && y === 0 && Math.abs(w * m.a - this.canvas.width) <= 2 && Math.abs(h * m.d - this.canvas.height) <= 2) {
        const prev = frames.get(this.canvas);
        frames.set(this.canvas, { seq: (prev ? prev.seq : 0) + 1, ops: [], path: [] });
        canvasText.set(this.canvas, new Set());
      }
    }
    return orig.clearRect.call(this, x, y, w, h);
  };

  proto.fillRect = function (x, y, w, h) {
    if (isTrackedBase(this.canvas)) {
      const m = this.getTransform();
      const fullReset =
        x === 0 && y === 0 &&
        Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6 &&
        Math.abs(m.e) < 1e-6 && Math.abs(m.f) < 1e-6 &&
        Math.abs(w * m.a - this.canvas.width) <= 2 &&
        Math.abs(h * m.d - this.canvas.height) <= 2;
      if (fullReset) {
        const prev = frames.get(this.canvas);
        frames.set(this.canvas, { seq: (prev ? prev.seq : 0) + 1, ops: [], path: [] });
        canvasText.set(this.canvas, new Set());
      } else {
        const f = ensureFrame(this.canvas);
        f.ops.push({ op: 'fillRect', args: [x, y, w, h], ...snapStyle(this) });
      }
    }
    return orig.fillRect.call(this, x, y, w, h);
  };

  proto.beginPath = function () {
    if (isTrackedBase(this.canvas)) {
      const f = ensureFrame(this.canvas);
      f.path = [];
      f.ops.push({ op: 'beginPath' });
    }
    return orig.beginPath.call(this);
  };

  proto.moveTo = function (x, y) {
    if (isTrackedBase(this.canvas)) {
      ensureFrame(this.canvas).path.push({ k: 'M', x, y });
    }
    return orig.moveTo.call(this, x, y);
  };

  proto.lineTo = function (x, y) {
    if (isTrackedBase(this.canvas)) {
      ensureFrame(this.canvas).path.push({ k: 'L', x, y });
    }
    return orig.lineTo.call(this, x, y);
  };

  proto.arc = function (x, y, r, sa, ea, ccw) {
    if (isTrackedBase(this.canvas)) {
      ensureFrame(this.canvas).path.push({ k: 'A', x, y, r, sa, ea });
    }
    return orig.arc.call(this, x, y, r, sa, ea, ccw);
  };

  proto.rect = function (x, y, w, h) {
    if (isTrackedBase(this.canvas)) {
      ensureFrame(this.canvas).path.push({ k: 'R', x, y, w, h });
    }
    return orig.rect.call(this, x, y, w, h);
  };

  proto.closePath = function () {
    if (isTrackedBase(this.canvas)) {
      ensureFrame(this.canvas).path.push({ k: 'Z' });
    }
    return orig.closePath.call(this);
  };

  proto.stroke = function (...args) {
    if (isTrackedBase(this.canvas)) {
      const f = ensureFrame(this.canvas);
      f.ops.push({ op: 'stroke', path: f.path.slice(), ...snapStyle(this) });
    }
    return orig.stroke.apply(this, args);
  };

  proto.fill = function (...args) {
    if (isTrackedBase(this.canvas)) {
      const f = ensureFrame(this.canvas);
      f.ops.push({ op: 'fill', path: f.path.slice(), ...snapStyle(this) });
    }
    return orig.fill.apply(this, args);
  };

  function captureText(ctx, op, text, x, y) {
    const label = String(text);
    if (op === 'fillText') {
      let s = canvasText.get(ctx.canvas);
      if (!s) canvasText.set(ctx.canvas, s = new Set());
      if (s.size < 500) s.add(label);
    }
    if (!isTrackedBase(ctx.canvas)) return;
    const f = ensureFrame(ctx.canvas);
    const tm = orig.measureText.call(ctx, label);
    f.ops.push({
      op,
      text: label,
      x,
      y,
      metrics: {
        width: tm.width,
        actualBoundingBoxLeft: tm.actualBoundingBoxLeft,
        actualBoundingBoxRight: tm.actualBoundingBoxRight,
        actualBoundingBoxAscent: tm.actualBoundingBoxAscent,
        actualBoundingBoxDescent: tm.actualBoundingBoxDescent,
      },
      ...snapStyle(ctx),
    });
  }

  proto.strokeText = function (text, x, y, ...rest) {
    captureText(this, 'strokeText', text, x, y);
    return orig.strokeText.call(this, text, x, y, ...rest);
  };

  proto.fillText = function (text, x, y, ...rest) {
    captureText(this, 'fillText', text, x, y);
    return orig.fillText.call(this, text, x, y, ...rest);
  };

  proto.drawImage = function (img, ...args) {
    const res = orig.drawImage.apply(this, [img, ...args]);
    const w = img && (img.naturalWidth || img.width || 0);
    const h = img && (img.naturalHeight || img.height || 0);
    if (w >= 300 && h >= 300 && this.canvas) {
      const [x, y, dw, dh] = args.length === 8 ? args.slice(4) :
        args.length === 4 ? args : [args[0] || 0, args[1] || 0, w, h];
      const matrix = this.getTransform();
      const corners = [[x, y], [x + dw, y], [x, y + dh], [x + dw, y + dh]]
        .map(([u, v]) => matrix.transformPoint({ x: u, y: v }));
      const area = Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) * dw * dh;
      if (area > this.canvas.width * this.canvas.height / 10) footprints.set(this.canvas, corners);
    }
    return res;
  };
})();
"""

HOST_OBSTACLE_SELECTORS_JS = ",".join([
    "#strip",
    "#strip.hud-expanded .hud-content",
    "#toolbarWrap #toolbar",
    "#toolbarWrap .view-pop",
    "#toolbarWrap .archive-pop",
    "#toolbarWrap .toolbar-menu-pop",
    ".board .compass",
    ".board .scale",
    ".board .hud",
    ".board .map-badges",
    ".board .legend-card.map-key",
    ".board .rail-zoom-tools",
    ".director-band [data-test='director-bar']",
    "#boardPanel > .folio-toggle",
    "#boardPanel > .linked-cta",
    "[data-test='replay-summary']",
    ".transport-help[open] p",
    ".flow-preferences",
    ".desk-still > .bookmark",
])


def _rect_overlap(a: Sequence[float], b: Sequence[float]) -> float:
    """Intersection area in CSS px² for [left, top, right, bottom] rects."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, w) * max(0.0, h)


def _xywh_to_ltrb(box: Sequence[float]) -> List[float]:
    return [float(box[0]), float(box[1]), float(box[0] + box[2]), float(box[1] + box[3])]


def _union_ltrb(a: Sequence[float], b: Sequence[float]) -> List[float]:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _transform_box(
    ltrb: Sequence[float],
    ctm: Sequence[float],
    sx: float,
    sy: float,
    ox: float = 0.0,
    oy: float = 0.0,
) -> List[float]:
    a, b, c, d, e, f = ctm
    xs: List[float] = []
    ys: List[float] = []
    for x in (ltrb[0], ltrb[2]):
        for y in (ltrb[1], ltrb[3]):
            px = a * x + c * y + e
            py = b * x + d * y + f
            xs.append(ox + px * sx)
            ys.append(oy + py * sy)
    return [min(xs), min(ys), max(xs), max(ys)]


def extract_canvas_draw_frame(page, selector: str = "[data-test='board-canvas']") -> Dict[str, Any]:
    """Pull the latest complete single-frame draw ops and live DOM obstacles from Edge."""
    raw = page.evaluate(
        """([sel, obsSel]) => {
          const c = document.querySelector(sel);
          if (!c) return null;
          const cr = c.getBoundingClientRect();
          const frame = globalThis.idvDrawFrames?.get(c);
          const isVis = (el) => {
            if (!el || !el.isConnected) return false;
            let cur = el;
            while (cur) {
              const cs = getComputedStyle(cur);
              if (cs.display === 'none' || cs.visibility === 'hidden') return false;
              if (cur.id === 'app' || cur === document.body) break;
              cur = cur.parentElement;
            }
            return true;
          };
          const root = document.getElementById('app') || document.body;
          const hostObstacles = [];
          const seen = new Set();
          for (const el of root.querySelectorAll(obsSel)) {
            if (seen.has(el) || !isVis(el)) continue;
            seen.add(el);
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            const l = Math.max(cr.left, r.left), t = Math.max(cr.top, r.top);
            const ri = Math.min(cr.right, r.right), b = Math.min(cr.bottom, r.bottom);
            if (ri <= l + 0.5 || b <= t + 0.5) continue;
            hostObstacles.push({
              label: el.id || el.dataset?.test || (typeof el.className === 'string' ? el.className : el.className?.baseVal || el.tagName),
              local: [l - cr.left, t - cr.top, ri - cr.left, b - cr.top],
              viewport: [l, t, ri, b],
            });
          }
          const fp = globalThis.idvFootprints?.get(c);
          const fpCss = fp ? fp.map(pt => [cr.left + pt.x * cr.width / c.width, cr.top + pt.y * cr.height / c.height]) : null;
          return {
            canvasRect: [cr.left, cr.top, cr.width, cr.height],
            canvasW: c.width,
            canvasH: c.height,
            dpr: window.devicePixelRatio || 1,
            frameSeq: frame ? frame.seq : 0,
            ops: frame ? frame.ops : [],
            hostObstacles,
            footprintCss: fpCss,
          };
        }""",
        [selector, HOST_OBSTACLE_SELECTORS_JS],
    )
    assert raw is not None, f"canvas not found: {selector}"
    cr_x, cr_y, cr_w, cr_h = raw["canvasRect"]
    sx = cr_w / raw["canvasW"] if raw["canvasW"] else 1.0
    sy = cr_h / raw["canvasH"] if raw["canvasH"] else 1.0

    ops = raw["ops"]
    plates: List[Dict[str, Any]] = []
    leaders: List[Dict[str, Any]] = []
    arcs: List[Dict[str, Any]] = []
    scene_texts: List[Dict[str, Any]] = []
    active_plate: Optional[Dict[str, Any]] = None
    first_plate_idx: Optional[int] = None
    last_plate_op_idx: int = -1

    for idx, op in enumerate(ops):
        kind = op.get("op")
        if kind == "beginPath":
            if active_plate is not None:
                plates.append(active_plate)
                active_plate = None
            continue

        if kind == "stroke":
            path = op.get("path") or []
            ctm = op["ctm"]
            # Detect nameplate round-cap capsule background stroke
            if (
                op.get("lineCap") == "round"
                and op.get("strokeStyle") in ("#0b0a09", "rgb(11, 10, 9)")
                and op.get("lineWidth", 0) >= 12
                and len(path) == 2
                and path[0]["k"] == "M"
                and path[1]["k"] == "L"
                and abs(path[1]["y"] - path[0]["y"]) < 1e-4
            ):
                if active_plate is not None:
                    plates.append(active_plate)
                if first_plate_idx is None:
                    first_plate_idx = idx
                last_plate_op_idx = idx
                h = op["lineWidth"] / 2.0
                x1, x2 = min(path[0]["x"], path[1]["x"]), max(path[0]["x"], path[1]["x"])
                y0 = path[0]["y"]
                raw_box = [x1 - h, y0 - h, x2 + h, y0 + h]
                active_plate = {
                    "drawIndex": len(plates),
                    "opIndex": idx,
                    "plateLocal": _transform_box(raw_box, ctm, sx, sy),
                    "plateViewport": _transform_box(raw_box, ctm, sx, sy, cr_x, cr_y),
                    "back": op["strokeStyle"],
                    "lines": [],
                    "inkLocal": None,
                    "inkViewport": None,
                    "text": "",
                    "color": None,
                    "font": None,
                    "fontPx": 0.0,
                }
                continue

            # Detect leader line segment (lineWidth==1, butt cap, hunter/survivor color)
            if (
                op.get("lineCap") == "butt"
                and abs(op.get("lineWidth", 0) - 1.0) < 1e-4
                and op.get("strokeStyle") in ("#e0626f", "#8fb3e0")
                and any(p["k"] == "L" for p in path)
            ):
                segs = []
                cur_m = None
                for p in path:
                    if p["k"] == "M":
                        cur_m = (p["x"], p["y"])
                    elif p["k"] == "L" and cur_m is not None:
                        a_box = _transform_box([cur_m[0], cur_m[1], cur_m[0], cur_m[1]], ctm, sx, sy)
                        b_box = _transform_box([p["x"], p["y"], p["x"], p["y"]], ctm, sx, sy)
                        segs.append([a_box[0], a_box[1], b_box[0], b_box[1]])
                        cur_m = (p["x"], p["y"])
                if segs:
                    leaders.append({"color": op["strokeStyle"], "segments": segs})
                continue

            # Track circle strokes (player tokens, rings, pulses)
            for p in path:
                if p["k"] == "A":
                    r_ext = p["r"] + op.get("lineWidth", 1) / 2.0
                    center = _transform_box([p["x"], p["y"], p["x"], p["y"]], ctm, sx, sy)
                    bbox = _transform_box([p["x"] - r_ext, p["y"] - r_ext, p["x"] + r_ext, p["y"] + r_ext], ctm, sx, sy)
                    arcs.append({
                        "opIndex": idx,
                        "op": "stroke",
                        "centerLocal": [center[0], center[1]],
                        "radiusPx": p["r"] * math.hypot(ctm[0], ctm[1]) * sx,
                        "boxLocal": bbox,
                        "strokeStyle": op["strokeStyle"],
                        "lineWidth": op["lineWidth"],
                    })
            continue

        if kind == "fill":
            path = op.get("path") or []
            ctm = op["ctm"]
            for p in path:
                if p["k"] == "A":
                    center = _transform_box([p["x"], p["y"], p["x"], p["y"]], ctm, sx, sy)
                    bbox = _transform_box([p["x"] - p["r"], p["y"] - p["r"], p["x"] + p["r"], p["y"] + p["r"]], ctm, sx, sy)
                    arcs.append({
                        "opIndex": idx,
                        "op": "fill",
                        "centerLocal": [center[0], center[1]],
                        "radiusPx": p["r"] * math.hypot(ctm[0], ctm[1]) * sx,
                        "boxLocal": bbox,
                        "fillStyle": op["fillStyle"],
                    })
            continue

        if kind in ("strokeText", "fillText"):
            ctm = op["ctm"]
            m = op["metrics"]
            x0, y0 = op["x"], op["y"]
            pad = op["lineWidth"] / 2.0 if kind == "strokeText" else 0.0
            raw_ink = [
                x0 - m["actualBoundingBoxLeft"] - pad,
                y0 - m["actualBoundingBoxAscent"] - pad,
                x0 + m["actualBoundingBoxRight"] + pad,
                y0 + m["actualBoundingBoxDescent"] + pad,
            ]
            ink_local = _transform_box(raw_ink, ctm, sx, sy)
            ink_vp = _transform_box(raw_ink, ctm, sx, sy, cr_x, cr_y)
            font_match = re.search(r"([0-9.]+)px", op["font"])
            font_px = float(font_match.group(1)) * math.hypot(ctm[2], ctm[3]) * sy if font_match else 0.0

            if active_plate is not None and op.get("textBaseline") == "bottom" and op.get("textAlign") == "center":
                last_plate_op_idx = idx
                active_plate["inkLocal"] = ink_local if active_plate["inkLocal"] is None else _union_ltrb(active_plate["inkLocal"], ink_local)
                active_plate["inkViewport"] = ink_vp if active_plate["inkViewport"] is None else _union_ltrb(active_plate["inkViewport"], ink_vp)
                if kind == "fillText" and op["fillStyle"] != active_plate["back"]:
                    base_pt = _transform_box([x0, y0, x0, y0], ctm, sx, sy)
                    active_plate["lines"].append({
                        "text": op["text"],
                        "baselineLocal": [base_pt[0], base_pt[1]],
                        "font": op["font"],
                        "fontPx": round(font_px, 3),
                        "color": op["fillStyle"],
                        "inkLocal": ink_local,
                        "inkViewport": ink_vp,
                    })
                    active_plate["text"] = "".join(ln["text"] for ln in active_plate["lines"])
                    active_plate["color"] = op["fillStyle"]
                    active_plate["font"] = op["font"]
                    active_plate["fontPx"] = min(ln["fontPx"] for ln in active_plate["lines"])
            else:
                scene_texts.append({
                    "opIndex": idx,
                    "op": kind,
                    "text": op["text"],
                    "boxLocal": ink_local,
                    "fontPx": round(font_px, 3),
                })

    if active_plate is not None:
        plates.append(active_plate)

    # Filter out any accidental capsule that had no text lines
    plates = [p for p in plates if p["lines"]]

    # Painted player token body circles (renderer draws lineWidth=2 stroke in #e0626f hunter / #8fb3e0 survivor)
    token_circles = [
        {
            "opIndex": a["opIndex"],
            "camp": 1 if a.get("strokeStyle") == "#e0626f" else 2,
            "centerLocal": [round(a["centerLocal"][0], 4), round(a["centerLocal"][1], 4)],
            "radiusPx": round(a["radiusPx"], 3),
            "boxLocal": [round(v, 3) for v in a["boxLocal"]],
        }
        for a in arcs
        if a.get("op") == "stroke"
        and abs(a.get("lineWidth", 0.0) - 2.0) < 1e-4
        and a.get("strokeStyle") in ("#e0626f", "#8fb3e0")
        and (first_plate_idx is None or a["opIndex"] < first_plate_idx)
    ]

    return {
        "canvasRect": raw["canvasRect"],
        "canvasW": raw["canvasW"],
        "canvasH": raw["canvasH"],
        "dpr": raw["dpr"],
        "frameSeq": raw["frameSeq"],
        "opCount": len(ops),
        "firstPlateOpIndex": first_plate_idx,
        "lastPlateOpIndex": last_plate_op_idx,
        "plates": plates,
        "leaders": leaders,
        "arcs": arcs,
        "tokenCircles": token_circles,
        "sceneTexts": scene_texts,
        "hostObstacles": raw["hostObstacles"],
        "footprintCss": raw["footprintCss"],
    }


def analyze_nameplate_frame(
    frame: Dict[str, Any],
    expected_players: Sequence[Dict[str, Any]],
    *,
    selected_uid: Optional[int] = None,
    check_host_obstacles: bool = True,
) -> Dict[str, Any]:
    """Independently compute all pairwise plate/ink/obstacle overlaps and per-UID records from real draw ops."""
    _, _, cw, ch = frame["canvasRect"]
    plates = frame["plates"]

    # Deterministic priority order matching T-019 (selected -> hunter -> numeric UID ascending)
    ordered_expected = sorted(
        expected_players,
        key=lambda p: (0 if p["uid"] == selected_uid else 1, 0 if p["camp"] == 1 else 1, int(p["uid"])),
    )

    # Match drawn plates to UIDs by draw order + exact name (never collapsing duplicate names into a dict)
    used_indices: set[int] = set()
    used_tokens: set[int] = set()
    token_circles = frame.get("tokenCircles") or []
    matched_records: List[Dict[str, Any]] = []
    unmatched_plates: List[str] = []

    for exp in ordered_expected:
        want = exp["player_name"]
        picked = None
        for i, pl in enumerate(plates):
            if i in used_indices:
                continue
            if pl["text"] == want or pl["text"].endswith(f". {want}"):
                picked = (i, pl)
                break
        if picked is not None:
            idx, pl = picked
            used_indices.add(idx)
            # Match nearest unused camp-consistent painted token circle for per-UID token center audit
            pl_cx = (pl["plateLocal"][0] + pl["plateLocal"][2]) / 2.0
            pl_cy = (pl["plateLocal"][1] + pl["plateLocal"][3]) / 2.0
            best_tok_idx: Optional[int] = None
            best_dist = float("inf")
            for ti, tc in enumerate(token_circles):
                if ti in used_tokens or tc["camp"] != int(exp["camp"]):
                    continue
                d = math.hypot(tc["centerLocal"][0] - pl_cx, tc["centerLocal"][1] - pl_cy)
                if d < best_dist:
                    best_dist = d
                    best_tok_idx = ti
            token_center = None
            if best_tok_idx is not None:
                used_tokens.add(best_tok_idx)
                token_center = token_circles[best_tok_idx]["centerLocal"]
            matched_records.append({
                "uid": int(exp["uid"]),
                "name": want,
                "drawnText": pl["text"],
                "camp": int(exp["camp"]),
                "drawIndex": pl["drawIndex"],
                "lineCount": len(pl["lines"]),
                "fontPx": pl["fontPx"],
                "color": pl["color"],
                "back": pl["back"],
                "tokenCenterLocal": token_center,
                "baselineLocal": pl["lines"][0]["baselineLocal"],
                "plateLocal": [round(v, 3) for v in pl["plateLocal"]],
                "inkLocal": [round(v, 3) for v in pl["inkLocal"]],
                "plateViewport": [round(v, 3) for v in pl["plateViewport"]],
            })

    for i, pl in enumerate(plates):
        if i not in used_indices:
            unmatched_plates.append(pl["text"])

    # Pairwise intersections across ALL drawn plates
    max_plate_plate = 0.0
    max_ink_ink = 0.0
    max_ink_other_plate = 0.0
    for i, a in enumerate(plates):
        for b in plates[i + 1:]:
            max_plate_plate = max(max_plate_plate, _rect_overlap(a["plateLocal"], b["plateLocal"]))
            max_ink_ink = max(max_ink_ink, _rect_overlap(a["inkLocal"], b["inkLocal"]))
            max_ink_other_plate = max(
                max_ink_other_plate,
                _rect_overlap(a["inkLocal"], b["plateLocal"]),
                _rect_overlap(b["inkLocal"], a["plateLocal"]),
            )

    # Host DOM obstacle intersections (toolbar, strip, compass, scale, HUD, legend, director, folio-toggle, visible props)
    max_plate_host = 0.0
    host_hits: List[Dict[str, Any]] = []
    if check_host_obstacles:
        for pl in plates:
            for obs in frame["hostObstacles"]:
                ov = max(_rect_overlap(pl["plateLocal"], obs["local"]), _rect_overlap(pl["inkLocal"], obs["local"]))
                if ov > 0.0:
                    max_plate_host = max(max_plate_host, ov)
                    host_hits.append({"text": pl["text"], "obstacle": obs["label"], "area": round(ov, 3)})

    # Painted player token body intersections (plates must never overlap any player token body)
    max_plate_token = 0.0
    for tc in token_circles:
        for pl in plates:
            ov = max(_rect_overlap(pl["plateLocal"], tc["boxLocal"]), _rect_overlap(pl["inkLocal"], tc["boxLocal"]))
            max_plate_token = max(max_plate_token, ov)

    # Foreground pulses / post-plate rings drawn after plates
    last_plate_op = frame["lastPlateOpIndex"]
    max_plate_fg = 0.0
    for arc in frame["arcs"]:
        if last_plate_op >= 0 and arc["opIndex"] > last_plate_op:
            for pl in plates:
                ov = max(_rect_overlap(pl["plateLocal"], arc["boxLocal"]), _rect_overlap(pl["inkLocal"], arc["boxLocal"]))
                max_plate_fg = max(max_plate_fg, ov)

    # Clipping check against drawable canvas bounds [0, 0, cw, ch]
    clipped = []
    for pl in plates:
        for key in ("plateLocal", "inkLocal"):
            l, t, r, b = pl[key]
            if l < -0.5 or t < -0.5 or r > cw + 0.5 or b > ch + 0.5:
                clipped.append({"text": pl["text"], "kind": key, "box": [round(v, 3) for v in pl[key]], "canvas": [cw, ch]})

    degraded = sum(
        1
        for rec in matched_records
        if rec["lineCount"] > 1 or (rec["drawnText"] != rec["name"] and not rec["drawnText"].endswith(f". {rec['name']}"))
    ) + max(0, len(ordered_expected) - len(matched_records))

    min_font = min((pl["fontPx"] for pl in plates), default=0.0)

    return {
        "eligibleCount": len(ordered_expected),
        "drawnCount": len(plates),
        "tokenCircleCount": len(token_circles),
        "matchedCount": len(matched_records),
        "degradedCount": degraded,
        "unmatchedPlates": unmatched_plates,
        "minFontPx": round(min_font, 3),
        "maxPlatePlateOverlap": round(max_plate_plate, 4),
        "maxInkInkOverlap": round(max_ink_ink, 4),
        "maxInkOtherPlateOverlap": round(max_ink_other_plate, 4),
        "maxPlateTokenOverlap": round(max_plate_token, 4),
        "maxPlateHostOverlap": round(max_plate_host, 4),
        "maxPlateForegroundOverlap": round(max_plate_fg, 4),
        "hostHits": host_hits,
        "clipped": clipped,
        "hostObstacleCount": len(frame["hostObstacles"]),
        "leaderCount": len(frame["leaders"]),
        "perUid": matched_records,
    }


def _wcag_ratio(rgb1: np.ndarray, rgb2: np.ndarray) -> np.ndarray:
    l1 = contrast_mod.luminance(rgb1)
    l2 = contrast_mod.luminance(rgb2)
    return (np.maximum(l1, l2) + 0.05) / (np.minimum(l1, l2) + 0.05)


def measure_canvas_label_contrast(page, frame: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Measure rendered Canvas player nameplate WCAG contrast using actual rendered pixels.

    Captures the current labeled canvas, disables labels at the exact same camera to capture
    the backing pixels, and samples solid glyph foreground pixels against the adjacent dark
    plate/outline pixels (excluding anti-aliased transition fringes).
    """
    with_labels = np.asarray(Image.open(io.BytesIO(page.screenshot())).convert("RGB"), dtype=np.float64)
    # Toggle labels off via the real ViewSettingsPopover control
    page.click("[data-test=btn-view-settings]")
    page.click("[data-test=btn-labels]")
    page.click("[data-test=btn-view-close]")
    _settle_sandbox(page)
    no_label_frame = extract_canvas_draw_frame(page)
    assert len(no_label_frame["plates"]) == 0, "labels=false must draw zero nameplate plates"
    assert len(no_label_frame["tokenCircles"]) == len(frame["tokenCircles"]), (
        len(no_label_frame["tokenCircles"]),
        len(frame["tokenCircles"]),
    )
    max_token_drift = max(
        (
            math.hypot(a["centerLocal"][0] - b["centerLocal"][0], a["centerLocal"][1] - b["centerLocal"][1])
            for a, b in zip(frame["tokenCircles"], no_label_frame["tokenCircles"])
        ),
        default=0.0,
    )
    assert max_token_drift <= 0.01, f"nameplates shifted painted token centers by {max_token_drift:.4f} CSS px"
    without_labels = np.asarray(Image.open(io.BytesIO(page.screenshot())).convert("RGB"), dtype=np.float64)
    # Restore labels on
    page.click("[data-test=btn-view-settings]")
    page.click("[data-test=btn-labels]")
    page.click("[data-test=btn-view-close]")
    _settle_sandbox(page)

    results = []
    h_img, w_img = with_labels.shape[:2]
    for pl in frame["plates"]:
        hex_bg = (pl["back"] or "#0b0a09").lstrip("#")
        target_bg = np.array([int(hex_bg[0:2], 16), int(hex_bg[2:4], 16), int(hex_bg[4:6], 16)], dtype=np.float64)

        l, t, r, b = pl["plateViewport"]
        x0, y0 = max(0, math.floor(l)), max(0, math.floor(t))
        x1, y1 = min(w_img, math.ceil(r)), min(h_img, math.ceil(b))
        patch = with_labels[y0:y1, x0:x1]
        bg_patch = without_labels[y0:y1, x0:x1]

        # Identify solid dark plate/outline backing pixels and solid glyph interior pixels
        # (excluding anti-aliased transition fringes per D-016 "采样字心实色与直接邻接的背板/描边，剔除混色抗锯齿边缘").
        bg_dist = np.linalg.norm(patch - target_bg, axis=2)
        plate_mask = bg_dist <= 8.0
        assert plate_mask.any(), f"no solid dark plate pixels found for {pl['text']}"
        plate_rgb = patch[plate_mask]
        plate_med = np.median(plate_rgb, axis=0)

        diff_from_plate = np.linalg.norm(patch - plate_med, axis=2)
        peak_diff = float(diff_from_plate.max())
        assert peak_diff >= 80.0, f"glyph too faint inside plate for {pl['text']} (peak={peak_diff:.1f})"
        fg_mask = diff_from_plate >= peak_diff * 0.92
        fg_rgb = patch[fg_mask]

        fg_lum = contrast_mod.luminance(fg_rgb)
        plate_lum = contrast_mod.luminance(plate_rgb)
        worst_fg = float(fg_lum.min())
        worst_plate = float(plate_lum.max())
        ratio = (max(worst_fg, worst_plate) + 0.05) / (min(worst_fg, worst_plate) + 0.05)
        changed_px = int((np.abs(patch - bg_patch).max(axis=2) > 5).sum())
        results.append({
            "text": pl["text"],
            "fgHex": pl["color"],
            "backHex": pl["back"],
            "sampledFgMedianRgb": [round(float(v), 1) for v in np.median(fg_rgb, axis=0)],
            "sampledPlateMedianRgb": [round(float(v), 1) for v in plate_med],
            "fgPixels": int(fg_mask.sum()),
            "platePixels": int(plate_mask.sum()),
            "changedPixels": changed_px,
            "minimumContrast": round(ratio, 4),
        })
    return results


def _settle_sandbox(page) -> None:
    page.wait_for_load_state("networkidle")
    page.evaluate(
        """async families => {
          for (const family of families) {
            await document.fonts.load('16px "' + family + '"',
              family.includes('SC') || family.includes('WenKai') ? '庄园' : 'Manor');
          }
          await document.fonts.ready;
          await Promise.all([...document.images].filter(i => i.currentSrc).map(i => i.decode().catch(() => {})));
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
        }""",
        FAMILIES,
    )


def _open_match_paused(page, base: str, match_id: str, t_seconds: float, width: int, height: int) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{base}/?d016={match_id}-{t_seconds}-{width}#m={match_id}&s=2&t={t_seconds}&auto=0", wait_until="networkidle")
    page.locator("[data-test=board-canvas]").wait_for()
    page.locator(".case-lineup").wait_for(state="attached")
    page.wait_for_function(
        """([mid, targetT]) => {
          const s = globalThis.idvAppStore;
          const c = document.querySelector('[data-test=board-canvas]');
          return s && s.replay?.match.match_id === mid && Math.abs(s.t - targetT) < 0.25 && globalThis.idvFootprints?.has(c);
        }""",
        arg=[match_id, float(t_seconds)],
        timeout=20000,
    )
    if page.evaluate("idvAppStore.playing"):
        page.click("[data-test=btn-play]")
    page.locator("[data-test=scrubber]").fill(f"{t_seconds:g}")
    _settle_sandbox(page)


def _ensure_folio(page, opened: bool) -> None:
    toggle = page.locator("#stage2 .folio-toggle")
    if toggle.get_attribute("aria-expanded") != str(opened).lower():
        toggle.click()
        _settle_sandbox(page)
    assert toggle.get_attribute("aria-expanded") == str(opened).lower()


def _reset_view_via_popover(page) -> None:
    page.click("[data-test=btn-view-settings]")
    page.click("[data-test=btn-reset]")
    page.click("[data-test=btn-view-close]")
    _settle_sandbox(page)


# --------------------------------------------------------------------------- Reusable Browser Fixture
@pytest.fixture(scope="module")
def sandbox_browser_session(frontend_server, screenshot_dir):
    sync_api = pytest.importorskip("playwright.sync_api")
    pw = sync_api.sync_playwright().start()
    try:
        browser = pw.chromium.launch(
            headless=True,
            channel="msedge",
            args=[
                "--use-gl=angle",
                "--use-angle=swiftshader",
                "--enable-webgl",
                "--enable-unsafe-swiftshader",
                "--ignore-gpu-blocklist",
            ],
        )
    except Exception:
        pw.stop()
        raise
    ctx = browser.new_context(
        viewport={"width": 1440, "height": 900},
        device_scale_factor=1,
        locale="zh-CN",
        accept_downloads=True,
    )
    ctx.add_init_script(DRAW_OPS_INIT_SCRIPT)
    page = ctx.new_page()
    page.set_default_timeout(15000)
    errors: Dict[str, list] = {"console": [], "page": [], "http": [], "failed": [], "external": [], "assets": []}
    base_url = str(frontend_server["base"])

    page.on("console", lambda m: errors["console"].append(f"{m.text} @ {m.location.get('url', '')}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors["page"].append(str(e)))
    page.on(
        "request",
        lambda req: errors["external"].append(req.url)
        if not req.url.startswith(base_url) and not req.url.startswith(("data:", "blob:", "about:"))
        else None,
    )

    def on_response(resp):
        if resp.url.startswith(base_url):
            if resp.status >= 400:
                errors["http"].append(f"{resp.status} {resp.url}")
            if "/assets/" in resp.url:
                errors["assets"].append((resp.url, resp.status))

    page.on("response", on_response)
    page.on(
        "requestfailed",
        lambda req: errors["failed"].append(f"{req.url} {req.failure} at {page.url}")
        if req.url.startswith(base_url)
        else None,
    )
    session = {
        "page": page,
        "context": ctx,
        "base": base_url,
        "shots": screenshot_dir,
        "errors": errors,
        "browser_version": browser.version,
    }
    try:
        yield session
    finally:
        for closer in (page.close, ctx.close, browser.close, pw.stop):
            try:
                closer()
            except Exception:
                pass


# --------------------------------------------------------------------------- Tests
@pytest.mark.e2e
@pytest.mark.browser
@pytest.mark.parametrize("width,height", SIZES)
def test_01_layout_footprint_toolbar_and_luminance(sandbox_browser_session, cached_payloads, width, height):
    page = sandbox_browser_session["page"]
    base = sandbox_browser_session["base"]
    shots = sandbox_browser_session["shots"]
    target_02 = json.loads(T018_TARGET_02.read_text(encoding="utf-8"))
    world = cached_payloads[CHINATOWN_MATCH]["replay"]["world"]["map_underlay"]["world_rect"]
    world_w = world["max_x"] - world["min_x"]

    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear(); localStorage.setItem('idv.flow.v1', JSON.stringify({autoFlow:false}));")
    _open_match_paused(page, base, CHINATOWN_MATCH, 120.0, width, height)

    summary = {"viewport": [width, height], "edge": sandbox_browser_session["browser_version"], "states": {}}
    for state in ("open", "closed"):
        opened = state == "open"
        _ensure_folio(page, opened)
        _reset_view_via_popover(page)

        shot_path = shots / f"{width}-02-{state}.png"
        live_img = Image.open(io.BytesIO(page.screenshot(path=str(shot_path)))).convert("RGB")

        geom = page.evaluate(
            r"""worldW => {
              const q = s => document.querySelector(s);
              const rect = s => {
                const e = typeof s === 'string' ? q(s) : s;
                if (!e || !e.checkVisibility()) return null;
                const r = e.getBoundingClientRect();
                return r.width && r.height ? [r.x, r.y, r.width, r.height] : null;
              };
              const c = q('[data-test=board-canvas]');
              const cr = c.getBoundingClientRect();
              const quad = idvFootprints.get(c).map(p => [cr.x + p.x * cr.width / c.width, cr.y + p.y * cr.height / c.height]);
              const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
              const ml = Math.max(cr.left, Math.min(...xs)), mt = Math.max(cr.top, Math.min(...ys));
              const mr = Math.min(cr.right, Math.max(...xs)), mb = Math.min(cr.bottom, Math.max(...ys));
              const strip = rect('#strip');
              const tbWrap = rect('#toolbarWrap');
              const tbEl = q('#toolbar');
              const tbButtons = Array.from(tbEl.querySelectorAll('button')).filter(b => b.checkVisibility()).map(b => {
                const r = b.getBoundingClientRect();
                const tr = tbEl.getBoundingClientRect();
                return {
                  text: b.textContent.trim(),
                  clipped: r.left < tr.left - 0.5 || r.right > tr.right + 0.5 || r.top < tr.top - 0.5 || r.bottom > tr.bottom + 0.5,
                  fontSize: parseFloat(getComputedStyle(b).fontSize),
                };
              });
              const ticks = [...document.querySelectorAll('.scale text')].map(t => ({
                meters: parseFloat(t.textContent),
                cssX: new DOMPoint(t.x.baseVal[0].value, 0).matrixTransform(t.getScreenCTM()).x,
              }));
              const allText = [...document.querySelectorAll('#bar *, #s2 *')].filter(e =>
                e.checkVisibility() && e.getClientRects().length &&
                [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
              );
              const fontSizes = allText.map(e => {
                const m = e.getScreenCTM?.();
                return { text: e.textContent.trim().slice(0, 24), px: parseFloat(getComputedStyle(e).fontSize) * (m ? Math.hypot(m.c, m.d) : 1) };
              });
              const dimOpacities = allText.filter(e => {
                const cs = getComputedStyle(e), rgb = cs.color.match(/[0-9]+/g);
                return rgb && '#' + rgb.map(n => (+n).toString(16).padStart(2, '0')).join('') === cs.getPropertyValue('--dim').trim().toLowerCase();
              }).map(e => {
                let op = 1;
                for (let n = e; n; n = n.parentElement) op *= +getComputedStyle(n).opacity;
                return op;
              });
              return {
                overflow: document.documentElement.scrollWidth - innerWidth,
                stage: rect('#stage'),
                bar: rect('#bar'),
                board: rect('.board'),
                folio: rect('#rightCol'),
                transport: rect('#transport'),
                compass: rect('.compass'),
                scale: rect('.scale'),
                dock: rect('.map-key'),
                badges: rect('.map-badges'),
                clip: rect('#rightCol > .binder-clip'),
                deskImgs: document.querySelectorAll('.desk-still > img').length,
                photoPins: document.querySelectorAll('.photo-pin').length,
                leakedPropImgs: [...document.querySelectorAll('img')].filter(i => /desk-(fountain-pen|pocket-watch|vintage-postcard)\.png/i.test((i.getAttribute('src') || '') + ' ' + (i.currentSrc || ''))).length,
                clutterVisible: [...document.querySelectorAll('.folio-corner,.folio-edge-flourish,.card-flourish,.foot-corner,.well-corner,.plate-corner,.phase-corner,.board-flourish')].filter(e => e.checkVisibility()).length,
                folioFoot: getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim(),
                bookmark: rect('.desk-still > .bookmark'),
                manorMapFrame: rect('#s2 .manor-map-frame'),
                folioInnerPadding: (() => {
                  const inner = document.querySelector('#rightCol > .folio-inner');
                  if (!inner || !inner.checkVisibility()) return null;
                  const cs = getComputedStyle(inner);
                  return [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight), parseFloat(cs.paddingBottom)];
                })(),
                folioStackPseudos: (() => {
                  const f = document.querySelector('#rightCol');
                  if (!f || !f.checkVisibility()) return null;
                  return [getComputedStyle(f, '::before').content, getComputedStyle(f, '::after').content];
                })(),
                folioTitle: rect('.file-heading h2'),
                firstRibbon: rect('.case-overview h3'),
                lineup: rect('.case-lineup h3'),
                notes: rect('.case-notes h3'),
                archivePhoto: rect('.manor-photo'),
                strip,
                toolbarWrap: tbWrap,
                toolbarScrollWidth: tbEl.scrollWidth,
                toolbarClientWidth: Math.round(tbEl.clientWidth),
                toolbarOverflowPx: Math.max(0, tbEl.scrollWidth - Math.round(tbEl.clientWidth)),
                tbButtons,
                map: [ml, mt, mr - ml, mb - mt],
                quad,
                pxPerMeter: (quad[1][0] - quad[0][0]) / worldW * 45 / 3.8,
                ticks,
                minFont: fontSizes.reduce((m, r) => r.px < m.px ? r : m, { text: '', px: 999 }),
                dimOpacities: [...new Set(dimOpacities)],
              };
            }""",
            world_w,
        )

        # Core shell & Phase 5 declutter invariants (D-024 §5.1)
        assert geom["overflow"] == 0, geom["overflow"]
        assert geom["bar"][3] == 60 and geom["stage"][0] == 0
        assert geom["minFont"]["px"] >= 12.0 - 0.01, geom["minFont"]
        assert all(abs(op - 1.0) < 1e-6 for op in geom["dimOpacities"]), geom["dimOpacities"]
        assert geom["deskImgs"] == 0 and geom["photoPins"] == 0 and geom["leakedPropImgs"] == 0, geom
        assert geom["clutterVisible"] == 0 and geom["folioFoot"] == "0px" and geom["archivePhoto"] is None, geom
        assert geom["manorMapFrame"] and geom["manorMapFrame"][2] > 0 and geom["manorMapFrame"][3] > 0
        assert bool(geom["bookmark"]) == opened
        if opened:
            assert _rect_overlap(_xywh_to_ltrb(geom["bookmark"]), _xywh_to_ltrb(geom["board"])) == 0
            assert _rect_overlap(_xywh_to_ltrb(geom["bookmark"]), _xywh_to_ltrb(geom["folio"])) == 0
            assert _rect_overlap(_xywh_to_ltrb(geom["bookmark"]), _xywh_to_ltrb(geom["map"])) == 0
            assert geom["folioInnerPadding"] and min(geom["folioInnerPadding"]) >= 16.0, geom["folioInnerPadding"]
            assert geom["folioStackPseudos"] == ["none", "none"], geom["folioStackPseudos"]

        margin = 10 if width < 1440 else 12 if width < 1600 else 16
        bx, by, bw, bh = geom["board"]
        assert bx == pytest.approx(margin + (width * 0.05 if opened else 0), abs=0.2)
        assert bw == pytest.approx(width - 2 * margin - (width * 0.37 + 10 if opened else 0), abs=0.2)
        assert bh == pytest.approx(height - 120, abs=0.2)
        if opened:
            assert geom["folio"][2] == pytest.approx(width * 0.32, abs=0.2)
        else:
            assert geom["folio"] is None and bw >= width * 0.98

        # Compact toolbar budget & zero clipped controls
        assert geom["toolbarOverflowPx"] == 0, geom
        assert all(not b["clipped"] and b["fontSize"] >= 12 for b in geom["tbButtons"]), geom["tbButtons"]
        assert _rect_overlap(_xywh_to_ltrb(geom["strip"]), _xywh_to_ltrb(geom["toolbarWrap"])) == 0
        budget = TOOLBAR_NET_BUDGET_OPEN[width] if opened else TOOLBAR_NET_BUDGET_CLOSED[width]
        assert geom["toolbarWrap"][2] <= budget + 0.5, (width, state, geom["toolbarWrap"][2], budget)

        # Metric scale calibration
        assert [t["meters"] for t in geom["ticks"]] == [0, 10, 20, 40], geom["ticks"]
        for t1, t2 in zip(geom["ticks"], geom["ticks"][1:]):
            expected_dx = (t2["meters"] - t1["meters"]) * geom["pxPerMeter"]
            assert abs((t2["cssX"] - t1["cssX"]) - expected_dx) <= 2.0, (t1, t2, geom["pxPerMeter"])

        # Chinatown footprint ratios, area retention, and D-008 luminance
        mx, my, mw, mh = geom["map"]
        # Complete map boundary sits inside board (1px rounding tolerance)
        for qx, qy in geom["quad"]:
            assert bx - 1.0 <= qx <= bx + bw + 1.0 and by - 1.0 <= qy <= by + bh + 1.0, (qx, qy, geom["board"])
        if opened:
            width_ratio = mw / bw
            area_ratio = (mw * mh) / ATTEMPT2_CHINATOWN_AREA[width]
            left_gutter = mx - bx
            assert width_ratio >= 0.70, (width, width_ratio)
            assert area_ratio >= 0.95, (width, area_ratio)
            assert left_gutter <= 18.0, (width, left_gutter)  # zero dead left black gutter
            assert geom["dock"] is not None, f"expected right legend rail docked at {width}x{height} open"
            assert _rect_overlap(_xywh_to_ltrb(geom["dock"]), _xywh_to_ltrb(geom["map"])) == 0
            assert geom["compass"][2] == 64

            # D-008 luminance on real rendered Chinatown footprint
            crop_box = (max(0, math.ceil(mx)), max(60, math.ceil(my)), min(width, math.floor(mx + mw)), min(height, math.floor(my + mh)))
            lum = np.asarray(live_img.crop(crop_box)) @ [0.2126, 0.7152, 0.0722]
            median_y = float(np.median(lum))
            p95_y = float(np.percentile(lum, 95))
            assert median_y >= 100.0 and p95_y >= 190.0, (width, median_y, p95_y)
            geom["widthRatio"] = round(width_ratio, 4)
            geom["areaOverAttempt2"] = round(area_ratio, 4)
            geom["luminance"] = {"medianY": round(median_y, 2), "p95Y": round(p95_y, 2)}

            # Verify compact menu keyboard accessibility on narrow desktop boards (1366 / 1440)
            if width <= 1440:
                tools_btn = page.locator("[data-test=btn-compact-tools]")
                assert tools_btn.is_visible()
                tools_btn.focus()
                tools_btn.press("Enter")
                assert page.locator("[data-test=compact-tools-menu]").is_visible()
                page.keyboard.press("ArrowDown")
                page.keyboard.press("Escape")
                assert not page.locator("[data-test=compact-tools-menu]").is_visible()
                assert tools_btn.evaluate("e => e === document.activeElement")

                more_btn = page.locator("[data-test=btn-compact-more]")
                assert more_btn.is_visible()
                more_btn.focus()
                more_btn.press("Enter")
                assert page.locator("[data-test=compact-more-menu]").is_visible()
                page.click("[data-test=btn-tac-archive]")
                assert page.locator("[data-test=archive-popover]").is_visible()
                page.keyboard.press("Escape")
                assert not page.locator("[data-test=archive-popover]").is_visible()

            # Check 1440 outer anchors strictly against T-018 02.json (main frames <= 8px, scale <= 4px)
            # and interior folio headings under D-025 §2 clean-folio spacing rules
            if width == 1440:
                anchor_diffs = {}
                for k in ("board", "folio", "transport", "scale", "cleanMap"):
                    actual = geom["map"] if k == "cleanMap" else geom[k]
                    expected = target_02["anchors"][k]["new"]
                    diffs = [round(a - b, 2) for a, b in zip(actual, expected)]
                    tol = 4.0 if k == "scale" else 8.0
                    assert max(abs(d) for d in diffs) <= tol, (k, expected, actual, diffs)
                    anchor_diffs[k] = {"expected": expected, "actual": [round(v, 2) for v in actual], "diff": diffs}
                fx, fy, fw, fh = geom["folio"]
                prev_bottom = fy
                for k in ("folioTitle", "firstRibbon", "lineup", "notes"):
                    actual = geom[k]
                    assert actual is not None, k
                    assert actual[0] >= fx + 16.0 - 0.5 and actual[0] + actual[2] <= fx + fw - 16.0 + 0.5, (k, actual, geom["folio"])
                    assert actual[1] >= prev_bottom - 0.5 and actual[1] + actual[3] <= fy + fh + 0.5, (k, actual, prev_bottom, geom["folio"])
                    if k != "folioTitle":
                        assert abs(actual[2] - 286.0) <= 8.0 and abs(actual[3] - 31.0) <= 4.0, (k, actual)
                    prev_bottom = actual[1] + actual[3]
                    expected = target_02["anchors"][k]["new"]
                    anchor_diffs[k] = {"rule": "D-025:folio-spacing-02", "expected": expected, "actual": [round(v, 2) for v in actual]}
                geom["t018AnchorCheck"] = anchor_diffs
                assert geom["clip"][1] >= geom["stage"][1], geom["clip"]

        summary["states"][state] = geom

    _save_json(shots / f"layout-geometry-{width}.json", summary)


@pytest.mark.e2e
@pytest.mark.browser
def test_02_crowded_frames_matrix_real_draw_ops(sandbox_browser_session, cached_payloads):
    page = sandbox_browser_session["page"]
    base = sandbox_browser_session["base"]
    shots = sandbox_browser_session["shots"]
    frames_data = json.loads(T019_FRAMES_JSON.read_text(encoding="utf-8"))
    assert len(frames_data) >= 10

    matrix_results: List[Dict[str, Any]] = []

    for f_entry in frames_data:
        mid = f_entry["id"]
        t_sec = float(f_entry["t"])
        map_name = f_entry["map"]
        expected_players = f_entry["players"]

        # Chinatown 120s runs all 6 viewport×folio combinations; other 9 frozen frames run 1366/1440/1920 open + 1440 closed
        if mid == CHINATOWN_MATCH and abs(t_sec - 120.0) < 0.1:
            combos = [(w, h, st) for w, h in SIZES for st in ("open", "closed")]
        else:
            combos = [(1366, 768, "open"), (1440, 900, "open"), (1440, 900, "closed"), (1920, 1080, "open")]

        for width, height, state in combos:
            _open_match_paused(page, base, mid, t_sec, width, height)
            _ensure_folio(page, state == "open")
            _reset_view_via_popover(page)

            frame1 = extract_canvas_draw_frame(page)
            assert frame1["frameSeq"] > 0 and frame1["opCount"] > 20
            report1 = analyze_nameplate_frame(frame1, expected_players)

            assert report1["eligibleCount"] == 5 and report1["drawnCount"] == 5, (map_name, t_sec, width, state, report1)
            assert report1["matchedCount"] == 5 and report1["degradedCount"] == 0, (map_name, t_sec, width, state, report1)
            assert report1["maxPlatePlateOverlap"] == 0.0, (map_name, t_sec, width, state, report1)
            assert report1["maxInkInkOverlap"] == 0.0, (map_name, t_sec, width, state, report1)
            assert report1["maxInkOtherPlateOverlap"] == 0.0, (map_name, t_sec, width, state, report1)
            assert report1["maxPlateTokenOverlap"] == 0.0, (map_name, t_sec, width, state, report1)
            assert report1["maxPlateHostOverlap"] == 0.0, (map_name, t_sec, width, state, report1["hostHits"])
            assert report1["maxPlateForegroundOverlap"] == 0.0, (map_name, t_sec, width, state, report1)
            assert not report1["clipped"], (map_name, t_sec, width, state, report1["clipped"])
            assert report1["minFontPx"] >= 12.0, (map_name, t_sec, width, state, report1["minFontPx"])

            # Verify determinism & zero token drift on seek-away & return for Chinatown 120s + all 10 frames at 1440 open
            if (mid == CHINATOWN_MATCH and abs(t_sec - 120.0) < 0.1 and state == "open") or (width == 1440 and state == "open"):
                page.locator("[data-test=scrubber]").fill(f"{t_sec + 5.0:g}")
                _settle_sandbox(page)
                page.locator("[data-test=scrubber]").fill(f"{t_sec:g}")
                _settle_sandbox(page)
                frame2 = extract_canvas_draw_frame(page)
                report2 = analyze_nameplate_frame(frame2, expected_players)
                assert report2["matchedCount"] == 5 and report2["degradedCount"] == 0
                max_drift = 0.0
                max_tok_drift = 0.0
                for r1, r2 in zip(report1["perUid"], report2["perUid"]):
                    assert r1["uid"] == r2["uid"] and r1["drawnText"] == r2["drawnText"]
                    for a, b in zip(r1["plateLocal"], r2["plateLocal"]):
                        max_drift = max(max_drift, abs(a - b))
                    if r1["tokenCenterLocal"] and r2["tokenCenterLocal"]:
                        max_tok_drift = max(
                            max_tok_drift,
                            math.hypot(
                                r1["tokenCenterLocal"][0] - r2["tokenCenterLocal"][0],
                                r1["tokenCenterLocal"][1] - r2["tokenCenterLocal"][1],
                            ),
                        )
                assert max_drift <= 0.01, (map_name, t_sec, width, max_drift)
                assert max_tok_drift <= 0.01, (map_name, t_sec, width, max_tok_drift)
                report1["repeatMaxDriftPx"] = round(max_drift, 5)
                report1["repeatMaxTokenDriftPx"] = round(max_tok_drift, 5)

            # Save 1:1 crop of the formerly overlapping Chinatown 120s cluster at 1440 open
            if mid == CHINATOWN_MATCH and abs(t_sec - 120.0) < 0.1 and width == 1440 and state == "open":
                img = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
                cluster_uids = {1000006, 1000008, 1000010}
                boxes = [r["plateViewport"] for r in report1["perUid"] if r["uid"] in cluster_uids]
                x0 = max(0, int(min(b[0] for b in boxes)) - 48)
                y0 = max(0, int(min(b[1] for b in boxes)) - 48)
                x1 = min(img.width, int(max(b[2] for b in boxes)) + 48)
                y1 = min(img.height, int(max(b[3] for b in boxes)) + 48)
                img.crop((x0, y0, x1, y1)).save(shots / "crowded-chinatown-120-crop.png")

            matrix_results.append({
                "matchId": mid,
                "map": map_name,
                "t": t_sec,
                "viewport": [width, height],
                "folio": state,
                **report1,
            })

    assert len(matrix_results) == 6 + 9 * 4  # 42 live Edge crowded-frame evaluations!
    _save_json(shots / "crowded-matrix.json", {"totalEvaluations": len(matrix_results), "results": matrix_results})


@pytest.mark.e2e
@pytest.mark.browser
def test_03_3d_roaming_floors_zoom_pan_legend_and_selection(sandbox_browser_session, cached_payloads):
    page = sandbox_browser_session["page"]
    base = sandbox_browser_session["base"]
    shots = sandbox_browser_session["shots"]
    frames_data = json.loads(T019_FRAMES_JSON.read_text(encoding="utf-8"))
    ct120_players = next(f["players"] for f in frames_data if f["id"] == CHINATOWN_MATCH and abs(f["t"] - 120) < 0.1)
    world = cached_payloads[CHINATOWN_MATCH]["replay"]["world"]["map_underlay"]["world_rect"]
    world_w = world["max_x"] - world["min_x"]

    _open_match_paused(page, base, CHINATOWN_MATCH, 120.0, 1440, 900)
    _ensure_folio(page, True)
    _reset_view_via_popover(page)

    # 1. 2D <-> 3D switch + PIL third-person 3D roaming + return to 2D draw-ops check
    assert page.locator("[data-test=btn-25d]").count() == 0, "Legacy 2.5D toggle must be removed"
    page.click("[data-test=btn-3d]")
    page.wait_for_function(
        "() => Boolean(window.__idv3dState && window.__idv3dState.ready === true && window.__idv3dState.sceneId === 'h55_chinatown')",
        timeout=30000,
    )
    page.wait_for_timeout(600)
    s3d = page.evaluate("() => window.__idv3dState")
    assert s3d["playerCount"] == 5 and s3d["navTriangles"] > 0 and s3d["error"] is None, s3d
    page.screenshot(path=str(shots / "1440-02-3d.png"))

    # Third-person 3D roaming (WASD movement + floor-clamped distance telemetry)
    page.click("[data-test=btn-3d-roam]")
    page.wait_for_function(
        "() => Boolean(window.__idv3dState && window.__idv3dState.cameraMode === 'roaming')",
        timeout=10000,
    )
    page.keyboard.down("KeyW")
    try:
        page.wait_for_function(
            "() => Boolean(window.__idv3dState && window.__idv3dState.distanceM > 0.2 && window.__idv3dState.elapsedS >= 0.08)",
            timeout=10000,
        )
    finally:
        page.keyboard.up("KeyW")
    page.wait_for_timeout(150)
    sroam = page.evaluate("() => window.__idv3dState")
    assert sroam["distanceM"] > 0.2 and sroam["elapsedS"] >= 0.08, sroam
    page.screenshot(path=str(shots / "1440-02-3d-roam.png"))

    # Return to 2D via keyboard shortcut '2' and confirm zero-overlap 2D nameplates
    page.keyboard.press("2")
    page.locator("[data-test=board-canvas]").wait_for(state="visible", timeout=10000)
    _settle_sandbox(page)
    f2d = extract_canvas_draw_frame(page)
    r2d = analyze_nameplate_frame(f2d, ct120_players)
    assert r2d["matchedCount"] == 5 and r2d["degradedCount"] == 0
    assert r2d["maxPlatePlateOverlap"] == 0.0 and r2d["maxInkInkOverlap"] == 0.0 and r2d["maxPlateHostOverlap"] == 0.0

    # 2. Floor filter (2F / B1 / 1F / ALL): hidden floors must draw 0 labels for off-floor players
    page.click("[data-floor='B1']")
    _settle_sandbox(page)
    fb1 = extract_canvas_draw_frame(page)
    assert len(fb1["plates"]) == 0, f"no Chinatown player is on B1 at 120s, got {fb1['plates']}"
    page.click("[data-floor='1F']")
    _settle_sandbox(page)
    f1f = extract_canvas_draw_frame(page)
    r1f = analyze_nameplate_frame(f1f, ct120_players)
    assert r1f["matchedCount"] == 5 and r1f["maxPlatePlateOverlap"] == 0.0 and r1f["maxPlateHostOverlap"] == 0.0
    page.click("[data-floor='ALL']")
    _settle_sandbox(page)

    # 3. Selection via DossierPanel cameo + real draw-ops priority check
    page.locator(".roster-grid button.cameo-card").first.click()
    _settle_sandbox(page)
    sel_uid = page.evaluate("idvAppStore.selectedUid")
    assert sel_uid is not None
    assert "PID #" in page.locator("[data-test=inspector]").inner_text()
    fsel = extract_canvas_draw_frame(page)
    rsel = analyze_nameplate_frame(fsel, ct120_players, selected_uid=sel_uid)
    assert rsel["matchedCount"] == 5 and rsel["maxPlatePlateOverlap"] == 0.0 and rsel["maxPlateHostOverlap"] == 0.0

    # 3b. Play-to-pause transition: play briefly then pause and confirm clean non-overlapping nameplates
    t_before_play = float(page.evaluate("idvAppStore.t"))
    page.click("[data-test=btn-play]")
    page.wait_for_function("t0 => idvAppStore.playing && idvAppStore.t > t0 + 0.15", arg=t_before_play, timeout=5000)
    page.click("[data-test=btn-play]")
    _settle_sandbox(page)
    assert not page.evaluate("idvAppStore.playing")
    fplay = extract_canvas_draw_frame(page)
    rplay = analyze_nameplate_frame(fplay, ct120_players, selected_uid=sel_uid)
    assert rplay["matchedCount"] == 5 and rplay["degradedCount"] == 0
    assert rplay["maxPlatePlateOverlap"] == 0.0 and rplay["maxInkInkOverlap"] == 0.0
    assert rplay["maxPlateTokenOverlap"] == 0.0 and rplay["maxPlateHostOverlap"] == 0.0
    # Restore 120.0s before zoom/pan checks
    page.locator("[data-test=scrubber]").fill("120")
    _settle_sandbox(page)

    # 4. Zoom -320 & -640 across 1366/1440/1920 open & closed
    for width, height in SIZES:
        page.set_viewport_size({"width": width, "height": height})
        for opened in (True, False):
            _ensure_folio(page, opened)
            for delta in (-320, -640):
                _reset_view_via_popover(page)
                cbox = page.locator("[data-test=board-canvas]").bounding_box()
                page.mouse.move(cbox["x"] + cbox["width"] / 2, cbox["y"] + cbox["height"] / 2)
                page.mouse.wheel(0, delta)
                _settle_sandbox(page)
                # Verify calibrated metric scale & 0 nameplate collisions among visible plates
                scale_ok = page.evaluate(
                    """worldW => {
                      const c = document.querySelector('[data-test=board-canvas]'), r = c.getBoundingClientRect();
                      const q = idvFootprints.get(c).map(p => ({ x: r.x + p.x * r.width / c.width, y: r.y + p.y * r.height / c.height }));
                      const ppm = (q[1].x - q[0].x) / worldW * 45 / 3.8;
                      const ticks = [...document.querySelectorAll('.scale text')].map(t => ({
                        m: parseFloat(t.textContent),
                        x: new DOMPoint(t.x.baseVal[0].value, 0).matrixTransform(t.getScreenCTM()).x,
                      }));
                      const errs = ticks.slice(1).map((t, i) => Math.abs((t.x - ticks[i].x) - (t.m - ticks[i].m) * ppm));
                      return { count: ticks.length, maxErr: Math.max(0, ...errs) };
                    }""",
                    world_w,
                )
                assert scale_ok["count"] >= 2 and scale_ok["maxErr"] <= 2.0, (width, opened, delta, scale_ok)
                fz = extract_canvas_draw_frame(page)
                # On zoom, check pairwise zero overlap across all drawn visible plates
                rz = analyze_nameplate_frame(fz, [], check_host_obstacles=True)
                assert rz["maxPlatePlateOverlap"] == 0.0 and rz["maxInkInkOverlap"] == 0.0 and rz["maxInkOtherPlateOverlap"] == 0.0
                assert rz["maxPlateHostOverlap"] == 0.0, (width, opened, delta, rz["hostHits"])
                assert not rz["clipped"], (width, opened, delta, rz["clipped"])

    # 5. Pan +325px at 1366x768 open paused 120s: 1/7 机 + bottom keyboard legend + 0 overlap
    page.set_viewport_size({"width": 1366, "height": 768})
    _ensure_folio(page, True)
    _reset_view_via_popover(page)
    assert page.locator(".map-key.right").is_visible()
    cbox = page.locator("[data-test=board-canvas]").bounding_box()
    cx, cy = cbox["x"] + cbox["width"] / 2, cbox["y"] + cbox["height"] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 325, cy, steps=10)
    page.mouse.up()
    _settle_sandbox(page)
    assert page.locator(".map-badges span").inner_text().strip() == "1/7 机"
    assert not page.locator(".map-key").is_visible()
    leg_btn = page.get_by_role("button", name="图例", exact=True)
    assert leg_btn.is_visible() and leg_btn.get_attribute("aria-expanded") == "false"
    for key in ("Enter", "Space"):
        leg_btn.press(key)
        assert leg_btn.get_attribute("aria-expanded") == "true"
        assert page.locator("#sandbox-legend span").count() == 5
        page.keyboard.press("Escape")
        assert leg_btn.get_attribute("aria-expanded") == "false"
        assert leg_btn.evaluate("e => e === document.activeElement")
    fpan = extract_canvas_draw_frame(page)
    rpan = analyze_nameplate_frame(fpan, [], check_host_obstacles=True)
    assert rpan["drawnCount"] >= 3 and rpan["maxPlatePlateOverlap"] == 0.0 and rpan["maxPlateHostOverlap"] == 0.0
    page.screenshot(path=str(shots / "pan-1366-325.png"))


@pytest.mark.e2e
@pytest.mark.browser
def test_04_director_three_modes_and_nameplates(sandbox_browser_session):
    page = sandbox_browser_session["page"]
    base = sandbox_browser_session["base"]

    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(base, wait_until="networkidle")
    page.evaluate(
        "for (const k of ['idv.pil.v2','idv.pil.v2.link','idv.flow.v1','idv.practice.v1']) localStorage.removeItem(k);"
    )
    page.reload(wait_until="networkidle")
    page.click("[data-test=flow-settings]")
    page.click("[data-test=flow-toggle-auto]")
    page.click("[data-test=flow-settings]")

    # Trigger running director via real drag-drop upload
    archive = build_replay_zip(CHINATOWN_MATCH)
    page.evaluate(
        """encoded => {
          const bytes = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], 'director.zip', {type:'application/zip'}));
          window.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, cancelable: true}));
          window.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, cancelable: true}));
        }""",
        base64.b64encode(archive).decode("ascii"),
    )
    page.wait_for_selector("[data-test=director-bar]", timeout=60000)

    def assert_director_clear(expected_mode: str) -> None:
        for width, height in SIZES:
            page.set_viewport_size({"width": width, "height": height})
            _settle_sandbox(page)
            actual_mode = page.evaluate("idvFlowStore.mode === 'pro-opening' ? idvFlowStore.segment.mode : idvFlowStore.director")
            assert actual_mode == expected_mode, (expected_mode, actual_mode)
            dom_hits = page.evaluate(
                """() => {
                  const d = document.querySelector('[data-test=director-bar]').getBoundingClientRect();
                  const others = document.querySelectorAll('.scale, .board .hud, #transport, #boardPanel button:not(.director button)');
                  return [...others].filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width && r.height && r.left < d.right && r.right > d.left && r.top < d.bottom && r.bottom > d.top;
                  }).map(el => el.className || el.id || el.dataset?.test);
                }"""
            )
            assert dom_hits == [], (expected_mode, width, dom_hits)
            fd = extract_canvas_draw_frame(page)
            rd = analyze_nameplate_frame(fd, [], check_host_obstacles=True)
            assert rd["maxPlatePlateOverlap"] == 0.0 and rd["maxPlateHostOverlap"] == 0.0, (expected_mode, width, rd["hostHits"])

    # Mode 1: running
    assert_director_clear("running")

    # Mode 2: suspended
    page.get_by_role("button", name="自由观看").click()
    assert_director_clear("suspended")

    # Mode 3: opening60 (blind practice -> reveal -> opening60)
    page.set_viewport_size({"width": 1440, "height": 900})
    page.click("#steps button[data-step='1']")
    page.locator(f".mapcard[data-match='{CHINATOWN_MATCH}'] [data-test=entry-practice]").click()
    page.wait_for_function("idvFlowStore.truthReady")
    page.locator(".zone-picker summary").click()
    for z in range(5):
        page.click(f"[data-zone-idx='{z}']")
    page.locator(".zone-picker summary").click()
    page.click("#s4 [data-test=flow-next]")
    page.locator(".ded-marker:not([disabled])").first.click()
    page.click("#s5 [data-test=flow-next]")
    page.click("[data-test=practice-lock]")
    page.click("[data-test=practice-opening]")
    page.wait_for_selector("[data-test=director-bar][data-mode=opening60]")
    assert_director_clear("opening60")


@pytest.mark.e2e
@pytest.mark.browser
def test_05_dossier_folio_cameos_tabs_corners_contrast_and_edge_states(sandbox_browser_session):
    page = sandbox_browser_session["page"]
    base = sandbox_browser_session["base"]
    shots = sandbox_browser_session["shots"]

    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear(); localStorage.setItem('idv.flow.v1', JSON.stringify({autoFlow:false}));")
    _open_match_paused(page, base, CHINATOWN_MATCH, 120.0, 1440, 900)
    _ensure_folio(page, True)
    _reset_view_via_popover(page)

    # 1. Public match serial, Phase 5 declutter (0 .manor-photo & 0 leaked desk props), 5 distinct cameos (1 hunter + 4 survivors)
    serial = page.locator("[data-test=folio-serial]")
    assert serial.inner_text().strip() == "№ 00F507"
    assert CHINATOWN_MATCH in (serial.get_attribute("title") or "")
    declutter_02 = page.evaluate(
        """() => {
          const overlap = (a, b) => (!a || !b) ? 0 : Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          const rangeBox = el => { if (!el) return null; const r = new Range(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
          const laurel = document.querySelector('#rightCol .file-heading .heading-laurel, #rightCol .file-heading .folio-laurel');
          const lr = laurel?.getBoundingClientRect();
          const clip = document.querySelector('#rightCol > .binder-clip')?.getBoundingClientRect();
          return {
            manorPhoto: document.querySelectorAll('.manor-photo').length,
            deskImgs: document.querySelectorAll('.desk-still > img').length,
            photoPins: document.querySelectorAll('.photo-pin').length,
            leakedPropImgs: [...document.querySelectorAll('img')].filter(i => /desk-(fountain-pen|pocket-watch|vintage-postcard)\\.png/i.test((i.getAttribute('src') || '') + ' ' + (i.currentSrc || ''))).length,
            clutter: document.querySelectorAll('#rightCol .folio-corner, #rightCol .folio-edge-flourish, #rightCol .card-flourish').length,
            folioFoot: getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim(),
            hasHeadingLaurel: Boolean(laurel && lr && lr.width > 0 && getComputedStyle(laurel).pointerEvents === 'none'),
            headingLaurelOverlap: +(overlap(lr, clip) + overlap(lr, rangeBox(document.querySelector('#rightCol .file-heading h2'))) + overlap(lr, rangeBox(document.querySelector('#rightCol .file-heading [data-test=folio-serial]')))).toFixed(3),
            replaySelectAppearances: [...document.querySelectorAll('#s2 select.sel')].filter(s => s.checkVisibility()).map(s => getComputedStyle(s).appearance),
          };
        }"""
    )
    assert declutter_02 == {
        "manorPhoto": 0,
        "deskImgs": 0,
        "photoPins": 0,
        "leakedPropImgs": 0,
        "clutter": 0,
        "folioFoot": "0px",
        "hasHeadingLaurel": True,
        "headingLaurelOverlap": 0,
        "replaySelectAppearances": ["none"],
    }, declutter_02

    cameos = page.evaluate(
        """() => Array.from(document.querySelectorAll('#dossier svg.cameo')).map(svg => ({
          kind: svg.getAttribute('data-cameo'),
          path: svg.querySelector('path')?.getAttribute('d') || '',
        }))"""
    )
    assert [c["kind"] for c in cameos] == ["hunter", "surv-1", "surv-2", "surv-3", "surv-4"], cameos
    assert len({c["path"] for c in cameos}) == 5, "hunter and 4 survivor cameos must all be distinct SVG silhouettes"

    # 2. Scroll .folio-inner and verify 0 corner clutter, clean padding >= 16px, and brass clip stays FIXED (0px drift)
    before_scroll = page.evaluate(
        """() => {
          const inner = document.querySelector('#rightCol .folio-inner');
          const cs = getComputedStyle(inner);
          const col = document.querySelector('#rightCol');
          return {
            corners: document.querySelectorAll('#rightCol .folio-corner, #rightCol .folio-edge-flourish, #rightCol .card-flourish').length,
            pseudos: [getComputedStyle(col, '::before').content, getComputedStyle(col, '::after').content],
            padding: [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight), parseFloat(cs.paddingBottom)],
            clip: (() => { const r = document.querySelector('#rightCol > .binder-clip').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })(),
            maxScroll: inner.scrollHeight - inner.clientHeight,
          };
        }"""
    )
    assert before_scroll["corners"] == 0 and before_scroll["pseudos"] == ["none", "none"], before_scroll
    assert min(before_scroll["padding"]) >= 16.0 and before_scroll["maxScroll"] > 50, before_scroll
    page.evaluate("document.querySelector('#rightCol .folio-inner').scrollTop = 260")
    _settle_sandbox(page)
    after_scroll = page.evaluate(
        """() => ({
          scrollTop: document.querySelector('#rightCol .folio-inner').scrollTop,
          corners: document.querySelectorAll('#rightCol .folio-corner, #rightCol .folio-edge-flourish, #rightCol .card-flourish').length,
          clip: (() => { const r = document.querySelector('#rightCol > .binder-clip').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })(),
        })"""
    )
    assert after_scroll["scrollTop"] > 100
    assert after_scroll["corners"] == 0
    assert after_scroll["clip"] == before_scroll["clip"]
    page.evaluate("document.querySelector('#rightCol .folio-inner').scrollTop = 0")
    _settle_sandbox(page)

    # 3. All 3 right tabs switch cleanly
    for tab in ("events", "tools", "status"):
        page.click(f"[data-right-tab='{tab}']")
        _settle_sandbox(page)
        assert "on" in (page.locator(f"[data-right-tab='{tab}']").get_attribute("class") or "").split()

    # 4. Rendered HTML/SVG WCAG contrast across 1366 / 1440 / 1920 open + real Canvas nameplate contrast at 1440
    contrast_report: Dict[str, Any] = {}
    for width, height in SIZES:
        page.set_viewport_size({"width": width, "height": height})
        _ensure_folio(page, True)
        _reset_view_via_popover(page)
        samples = contrast_mod.measure(page)
        min_row = samples[0]
        assert min_row["minimum"] >= 4.5, (width, samples[:5])
        contrast_report[str(width)] = {"sampleCount": len(samples), "minimum": min_row["minimum"], "worst": samples[:3]}

    page.set_viewport_size({"width": 1440, "height": 900})
    _reset_view_via_popover(page)
    f1440 = extract_canvas_draw_frame(page)
    canvas_contrast = measure_canvas_label_contrast(page, f1440)
    assert len(canvas_contrast) == 5
    assert all(row["minimumContrast"] >= 4.5 and row["changedPixels"] > 20 for row in canvas_contrast), canvas_contrast
    contrast_report["canvasNameplates1440"] = canvas_contrast
    _save_json(shots / "contrast-report.json", contrast_report)

    # 5. Neutral cameo fallback + long name wrapping + standalone no-replay empty state
    page.evaluate(
        """() => {
          const p = idvAppStore.replay.players;
          p[1].player_name = '超长中文昵称测试用于验证折行可读性不溢出边界';
          p[2].pid = -1;
          p[2].player_name = '';
        }"""
    )
    _settle_sandbox(page)
    edge_check = page.evaluate(
        """() => {
          const inner = document.querySelector('#rightCol .folio-inner');
          const neutral = document.querySelectorAll('#dossier svg.cameo[data-cameo="neutral"]').length;
          return {
            innerOverflowX: inner.scrollWidth - inner.clientWidth,
            docOverflowX: document.documentElement.scrollWidth - innerWidth,
            neutralCount: neutral,
          };
        }"""
    )
    assert edge_check["neutralCount"] >= 1, edge_check
    assert edge_check["innerOverflowX"] <= 1 and edge_check["docOverflowX"] == 0, edge_check

    # Standalone whiteboard empty state readable
    page.locator("#transport .mode-pills button", has_text="白板").click()
    _settle_sandbox(page)
    assert "地图资料" in page.locator("#dossier").inner_text()
    assert page.locator("[data-test=folio-serial]").inner_text().startswith("№ ATLAS-")
    # Restore live replay mode so subsequent tests start cleanly
    page.locator("#transport .mode-pills button", has_text="实况").click()
    _settle_sandbox(page)


@pytest.mark.e2e
@pytest.mark.browser
def test_06_png_export_base_overlay_and_reserved_rects_parity(sandbox_browser_session, tmp_path):
    page = sandbox_browser_session["page"]
    base = sandbox_browser_session["base"]
    shots = sandbox_browser_session["shots"]
    frames_data = json.loads(T019_FRAMES_JSON.read_text(encoding="utf-8"))
    ct120_players = next(f["players"] for f in frames_data if f["id"] == CHINATOWN_MATCH and abs(f["t"] - 120) < 0.1)

    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear(); localStorage.setItem('idv.flow.v1', JSON.stringify({autoFlow:false}));")
    _open_match_paused(page, base, CHINATOWN_MATCH, 120.0, 1440, 900)
    _ensure_folio(page, True)
    _reset_view_via_popover(page)

    # Place a tactical Seer token onto the overlay layer using the compact toolbar menu!
    page.click("[data-test=btn-compact-tools]")
    page.click("[data-tool='place']")
    page.click("[data-test=place-camp-survivor]")
    page.click("[data-test=role-btn-seer]")
    cbox = page.locator("[data-test=board-canvas]").bounding_box()
    page.mouse.click(cbox["x"] + cbox["width"] * 0.45, cbox["y"] + cbox["height"] * 0.45)
    _settle_sandbox(page)
    assert page.locator("[data-test=placed-list] [data-placed-token]").count() >= 1

    # Return to status tab & capture pre-export base draw ops
    page.click("[data-right-tab='status']")
    _settle_sandbox(page)
    before_frame = extract_canvas_draw_frame(page)
    before_report = analyze_nameplate_frame(before_frame, ct120_players)
    assert before_report["matchedCount"] == 5 and before_report["maxPlatePlateOverlap"] == 0.0 and before_report["maxPlateHostOverlap"] == 0.0

    # Trigger PNG export through real compact "更多 ▾" -> "导出PNG" click
    page.click("[data-test=btn-compact-more]")
    with page.expect_download(timeout=15000) as dl:
        page.click("[data-test=btn-tac-export]")
    export_path = shots / "exported-board.png"
    dl.value.save_as(str(export_path))
    raw_bytes = export_path.read_bytes()
    assert raw_bytes.startswith(PNG_SIG) and len(raw_bytes) > 10000

    # Verify exported PNG pixels match canvas dimensions and contain rich non-blank map + overlay colors
    exp_img = Image.open(io.BytesIO(raw_bytes)).convert("RGBA")
    arr = np.asarray(exp_img)
    assert (exp_img.width, exp_img.height) == (before_frame["canvasW"], before_frame["canvasH"])
    assert int((arr[:, :, 3] == 255).sum()) > arr.shape[0] * arr.shape[1] * 0.9
    distinct_colors = len(np.unique(arr[::4, ::4, :3].reshape(-1, 3), axis=0))
    assert distinct_colors > 200, distinct_colors

    # Verify export redraw preserved identical non-overlapping nameplates using same reservedRects
    after_frame = extract_canvas_draw_frame(page)
    after_report = analyze_nameplate_frame(after_frame, ct120_players)
    assert after_frame["frameSeq"] > before_frame["frameSeq"]
    assert after_report["matchedCount"] == 5 and after_report["degradedCount"] == 0
    assert after_report["maxPlatePlateOverlap"] == 0.0 and after_report["maxInkInkOverlap"] == 0.0 and after_report["maxPlateHostOverlap"] == 0.0
    max_export_drift = max(
        abs(a - b)
        for r1, r2 in zip(before_report["perUid"], after_report["perUid"])
        for a, b in zip(r1["plateLocal"], r2["plateLocal"])
    )
    assert max_export_drift <= 0.01, max_export_drift

    # Clean up whiteboard token so subsequent tests start clean
    page.click("[data-test=btn-compact-more]")
    page.click("[data-test=btn-tac-clear]")
    page.click("[data-test=btn-compact-tools]")
    page.click("[data-tool='inspect']")

    _save_json(
        shots / "export-report.json",
        {
            "fileSizeBytes": len(raw_bytes),
            "dimensions": [exp_img.width, exp_img.height],
            "distinctSampledColors": distinct_colors,
            "beforeFrameSeq": before_frame["frameSeq"],
            "afterFrameSeq": after_frame["frameSeq"],
            "maxExportPlateDriftPx": round(max_export_drift, 5),
            "afterReport": after_report,
        },
    )


@pytest.mark.e2e
@pytest.mark.browser
def test_07_zero_runtime_errors(sandbox_browser_session):
    errors = sandbox_browser_session["errors"]
    assert errors["console"] == [], errors["console"]
    assert errors["page"] == [], errors["page"]
    assert errors["http"] == [], errors["http"]
    assert errors["failed"] == [], errors["failed"]
    assert errors["external"] == [], errors["external"]
