"""Integrated production Edge audit (D-016 / D-017 / D-020 / D-021 / D-022 / D-023).

All output follows the shared ``screenshot_dir`` fixture (``IDV_E2E_SCREENSHOT_DIR`` when set).
"""
import base64
import csv
import importlib.util
import io
import json
import math
import os
import re
import subprocess
from functools import partial
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from conftest import CHINATOWN_MATCH, REPO_ROOT, VERIFIED_MATCH_IDS
from test_d016_sandbox import (
    DRAW_OPS_INIT_SCRIPT,
    analyze_nameplate_frame,
    extract_canvas_draw_frame,
    measure_canvas_label_contrast,
)
from test_fullstack_e2e import (
    _sandbox_fit,
    _sandbox_geometry,
    _sandbox_zoom,
    browser_session,
)

RESULTS = REPO_ROOT / "Workflow/results"
TARGETS = RESULTS / "T-018-art/targets"
ATTEMPT2_DIR = RESULTS / "T-017-art/attempt-2"
T019_FRAMES_JSON = RESULTS / "T-019-art/frames.json"
CONCEPTS_DIR = Path(os.environ.get("IDV_CONCEPT_DIR", r"i:\geminiiii\ui-concepts"))
CONCEPT_FILES = {
    1: "stage01-archive.png",
    2: "chinatown-tactical-dossier.png",
    3: "stage03-analytics.png",
    4: "stage04-region.png",
    5: "stage05-deduce.png",
}
SIZES = [(1366, 768), (1440, 900), (1920, 1080)]
MATCHES = {2: CHINATOWN_MATCH, 3: CHINATOWN_MATCH, 4: VERIFIED_MATCH_IDS[3], 5: VERIFIED_MATCH_IDS[6]}
FAMILIES = ["Noto Serif SC", "Cinzel", "Cormorant Garamond", "LXGW WenKai Screen"]


def helper(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


detail = helper("detail", RESULTS / "T-016-art/d014.py")
_raw_detail_dense = detail.dense


def _synced_detail_dense(page, base, evidence, strict=True):
    """D-023 §3 (Option 3A): ensure bare page.goto(base) inside read-only d014.dense awaits networkidle."""
    had_own = "goto" in getattr(page, "__dict__", {})
    orig_goto = page.goto

    def _goto_networkidle(url, *args, **kwargs):
        kwargs.setdefault("wait_until", "networkidle")
        return orig_goto(url, *args, **kwargs)

    page.goto = _goto_networkidle
    try:
        return _raw_detail_dense(page, base, evidence, strict=strict)
    finally:
        if had_own:
            page.goto = orig_goto
        else:
            delattr(page, "goto")


detail.dense = _synced_detail_dense
repair = helper("repair", RESULTS / "T-016-art/repair_checks.py")
contrast = helper("contrast", RESULTS / "T-017-art/contrast.py")


# Real-pixel Canvas probe for Stage 04 (region-canvas) clean map capture & WCAG ink contrast.
REGION_INK_PROBE = r"""(() => {
  if (globalThis.__idvVisualRegionInstalled) return;
  globalThis.__idvVisualRegionInstalled = true;
  const proto = CanvasRenderingContext2D.prototype;
  const origClear = proto.clearRect;
  const origDraw = proto.drawImage;
  const origFill = proto.fillText;
  const origGetData = proto.getImageData;
  const urlCache = new WeakMap();
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  window.__idvVisualRegion = {
    clean: null,
    roofOverlays: 0,
    canvasFilter: 'none',
    canvasInk: [],
  };

  proto.clearRect = function (...args) {
    if (this.canvas?.dataset?.test === 'region-canvas') {
      window.__idvVisualRegion.roofOverlays = 0;
      window.__idvVisualRegion.canvasInk = [];
      globalThis.idvCanvasText?.delete(this.canvas);
    }
    return origClear.apply(this, args);
  };

  proto.drawImage = function (img, ...args) {
    if (this.canvas?.dataset?.test === 'region-canvas') {
      if (args.length === 8 && this.globalCompositeOperation === 'color') {
        window.__idvVisualRegion.roofOverlays++;
      }
      const nw = img?.naturalWidth || img?.width || 0;
      const nh = img?.naturalHeight || img?.height || 0;
      if (nw >= 300 && nh >= 300 && args.length === 4) {
        window.__idvVisualRegion.canvasFilter = this.filter || 'none';
        let dataUrl = null;
        if (img instanceof HTMLCanvasElement) {
          dataUrl = urlCache.get(img);
          if (!dataUrl) {
            dataUrl = img.toDataURL('image/png');
            urlCache.set(img, dataUrl);
          }
        }
        window.__idvVisualRegion.clean = {
          kind: img.constructor.name,
          filter: this.filter || 'none',
          alpha: this.globalAlpha,
          width: nw,
          height: nh,
          dataUrl,
        };
      }
    }
    return origDraw.apply(this, [img, ...args]);
  };

  proto.fillText = function (value, x, y, ...rest) {
    const label = String(value ?? '');
    const isRegion = this.canvas?.dataset?.test === 'region-canvas' && this.canvas.isConnected && label.trim();
    if (!isRegion || !sctx) return origFill.apply(this, [value, x, y, ...rest]);

    const m = this.getTransform();
    const fontPx = Number(this.font.match(/([.\d]+)px/)?.[1] || 12);
    const scaleY = Math.hypot(m.c, m.d) || 1;
    const scaleX = Math.hypot(m.a, m.b) || 1;
    const metrics = this.measureText(label);
    const textW = Math.ceil((metrics.width || label.length * fontPx) + 8);
    const textH = Math.ceil(fontPx * 1.8 + 6);
    const p = m.transformPoint({ x, y });
    const pxW = Math.max(4, Math.ceil(textW * scaleX));
    const pxH = Math.max(4, Math.ceil(textH * scaleY));
    const align = this.textAlign || 'left';
    const ox = align === 'center' ? Math.floor(p.x - pxW / 2)
      : align === 'right' ? Math.floor(p.x - pxW) : Math.floor(p.x - 4 * scaleX);
    const oy = Math.floor(p.y - pxH / 2);
    const bx = Math.max(0, ox);
    const by = Math.max(0, oy);
    const bw = Math.min(this.canvas.width - bx, ox + pxW - bx);
    const bh = Math.min(this.canvas.height - by, oy + pxH - by);

    let before = null;
    if (bw > 0 && bh > 0) {
      try { before = origGetData.call(this, bx, by, bw, bh); } catch { before = null; }
    }
    const ret = origFill.apply(this, [value, x, y, ...rest]);
    if (before && bw > 0 && bh > 0) {
      try {
        const after = origGetData.call(this, bx, by, bw, bh);
        scratch.width = bw;
        scratch.height = bh;
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, bw, bh);
        sctx.fillStyle = '#000000';
        sctx.fillRect(0, 0, bw, bh);
        sctx.setTransform(m.a, m.b, m.c, m.d, m.e - bx, m.f - by);
        sctx.font = this.font;
        sctx.textAlign = this.textAlign;
        sctx.textBaseline = this.textBaseline;
        sctx.fillStyle = '#ffffff';
        origFill.apply(sctx, [value, x, y, ...rest]);
        const mask = origGetData.call(sctx, 0, 0, bw, bh).data;
        const lum = (r, g, b) => {
          const lin = v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        };
        let minRatio = Infinity, corePixels = 0, worstFg = null, worstBg = null;
        for (let i = 0; i < mask.length; i += 4) {
          if (mask[i] >= 240) {
            corePixels++;
            const lf = lum(after.data[i], after.data[i + 1], after.data[i + 2]);
            const lb = lum(before.data[i], before.data[i + 1], before.data[i + 2]);
            const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
            if (ratio < minRatio) {
              minRatio = ratio;
              worstFg = [after.data[i], after.data[i + 1], after.data[i + 2]];
              worstBg = [before.data[i], before.data[i + 1], before.data[i + 2]];
            }
          }
        }
        if (corePixels > 0) {
          window.__idvVisualRegion.canvasInk.push({
            label,
            corePixels,
            minimum: Number(minRatio.toFixed(4)),
            fg: worstFg,
            bg: worstBg,
            cssFontPx: fontPx * scaleY * (this.canvas.getBoundingClientRect().height / this.canvas.height),
          });
        }
      } catch {
        // Ignore security-tainted canvas readbacks.
      }
    }
    return ret;
  };
})();"""


# Inline D-016 / D-021 desk-props geometry probe (adapts read-only T-013R2 geometry.js without editing it).
DESK_BREAKPOINT_JS = r"""({step, open}) => {
  const rect = e => {
    const {x, y, width, height} = e.getBoundingClientRect();
    return [x, y, x + width, y + height];
  };
  const intersection = (a, b) => [
    Math.max(a[0], b[0]), Math.max(a[1], b[1]),
    Math.min(a[2], b[2]), Math.min(a[3], b[3]),
  ];
  const area = r => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const viewport = [0, 0, innerWidth, innerHeight];
  function bounds(e) {
    let visible = viewport;
    for (let p = e.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p), box = rect(p);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = [
        box[0] + p.clientLeft, box[1] + p.clientTop,
        box[0] + p.clientLeft + p.clientWidth, box[1] + p.clientTop + p.clientHeight,
      ];
      visible = intersection(visible, clip);
    }
    const box = rect(e), shown = intersection(box, visible);
    return {box, shown, clipped: Math.max(0, +(area(box) - area(shown)).toFixed(3))};
  }
  const get = s => document.querySelector(s);
  const layer = get('.desk-still'), toggle = get('.step.show .folio-toggle');
  const required = [
    ...(open ? ['.bookmark'] : []),
    '.step.show .compass', '.step.show .scale', '.step.show .folio-toggle',
    ...(step === 2
      ? ['.map-badges', '.map-badges span', '.map-key,button[aria-controls=sandbox-legend]', '#transport']
      : ['.step.show .pil-action-bar', '.step.show .pil-legend']),
    ...(open ? [step === 2 ? '#rightCol button' : '.step.show .pil-right :is(button,summary,select)'] : []),
  ];
  const controls = [];
  function add(e, selector) {
    const b = bounds(e);
    if (!e.checkVisibility() || !area(b.shown) || getComputedStyle(e).visibility === 'hidden') return;
    controls.push({
      selector,
      label: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 38),
      box: b.shown,
    });
  }
  for (const s of required) {
    const count = controls.length;
    document.querySelectorAll(s).forEach(e => add(e, s));
    if (count === controls.length) throw Error('missing visible ' + s);
  }
  const extraSel = [
    '.step.show [data-cipher-row]',
    '#rightCol :is(input,select,summary,button)',
    '.step.show .pil-right :is(input,select,summary,button)',
    '.board .hud', '#toolbar', '#strip',
    '.step.show .pil-action-bar :is(button,summary)',
    '.legend-strip', '.pil-zone-chips', '.director',
    '.step.show .pil-aspect-frame', '.step.show .ded-marker',
    '.step.show .zone-picker[open]', '.view-pop', '.archive-pop', '.pil-popover',
  ].join(',');
  document.querySelectorAll(extraSel).forEach(e =>
    add(e, e.dataset?.test || e.id || (typeof e.className === 'string' ? e.className : '') || e.tagName)
  );
  const props = [...layer.querySelectorAll(':scope > img')].map(e => {
    const b = bounds(e);
    return {
      name: e.className,
      tag: e.tagName,
      ...b,
      display: getComputedStyle(e).display,
      visible: Boolean(e.checkVisibility() && area(b.box) > 0),
      asset: [e.naturalWidth, e.naturalHeight],
    };
  });
  const visibleProps = props.filter(p => p.visible);
  const overlaps = [];
  for (const [i, p] of visibleProps.entries()) {
    for (const t of [...controls, ...visibleProps.slice(i + 1)]) {
      const ov = area(intersection(p.box, t.box));
      if (ov > 0) overlaps.push([p.name, t.name || t.selector, +ov.toFixed(3)]);
    }
  }
  let mapFootprint = null;
  if (step === 2) {
    const c = get('[data-test=board-canvas]');
    if (c && globalThis.idvFootprints?.get(c)) {
      const cr = c.getBoundingClientRect();
      const pts = globalThis.idvFootprints.get(c).map(pt => [cr.x + pt.x * cr.width / c.width, cr.y + pt.y * cr.height / c.height]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      mapFootprint = [
        Math.max(cr.left, Math.min(...xs)), Math.max(cr.top, Math.min(...ys)),
        Math.min(cr.right, Math.max(...xs)), Math.min(cr.bottom, Math.max(...ys)),
      ];
    }
  } else if (step === 4) {
    const c = get('[data-test=region-canvas]');
    if (c && globalThis.idvFootprints?.get(c)) {
      const cr = c.getBoundingClientRect();
      const pts = globalThis.idvFootprints.get(c).map(pt => [cr.x + pt.x * cr.width / c.width, cr.y + pt.y * cr.height / c.height]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      mapFootprint = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
  } else if (step === 5) {
    const im = get('.ded-map-img');
    if (im) mapFootprint = rect(im);
  }
  const mapHits = [];
  if (mapFootprint) {
    for (const p of visibleProps) {
      const ov = area(intersection(p.box, mapFootprint));
      if (ov > 0) mapHits.push([p.name, +ov.toFixed(3)]);
    }
  }
  const tb = toggle.getBoundingClientRect();
  const hitEl = document.elementFromPoint(tb.x + tb.width / 2, tb.y + tb.height / 2);
  const bm = get('.desk-still > .bookmark');
  const pin = get('.photo-pin');
  const stageEl = get('#stage');
  const boardRect = rect(get(step === 2 ? '.board' : '.step.show .pil-board-wrap'));
  const folioEl = get(step === 2 ? '#rightCol' : '.step.show .folio-stack');
  const folioRect = folioEl && folioEl.checkVisibility() ? rect(folioEl) : null;
  const bmRect = bm && bm.checkVisibility() ? rect(bm) : null;
  const bookmarkOverlaps = [];
  if (bmRect && area(bmRect) > 0) {
    for (const [k, r] of [['board', boardRect], ['folio', folioRect], ['map', mapFootprint]]) {
      if (r) {
        const ov = area(intersection(bmRect, r));
        if (ov > 0) bookmarkOverlaps.push([k, +ov.toFixed(3)]);
      }
    }
  }
  const manorFrame = get('.step.show .manor-map-frame');
  const manorFrameRect = manorFrame && manorFrame.checkVisibility() ? rect(manorFrame) : null;
  return {
    board: boardRect,
    stage: rect(stageEl),
    overflow: document.documentElement.scrollWidth - innerWidth,
    props,
    leakedPropImgs: [...document.querySelectorAll('img')].filter(i =>
      /desk-(fountain-pen|pocket-watch|vintage-postcard)\.png/i.test((i.getAttribute('src') || '') + ' ' + (i.currentSrc || ''))
    ).length,
    clutterVisible: [...document.querySelectorAll('.folio-corner,.folio-edge-flourish,.card-flourish,.foot-corner,.well-corner,.plate-corner,.phase-corner,.board-flourish')]
      .filter(e => e.checkVisibility()).length,
    folioFoot: getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim(),
    controlsCount: controls.length,
    overlaps,
    mapFootprint,
    mapHits,
    toggleHit: Boolean(hitEl && (hitEl === toggle || toggle.contains(hitEl))),
    bookmarkVisible: Boolean(bmRect && area(bmRect) > 0),
    bookmarkOverlaps,
    manorMapFrameVisible: Boolean(manorFrameRect && area(manorFrameRect) > 0),
    pinCount: document.querySelectorAll('.photo-pin').length,
    pinVisible: Boolean(pin && pin.checkVisibility() && area(rect(pin)) > 0),
    stageAttrs: {
      propRetreat: stageEl?.getAttribute('data-prop-retreat'),
      mapZoomed: stageEl?.getAttribute('data-map-zoomed'),
    },
    nonInteractive: [layer, ...layer.querySelectorAll('*')].every(
      e => getComputedStyle(e).pointerEvents === 'none' && !(e.tabIndex >= 0 || e.hasAttribute('tabindex'))
    ),
    expanded: toggle.getAttribute('aria-expanded'),
    bar: rect(get('#bar')),
  };
}"""


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf8")


def _rect_overlap_ltrb(a, b):
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def _decode_data_url_png(url):
    _, payload = url.split(",", 1)
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


def _polygon_samples(img, poly):
    mask = Image.new("1", img.size, 0)
    ImageDraw.Draw(mask).polygon(poly, fill=1)
    return np.asarray(img.convert("RGB"))[np.asarray(mask)]


def _rec709_stats(arr):
    rgb = arr.astype(np.float64)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    spread = np.ptp(arr, axis=-1)
    return {
        "medianY": round(float(np.median(lum)), 3),
        "p95Y": round(float(np.percentile(lum, 95)), 3),
        "medianSpread": round(float(np.median(spread)), 3),
        "medianRGB": [round(float(np.median(arr[..., c])), 2) for c in range(3)],
        "pixels": int(lum.size),
    }


def _check_05_image_styles(page):
    """D-016 / T-023 single-pass 05 image style check (replaces deleted .ded-map-patina helper)."""
    result = page.locator("#s5 .ded-map-img").evaluate("""img => {
      const filtered = [];
      for (let n = img; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.opacity !== '1' || s.filter !== 'none') {
          filtered.push([n.tagName, n.className, s.opacity, s.filter]);
        }
      }
      return {
        filtered,
        rotation: img.dataset.rotQuadrants,
        opacity: getComputedStyle(img).opacity,
        filter: getComputedStyle(img).filter,
        patinaCount: document.querySelectorAll('.ded-map-patina,.ded-hospital-roof').length,
      };
    }""")
    assert not result["filtered"] and result["opacity"] == "1" and result["filter"] == "none", result
    assert result["patinaCount"] == 0, result
    return result


def _check_pil_header(page):
    """D-016 / T-023 04/05 folio header check using .folio-stage (replaces deleted .folio-laurel)."""
    result = page.locator(".step.show .pil-case-title").evaluate("""el => {
      const rect = e => e.getBoundingClientRect();
      const stageOval = rect(el.querySelector('.folio-stage'));
      const clip = rect(el.closest('.folio-stack').querySelector('.binder-clip'));
      const bounds = rect(el);
      const overlaps = (a, b) =>
        Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const rows = [];
      for (const node of el.querySelectorAll('small,h2,em')) {
        const range = new Range();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          rows.push({
            tag: node.tagName,
            rect: r.toJSON(),
            clip: overlaps(r, clip),
            stageOval: overlaps(r, stageOval),
            inside: r.right <= bounds.right + 0.5 && r.bottom <= bounds.bottom + 0.5 && r.left >= bounds.left - 0.5,
          });
        }
      }
      return {
        text: el.querySelector('em').innerText,
        rows,
        stageOval: stageOval.toJSON(),
        clip: clip.toJSON(),
      };
    }""")
    assert all(r["inside"] and not r["stageOval"] and not r["clip"] for r in result["rows"]), result
    return result


def _ornament_contrast(page):
    """Rendered WCAG contrast for non-interactive/ornamental text (brand V, wax seals, compass, scale, ribbons)."""
    selector = ".identity i,.wax-seal text,.compass text,.scale text,.ribbon-h,.ribbon-h small,.contrib-seal"
    rows = page.evaluate(
        """sel => {
          const out = [];
          for (const e of document.querySelectorAll(sel)) {
            if (!e.checkVisibility()) continue;
            const c = getComputedStyle(e);
            for (const n of e.childNodes) {
              if (n.nodeType !== 3 || !n.textContent.trim()) continue;
              const range = new Range();
              range.selectNodeContents(n);
              const r = range.getBoundingClientRect();
              let [x, y, right, bottom] = [r.left, r.top, r.right, r.bottom];
              for (let p = e.parentElement; p; p = p.parentElement) {
                const b = p.getBoundingClientRect(), cs = getComputedStyle(p);
                if (cs.overflowY !== 'visible') { y = Math.max(y, b.top); bottom = Math.min(bottom, b.bottom); }
                if (cs.overflowX !== 'visible') { x = Math.max(x, b.left); right = Math.min(right, b.right); }
              }
              if (right <= x || bottom <= y) continue;
              const raw = e instanceof SVGElement ? c.fill : c.color;
              const color = (raw.match(/\\d+/g) || []).slice(0, 3).map(Number);
              if (color.length !== 3) continue;
              const kind = e.closest('.wax-seal') ? 'wax'
                : e.closest('.compass') ? 'compass'
                : e.closest('.scale') ? 'scale'
                : e.closest('.ribbon-h') ? 'ribbon'
                : e.classList.contains('contrib-seal') ? 'medallion'
                : 'brand';
              out.push({label: n.textContent.trim(), kind, color, rect: [x, y, right, bottom]});
            }
          }
          return out;
        }""",
        selector,
    )

    def probe(color):
        style = page.add_style_tag(
            content=f"{selector}{{fill:{color}!important;-webkit-text-fill-color:{color}!important}}"
        )
        try:
            return np.asarray(Image.open(io.BytesIO(page.screenshot())).convert("RGB"), dtype=np.int16)
        finally:
            style.evaluate("s => s.remove()")

    black, white, back = [probe(c) for c in ("black", "white", "transparent")]
    mask = (white - black).min(axis=2) >= 190
    result = []
    for row in rows:
        x, y, right, bottom = row.pop("rect")
        left, top = max(0, math.floor(x)), max(0, math.floor(y))
        r_px, b_px = math.ceil(right), math.ceil(bottom)
        glyph = mask[top:b_px, left:r_px]
        if not glyph.any():
            continue
        bg = back[top:b_px, left:r_px][glyph]
        lum = contrast.luminance(bg)
        fg = contrast.luminance(np.array(row["color"]))
        ratios = (np.maximum(lum, fg) + 0.05) / (np.minimum(lum, fg) + 0.05)
        j = int(ratios.argmin())
        yy, xx = np.where(glyph)
        result.append(
            dict(
                **row,
                minimum=round(float(ratios[j]), 4),
                xy=[int(left + xx[j]), int(top + yy[j])],
                backing=bg[j].tolist(),
            )
        )
    return sorted(result, key=lambda r: r["minimum"])


@pytest.fixture
def scene(browser_session, screenshot_dir):
    page = browser_session["page"]
    base = browser_session["base"]
    page.goto(base, wait_until="networkidle")
    settle(page)
    page.evaluate("""localStorage.clear(); sessionStorage.clear();
                  localStorage.setItem('idv.flow.v1.visualPreset','clarity')""")
    yield page, base, screenshot_dir
    errors = browser_session["errors"]
    woff2 = sorted({url.split("/")[-1] for url, status in errors["assets"] if ".woff2" in url and status == 200})
    prefixes = ["noto-serif-sc-", "cinzel-", "cormorant-garamond-", "lxgwwenkaiscreen-"]
    save(
        screenshot_dir / "browser-audit.json",
        dict(
            edge=browser_session["browser_version"],
            **{k: v for k, v in errors.items() if k != "assets"},
            woff2=woff2,
        ),
    )
    assert not any(errors[k] for k in ("console", "page", "external", "http", "failed")), errors
    assert all(any(name.startswith(prefix) for name in woff2) for prefix in prefixes), woff2


@pytest.fixture(scope="module", autouse=True)
def canvas_type_probe(browser_session):
    """Install real Canvas 2D draw-ops probe (reused from test_d016_sandbox) + Stage 04 pixel ink probe."""
    browser_session["page"].add_init_script(DRAW_OPS_INIT_SCRIPT)
    browser_session["page"].add_init_script(REGION_INK_PROBE)


def settle(page):
    page.wait_for_load_state("networkidle")
    fonts = page.evaluate("""async families => {
      const results = [];
      for (const family of families) {
        const faces = await document.fonts.load('16px "' + family + '"',
          family.includes('SC') || family.includes('WenKai') ? '庄园' : 'Manor');
        results.push(faces.map(face => face.status));
      }
      for (const [spec, sample] of [
        ['600 italic 16px "Cormorant Garamond"', 'Manor'],
        ['700 italic 18px "Cormorant Garamond"', 'Stage'],
        ['600 16px "Noto Serif SC"', '庄园'],
        ['900 22px "Noto Serif SC"', '档案库'],
      ]) {
        const extra = await document.fonts.load(spec, sample);
        results.push(extra.map(face => face.status));
      }
      await document.fonts.ready;
      await Promise.all([...document.images].filter(i => i.currentSrc && i.checkVisibility()).map(i => i.decode()));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return results;
    }""", FAMILIES)
    assert all(f and set(f) == {"loaded"} for f in fonts), fonts


def _wait_map_baked(page, step):
    if step == 4:
        page.wait_for_function("""() => {
          const p = window.__idvVisualRegion?.clean;
          return Boolean(p && p.kind === 'HTMLCanvasElement' && p.dataUrl && p.dataUrl.startsWith('data:'));
        }""")
    elif step == 5:
        page.wait_for_function("""() => {
          const im = document.querySelector('#s5 .ded-map-img');
          return Boolean(im && im.complete && im.naturalWidth > 0 && im.src.startsWith('data:'));
        }""")


def setup_page(page, base, step, shots, width):
    # D-022 §3: drain any pending in-flight requests from prior caller navigations (e.g., cold-cache .woff2)
    # before navigating away so strict requestfailed listeners never see avoidable ERR_ABORTED races.
    if page.url and page.url != "about:blank":
        page.wait_for_load_state("networkidle")
    page.goto(base + f"/?visual={step}-{width}#s=1&auto=0", wait_until="networkidle")
    page.locator(".mapcard").first.wait_for()
    actions = []
    if step == 1:
        return actions
    if step == 5:
        page.goto(f"{base}/?hospital#m={MATCHES[5]}&s=5&auto=0", wait_until="networkidle")
        page.locator(".ded-marker").first.wait_for()
        page.click("[data-test=deduce-reset]")
        for idx in [None, 4, 6, 10, 3, 5, 9]:
            button = (
                page.locator(".ded-marker:not([disabled])").first
                if idx is None
                else page.locator(f".ded-marker[data-cipher-idx='{idx}']")
            )
            if idx in (None, 4) or "unknown" in button.get_attribute("class"):
                for _ in range(2 if idx in (3, 5, 9) else 1):
                    actions.append(button.get_attribute("data-cipher-name"))
                    button.click()
        assert "7 / 7" in page.locator("[data-test=deduce-progress]").inner_text()
        actions.append(page.locator("[data-test=deduce-conclusion]").inner_text())
        actions.extend(page.locator("[data-step-idx]").all_inner_texts())
    elif step == 4:
        page.locator(f".mapcard[data-match='{MATCHES[4]}'] [data-test=entry-practice]").click()
        page.wait_for_function("idvFlowStore.truthReady")
        picker = page.locator(".zone-picker summary")
        picker.click()
        for idx in range(5):
            page.click(f"[data-zone-idx='{idx}']")
        picker.click()
        assert page.evaluate("idvFlowStore.reveal===null && idvAppStore.replay===null && idvAppStore.analytics===null")
        settle(page)
        page.screenshot(path=shots / f"{width}-04-blind.png")
        page.click("#s4 [data-test=flow-next]")
        page.locator(".ded-marker:not([disabled])").first.click()
        page.click("#s5 [data-test=flow-next]")
        page.click("[data-test=practice-lock]")
        page.locator("[data-test=practice-score]").wait_for(state="attached")
        actions.append(page.evaluate("JSON.parse(localStorage.getItem('idv.practice.v1')).at(-1)"))
    else:
        page.locator(f".mapcard[data-match='{CHINATOWN_MATCH}'] [data-test=entry-replay]").click()
        page.locator(".case-lineup").wait_for()
        if page.evaluate("idvAppStore.playing"):
            page.click("[data-test=btn-play]")
        page.locator("[data-test=scrubber]").fill("120")
        assert page.evaluate("idvAppStore.t===120 && !idvAppStore.playing")
        if step == 3:
            page.click("#steps [data-step='3']")
            page.locator(".contributor").first.wait_for()
    if step in (4, 5):
        page.locator(".pil-right").evaluate("e=>e.scrollTop=0")
        page.locator(".step.show .map-preset").select_option("clarity")
        page.wait_for_function(
            """step => step === 5
              ? Boolean(document.querySelector('#s5 .ded-map-img')?.complete && document.querySelector('#s5 .ded-map-img')?.src.startsWith('data:'))
              : Boolean(globalThis.idvFootprints?.has(document.querySelector('#s4 [data-test=region-canvas]')))""",
            arg=step,
        )
    page.mouse.move(1, 1)
    return actions


def boxes(page, step):
    sel = {"topbar": "#bar", **{f"topbar/{i}": f"#steps [data-step='{i}']" for i in range(1, 6)}}
    for key in ("backBtn", "identity", "archive-brand", "manor-vista", "gbtn fr cut"):
        sel["topbar/" + key] = (
            ".flow-settings > button"
            if key == "gbtn fr cut"
            else ("#" if key.endswith("Btn") else ".") + key
        )
    if step == 1:
        sel.update(board=".archive-board", folio="#dropZone", select=".pick")
        for i, key in enumerate(("全部地图 ▾", "全部模式 ▾", "全部结果 ▾", "搜索玩家 / 地图 / PID", "刷新")):
            sel["filter/" + key] = f"#filters > :nth-child({i+2})"
        for i in range(4):
            card = f".mapcard:nth-child({i+1})"
            sel.update({
                f"card{i}": card,
                f"photo{i}": card + " figure",
                f"cta{i}-0": card + " .cta-replay",
                f"cta{i}-1": card + " .cta-practice",
            })
    elif step == 2:
        sel.update(
            board=".board",
            folio="#rightCol",
            transport="#transport",
            compass="#s2 .compass",
            scale="#s2 .scale",
            folioTitle=".file-heading h2",
            firstRibbon=".case-overview h3",
            lineup=".case-lineup h3",
            notes=".case-notes h3",
        )
    elif step == 3:
        sel.update(
            folio="#analysis",
            kpis=".overview",
            kpiTitle=".overview h2",
            plot=".chart",
            contributions=".contributions",
            plotTitle=".chart h2",
            tableTitle=".contributions h2",
        )
        for i in range(3):
            sel[f"phase{i}"] = f".phase:nth-child({i+1})"
            sel[f"phaseTitle{i}"] = sel[f"phase{i}"] + " h3"
    else:
        sel.update(
            board=".step.show .pil-board-wrap",
            controlBar=".step.show .pil-topbar",
            folio=".step.show .folio-stack",
            folioTitle=".step.show .pil-case-title h2",
            firstRibbon=".step.show .pil-right .ribbon-h",
            compass=".step.show .compass",
            scale=".step.show .scale",
        )
    return page.evaluate(
        """ss=>Object.fromEntries(Object.entries(ss).map(([k,s])=>{
          const r=document.querySelector(s).getBoundingClientRect();return [k,[r.x,r.y,r.width,r.height]]
        }))""",
        sel,
    )


def _save_1to1_detail(step, shots, live, bounds):
    """Save a strict 1:1 native-pixel material/prop/text crop plate for each 1440 page."""
    def clamp_box(l, t, r, b):
        l = max(0, min(live.width - 1, int(round(l))))
        t = max(0, min(live.height - 1, int(round(t))))
        r = max(l + 1, min(live.width, int(round(r))))
        b = max(t + 1, min(live.height, int(round(b))))
        return (l, t, r, b)

    if step == 1:
        c0 = bounds["card0"]
        tiles = [
            live.crop(clamp_box(c0[0] - 4, c0[1] - 4, c0[0] + c0[2] + 4, c0[1] + c0[3] + 4)),
            live.crop(clamp_box(1280, 62, 1438, 220)),
            live.crop(clamp_box(1280, 818, 1438, 898)),
        ]
    elif step == 2:
        tiles = [
            live.crop(clamp_box(84, 560, 440, 845)),
            live.crop(clamp_box(820, 118, 956, 560)),
            live.crop(clamp_box(967, 62, 1428, 490)),
        ]
    elif step == 3:
        p0 = bounds["phase0"]
        contrib = bounds["contributions"]
        tiles = [
            live.crop(clamp_box(p0[0] - 4, p0[1] - 4, p0[0] + p0[2] + 4, p0[1] + p0[3] + 4)),
            live.crop(clamp_box(contrib[0] - 4, contrib[1] - 4, 1438, 898)),
        ]
    elif step == 4:
        tiles = [
            live.crop(clamp_box(345, 290, 505, 430)),
            live.crop(clamp_box(140, 640, 410, 860)),
            live.crop(clamp_box(967, 62, 1428, 430)),
        ]
    else:
        tiles = [
            live.crop(clamp_box(360, 320, 740, 690)),
            live.crop(clamp_box(84, 128, 220, 620)),
            live.crop(clamp_box(967, 62, 1428, 430)),
        ]
    pad = 8
    total_w = sum(im.width for im in tiles) + pad * (len(tiles) + 1)
    total_h = max(im.height for im in tiles) + pad * 2
    plate = Image.new("RGB", (total_w, total_h), "#161e2b")
    cx = pad
    for im in tiles:
        plate.paste(im, (cx, pad))
        cx += im.width + pad
    plate.save(shots / f"detail-{step:02}.png")


def _contains_xywh(outer, inner, tol=1.0):
    return (
        outer[0] - tol <= inner[0]
        and outer[1] - tol <= inner[1]
        and outer[0] + outer[2] + tol >= inner[0] + inner[2]
        and outer[1] + outer[3] + tol >= inner[1] + inner[3]
    )


def _check_d022_anchor(step, name, measured, expected, bounds, page):
    """Apply D-022 / D-023 interactive-shell rules, D-025 Phase 5 rules & D-026 Phase 6 topbar/folio rules."""
    x, y, w, h = measured
    ex, ey, ew, eh = expected
    dx, dy, dw, dh = x - ex, y - ey, w - ew, h - eh

    # D-026 §2.2 & §3.1: outer #bar stays strictly [0, 0, 1440, 60]; interior flex children shift slightly
    # from true-italic .archive-brand + sculpted dark-slate/brass right utility plaques (zero sibling overlap).
    if name.startswith("topbar/"):
        tb = bounds["topbar"]
        tb_order = [
            "topbar/backBtn",
            "topbar/identity",
            "topbar/archive-brand",
            "topbar/manor-vista",
            *(f"topbar/{i}" for i in range(1, 6)),
            "topbar/gbtn fr cut",
        ]
        ordered = [bounds[k] for k in tb_order if k in bounds]
        no_overlap = len(ordered) == 10 and all(
            ordered[i][0] + ordered[i][2] <= ordered[i + 1][0] + 0.5 for i in range(len(ordered) - 1)
        )
        inside_tb = _contains_xywh(tb, measured, tol=0.5)
        sub = name.split("/", 1)[1]
        if sub in ("backBtn", "identity"):
            ok = inside_tb and no_overlap and max(abs(dx), abs(dy), abs(dw), abs(dh)) <= 4.0
            return "D-016:small-4px", 4, ok
        if sub in ("archive-brand", "manor-vista"):
            ok = inside_tb and no_overlap and abs(dy) <= 1.0 and abs(dh) <= 1.0 and abs(dx) <= 16.0 and abs(dw) <= 56.0
            return "D-026:topbar-brand", "D-026", ok
        if sub in ("1", "2", "3", "4", "5"):
            ok = inside_tb and no_overlap and abs(dy) <= 0.5 and abs(dh) <= 0.5 and abs(dw) <= 22.0 and abs(dx) <= 120.0
            return "D-026:topbar-steps", "D-026", ok
        right_aligned = abs((bounds["topbar/gbtn fr cut"][0] + bounds["topbar/gbtn fr cut"][2]) - 1428.0) <= 0.5
        ok = (
            inside_tb
            and no_overlap
            and right_aligned
            and abs(dy) <= 3.0
            and abs(dh) <= 5.0
            and h >= 27.0
        )
        return "D-026:topbar-utility", "D-026", ok

    # D-025 §2: Stage 01 clean-folio interior spacing & vertical breathing room (+10px)
    if step == 1 and not name.startswith("topbar"):
        board = bounds.get("board")
        folio = bounds.get("folio")
        if name in ("board", "folio"):
            aligned = bool(
                board and folio
                and abs(board[1] - folio[1]) <= 8.0
                and abs((board[1] + board[3]) - (folio[1] + folio[3])) <= 8.0
            )
            ok = aligned and max(abs(dx), abs(dy), abs(dw)) <= 8.0 and abs(dh) <= 16.0
            return "D-025:folio-frame-01", "D-025", ok
        if name == "select":
            ok = bool(folio and _contains_xywh(folio, measured) and max(abs(dx), abs(dy), abs(dw), abs(dh)) <= 10.0)
            return "D-025:folio-cta-01", "D-025", ok
        ok = bool(board and _contains_xywh(board, measured) and max(abs(dx), abs(dy), abs(dw), abs(dh)) <= 12.0)
        return "D-025:board-child-01", "D-025", ok

    # D-025 §2: Stage 02 interior folio headings shifted by 18px 20px folio padding & removed .manor-photo
    if step == 2 and name in ("folioTitle", "firstRibbon", "lineup", "notes"):
        folio = bounds["folio"]
        in_x = (folio[0] + 16.0 - 0.5 <= x) and (x + w <= folio[0] + folio[2] - 16.0 + 0.5)
        in_y = (folio[1] <= y) and (y + h <= folio[1] + folio[3] + 0.5)
        ok = in_x and in_y
        if name != "folioTitle":
            ok = ok and abs(w - 286.0) <= 8.0 and abs(h - 31.0) <= 4.0
        order = ("folioTitle", "firstRibbon", "lineup", "notes")
        idx = order.index(name)
        if idx > 0 and order[idx - 1] in bounds:
            prev = bounds[order[idx - 1]]
            ok = ok and (y >= prev[1] + prev[3] - 0.5)
        return "D-025:folio-spacing-02", "D-025", ok

    # D-025 §2: Stage 03 interior plates shifted by 16px 20px folio padding & 14px gap (outer folio stays <=8px)
    if step == 3 and not name.startswith("topbar") and name != "folio":
        folio = bounds["folio"]
        in_x = (folio[0] + 16.0 - 0.5 <= x) and (x + w <= folio[0] + folio[2] - 16.0 + 0.5)
        ok = in_x and _contains_xywh(folio, measured) and max(abs(dx), abs(dy), abs(dw), abs(dh)) <= 18.0
        return "D-025:folio-spacing-03", "D-025", ok

    # D-025 §1: Stage 04 56px .region-submode-bar above .pil-main
    if step == 4 and name == "controlBar":
        ok = abs(dx) <= 1.0 and abs(dw) <= 1.0 and (54.0 <= dy <= 58.0) and abs(h - 38.0) <= 1.0
        return "D-025:submode-bar-04", "D-025", ok
    if step == 4 and name == "board":
        ok = abs(dx) <= 1.0 and abs(dw) <= 1.0 and (54.0 <= dy <= 58.0) and abs(dh + dy) <= 1.0
        return "D-025:submode-bar-04", "D-025", ok
    if step == 4 and name == "cleanMap":
        board = bounds["board"]
        in_board = _contains_xywh(board, measured, tol=1.0)
        width_ratio = w / board[2]
        ok = in_board and width_ratio >= 0.85 and (w * h) / (ew * eh) >= 0.83
        return "D-025:submode-bar-04", "D-025", ok

    if step in (2, 4, 5) and name == "compass":
        rule = "D-022:compass-64"
        ok = abs(w - 64.0) <= 0.5 and abs(h - 64.0) <= 0.5
        aux = page.evaluate("""step => {
          const host = document.querySelector('.step.show');
          const box = el => { if (!el || !el.checkVisibility()) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? [r.left, r.top, r.right, r.bottom] : null; };
          const comp = box(host.querySelector('.compass'));
          const othersSel = step === 2
            ? '.map-key,.scale,.hud,#toolbar,#strip,.rail-zoom-tools,.map-badges'
            : '.pil-action-bar,.scale,.ded-side-legend,.ded-marker,.ded-same-caption';
          const overlaps = [];
          const ov = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
          for (const el of host.querySelectorAll(othersSel)) {
            const b = box(el);
            if (b && comp && ov(comp, b) > 0) overlaps.push([el.className || el.id, ov(comp, b)]);
          }
          const sideLegend = box(host.querySelector('.ded-side-legend'));
          return {overlaps, sideLegendTop: sideLegend ? sideLegend[1] : null};
        }""", step)
        ok = ok and not aux["overlaps"]
        if step == 2:
            cx, cy = x + w / 2.0, y + h / 2.0
            ecx, ecy = ex + ew / 2.0, ey + eh / 2.0
            ok = ok and abs(cx - ecx) <= 4.0 and abs(cy - ecy) <= 4.0
        elif step == 4:
            # D-025 §1: compass tracks scaled cleanMap NE corner inside 56px-shifted board
            board = bounds["board"]
            cm = bounds.get("cleanMap")
            ok = ok and _contains_xywh(board, measured, tol=2.0) and (50.0 <= dy <= 62.0)
            if cm:
                ok = ok and abs((x + w) - (cm[0] + cm[2])) <= 24.0
            return "D-025:compass-04", "D-025", ok
        else:
            ok = ok and abs(dx) <= 4.0 and 135.0 <= y <= 161.0
            if aux["sideLegendTop"] is not None:
                ok = ok and (y + h) <= aux["sideLegendTop"]
        return rule, "D-022", ok

    if step in (4, 5) and name == "scale":
        rule = "D-025:scale-04" if step == 4 else "D-022/D-023:scale-above-action-bar"
        aux = page.evaluate("""step => {
          const host = document.querySelector('.step.show');
          const box = el => { if (!el || !el.checkVisibility()) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? [r.left, r.top, r.right, r.bottom] : null; };
          const sc = box(host.querySelector('.scale'));
          const ab = box(host.querySelector('.pil-action-bar'));
          const frame = host.querySelector('.pil-aspect-frame').getBoundingClientRect();
          const path = host.querySelector('.scale path');
          const span = path ? path.getTotalLength() : 0;
          const mapMeters = step === 4 ? 166.2 : 151.5;
          const expectedSpan = 40 * frame.width / mapMeters;
          const ov = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
          const hits = [];
          for (const el of host.querySelectorAll('.pil-action-bar,.compass,.ded-side-legend,.ded-same-caption,.ded-marker')) {
            const b = box(el);
            if (b && sc && ov(sc, b) > 0) hits.push([el.className || el.id, ov(sc, b)]);
          }
          return {
            actionBarTop: ab ? ab[1] : null,
            rulerErr: Math.abs(span - expectedSpan),
            hits,
          };
        }""", step)
        gap = (aux["actionBarTop"] - (y + h)) if aux["actionBarTop"] is not None else -1.0
        if step == 4:
            cm = bounds.get("cleanMap")
            ok = (
                bool(cm and abs(x - cm[0]) <= 14.0)
                and abs(h - 32.0) <= 2.0
                and aux["rulerErr"] <= 2.0
                and not aux["hits"]
                and 0.0 <= gap <= 14.0
            )
            return rule, "D-025", ok
        ok = (
            abs(dx) <= 4.0
            and abs(dw) <= 2.0
            and abs(h - 32.0) <= 2.0
            and aux["rulerErr"] <= 2.0
            and not aux["hits"]
            and 0.0 <= gap <= 14.0
        )
        if not ok:
            rule = f"{rule}[gap={gap:.3f},abTop={aux['actionBarTop']},scBot={y+h:.3f},rulerErr={aux['rulerErr']:.4f},hits={aux['hits']}]"
        return rule, "D-022/D-023", ok

    if step in (4, 5) and name in ("folioTitle", "firstRibbon"):
        rule = "D-025:pil-folio-rhythm"
        folio = bounds["folio"]
        in_x = (folio[0] + 16.0 - 0.5 <= x) and (x + w <= folio[0] + folio[2] - 16.0 + 0.5)
        ok = in_x and abs(dx) <= 26.0
        if name == "folioTitle":
            ok = ok and (folio[1] + 18.0 <= y <= 125.0)
            hdr = _check_pil_header(page)
            ok = ok and all(not r["stageOval"] and not r["clip"] for r in hdr["rows"])
        else:
            ft = bounds["folioTitle"]
            ok = ok and (140.0 <= w <= folio[2] - 32.0 + 1.0) and abs(dh) <= 6.0 and (ft[1] + ft[3] + 8.0 <= y <= 228.0)
        return rule, "D-025", ok

    return None, None, None


def compare(step, shots, live, bounds, page=None):
    key = f"{step:02}"
    meta = json.loads((TARGETS / (key + ".json")).read_text("utf8"))
    target = Image.open(TARGETS / (key + ".png")).convert("RGB")
    concept = Image.open(CONCEPTS_DIR / CONCEPT_FILES[step]).convert("RGB")
    old_adapt = Image.open(ATTEMPT2_DIR / f"1440-{key}.png").convert("RGB")

    # 4-column same-scale comparison (Approved Concept | Attempt-2 Old Adaptation | T-018 Frozen Target | Worker Edge)
    concept_panel = Image.new("RGB", (1440, 900), "#161e2b")
    c_thumb = concept.copy()
    c_thumb.thumbnail((1440, 900), Image.Resampling.LANCZOS)
    concept_panel.paste(c_thumb, ((1440 - c_thumb.width) // 2, (900 - c_thumb.height) // 2))
    sheet = Image.new("RGB", (5760, 900), "#161e2b")
    for idx, image in enumerate((concept_panel, old_adapt, target, live)):
        sheet.paste(image, (1440 * idx, (900 - image.height) // 2))
    sheet.save(shots / f"compare-{key}.jpg", quality=92)
    Image.blend(target, live, 0.5).save(shots / f"overlay-{key}.png")
    _save_1to1_detail(step, shots, live, bounds)

    rows = []
    for name, measured in bounds.items():
        if name not in meta["anchors"]:
            continue
        expected = meta["anchors"][name]["new"]
        diff = [round(a - b, 3) for a, b in zip(measured, expected)]
        d022_rule, d022_lim, d022_ok = (
            _check_d022_anchor(step, name, measured, expected, bounds, page)
            if page is not None
            else (None, None, None)
        )
        if d022_rule is not None:
            rule, limit, within = d022_rule, d022_lim, d022_ok
        elif step == 2 and name == "scale":
            rule = "D-016:scale-2px"
            limit = "4(w<=2)"
            within = abs(diff[2]) <= 2.0 and max(abs(diff[0]), abs(diff[1]), abs(diff[3])) <= 4.0
        else:
            small = (
                name in ("compass", "scale", "select", "desk-nib")
                or name.startswith(("topbar/", "cta", "filter/", "phaseTitle"))
            )
            limit = 4 if small else 8
            rule = "D-016:small-4px" if small else "D-016:primary-8px"
            within = max(map(abs, diff)) <= limit
        rows.append([name, expected, [round(v, 3) for v in measured], *diff, limit, rule, within])
    with (shots / f"anchors-{key}.csv").open("w", encoding="utf8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["anchor", "targetXYWH", "actualXYWH", "dx", "dy", "dw", "dh", "limit", "rule", "within"])
        writer.writerows(rows)
    return [f"{r[0]}({r[8]}):{r[3:7]}" for r in rows if not r[-1]]


def footprint(page, step, world_width):
    if step == 2:
        box = _sandbox_geometry(page, world_width)["map"]
        return [box[k] for k in ("x", "y", "width", "height")]
    if step == 5:
        box = page.locator(".ded-map-img").bounding_box()
        return [box[k] for k in ("x", "y", "width", "height")]
    return page.locator("[data-test=region-canvas]").evaluate("""c => {
      const r = c.getBoundingClientRect(), q = idvFootprints.get(c);
      const xs = q.map(p => r.x + p.x * r.width / c.width), ys = q.map(p => r.y + p.y * r.height / c.height);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    }""")


@pytest.mark.parametrize("step", range(1, 6))
@pytest.mark.parametrize("width,height", SIZES)
def test_integrated_screen(scene, step, width, height, cached_payloads):
    page, base, shots = scene
    page.set_viewport_size(dict(width=width, height=height))
    actions = setup_page(page, base, step, shots, width)
    if step in (4, 5):
        _wait_map_baked(page, step)
    settle(page)
    bounds = boxes(page, step)
    stem = f"{width}-{step:02}"
    live = Image.open(io.BytesIO(page.screenshot(path=shots / (stem + ".png")))).convert("RGB")
    m = dict(actions=actions, boxes=bounds, match=MATCHES.get(step), size=live.size)
    failures = []

    shell = page.evaluate(r"""() => {
      const text = [...document.querySelectorAll('#bar *, .step.show *')].filter(e => e.getClientRects().length &&
        [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.checkVisibility());
      const sizes = text.filter(e => e instanceof HTMLElement || e instanceof SVGTextElement).map(e => {
        const m = e.getScreenCTM?.();
        return parseFloat(getComputedStyle(e).fontSize) * (m ? Math.hypot(m.c, m.d) : 1);
      });
      const opacities = text.filter(e => {
        const s = getComputedStyle(e), rgb = s.color.match(/[0-9]+/g);
        return rgb && '#' + rgb.map(n => (+n).toString(16).padStart(2, '0')).join('') === s.getPropertyValue('--dim').trim().toLowerCase();
      }).map(e => {
        let op = 1;
        for (let n = e; n; n = n.parentElement) op *= +getComputedStyle(n).opacity;
        return op;
      });
      const tabs = [...document.querySelectorAll('#steps [data-step]')].map(e => e.getBoundingClientRect());
      const directImgs = [...document.querySelectorAll('.desk-still > img')].map(i => ({
        cls: i.className,
        w: i.naturalWidth,
        h: i.naturalHeight,
        display: getComputedStyle(i).display,
      }));
      const leakedPropImgs = [...document.querySelectorAll('img')].filter(i =>
        /desk-(fountain-pen|pocket-watch|vintage-postcard)\.png/i.test((i.getAttribute('src') || '') + ' ' + (i.currentSrc || ''))
      ).length;
      const clutterVisible = [...document.querySelectorAll('.folio-corner,.folio-edge-flourish,.card-flourish,.foot-corner,.well-corner,.plate-corner,.phase-corner,.board-flourish')]
        .filter(e => e.checkVisibility()).length;
      const bm = document.querySelector('.desk-still > .bookmark')?.getBoundingClientRect() ?? null;
      const manorFrame = document.querySelector('.step.show .manor-map-frame')?.getBoundingClientRect() ?? null;
      const submode = document.querySelector('#regionView > .region-submode-bar')?.getBoundingClientRect() ?? null;
      const pilMain = document.querySelector('#regionView > .pil-main')?.getBoundingClientRect() ?? null;
      const folioPadEl = document.querySelector('.step.show #rightCol > .folio-inner, .step.show .pil-right, .step.show #dropZone, .step.show #analysis');
      const folioPadding = folioPadEl ? (() => {
        const cs = getComputedStyle(folioPadEl);
        return [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight)];
      })() : [];
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        rail: document.querySelector('#stage').getBoundingClientRect().x,
        dpr: devicePixelRatio,
        zoom: visualViewport.scale,
        minFont: Math.min(...sizes),
        dim: [...new Set(opacities)],
        directImgs,
        photoPins: document.querySelectorAll('.photo-pin').length,
        leakedPropImgs,
        clutterVisible,
        folioFoot: getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim(),
        bookmarkBox: bm && bm.width > 0 && bm.height > 0 ? [bm.x, bm.y, bm.width, bm.height] : null,
        manorMapFrameBox: manorFrame && manorFrame.width > 0 && manorFrame.height > 0 ? [manorFrame.x, manorFrame.y, manorFrame.width, manorFrame.height] : null,
        submodeTotalH: (submode && pilMain && submode.height > 0) ? +(pilMain.top - submode.top).toFixed(3) : 0,
        folioPadding,
        oneRow: tabs.length === 5 && tabs.every((r, i) => r.y === tabs[0].y && r.right <= innerWidth && (!i || tabs[i - 1].right <= r.left)),
      };
    }""")
    m.update(shell)
    # D-024 §5.1 strict Phase 5 declutter & clean-folio gate across 01..05
    if (
        len(shell["directImgs"]) != 0
        or shell["photoPins"] != 0
        or shell["leakedPropImgs"] != 0
        or shell["clutterVisible"] != 0
        or shell["folioFoot"] != "0px"
        or not shell["bookmarkBox"]
        or not shell["folioPadding"]
        or min(shell["folioPadding"]) < 16.0
    ):
        failures.append("D-024 Phase 5 declutter / clean folio")
    if step in (2, 4, 5) and not shell["manorMapFrameBox"]:
        failures.append("missing ManorMapFrame")
    if shell["bookmarkBox"]:
        bm_ltrb = [shell["bookmarkBox"][0], shell["bookmarkBox"][1], shell["bookmarkBox"][0] + shell["bookmarkBox"][2], shell["bookmarkBox"][1] + shell["bookmarkBox"][3]]
        for bkey in ("board", "folio"):
            if bkey in bounds:
                br = bounds[bkey]
                if _rect_overlap_ltrb(bm_ltrb, [br[0], br[1], br[0] + br[2], br[1] + br[3]]) > 0:
                    failures.append(f"bookmark overlaps {bkey}")

    # Rendered HTML + SVG WCAG contrast (real composited backing)
    samples = contrast.measure(page)
    ornaments = _ornament_contrast(page)
    save(shots / ("contrast-" + stem + ".json"), {"htmlSvg": samples, "ornaments": ornaments})
    m["minimumContrast"] = min(row["minimum"] for row in samples)
    m["minimumOrnamentContrast"] = min(row["minimum"] for row in ornaments)
    if m["minimumContrast"] < 4.5 or m["minimumOrnamentContrast"] < 4.5:
        failures.append("WCAG text contrast")

    required_labels = {"V"}
    if step == 4:
        required_labels.update(("已选 4 / 4", "已选 1 / 1"))
    if step == 5 and width == 1920:
        required_labels.update(("候选密码机布局", "第3组"))
    assert required_labels <= {row["label"] for row in samples if row["minimum"] >= 4.5}

    # Hover WCAG contrast check on 04 camp toggle buttons at 1440
    if step == 4 and width == 1440:
        hover_mins = []
        for sel in ("[data-test=region-side-survivor]", "[data-test=region-side-hunter]"):
            page.locator(sel).hover()
            settle(page)
            hs = contrast.measure(page)
            hover_mins.append(min(r["minimum"] for r in hs))
        page.mouse.move(1, 1)
        m["campHoverMinContrast"] = min(hover_mins)
        if m["campHoverMinContrast"] < 4.5:
            failures.append("04 camp hover contrast")

    # Real Canvas WCAG contrast & draw-ops audit (NOT font-size-only!)
    if step == 2:
        frames_meta = json.loads(T019_FRAMES_JSON.read_text("utf8"))
        ct120_players = next(f["players"] for f in frames_meta if f["id"] == CHINATOWN_MATCH and abs(f["t"] - 120.0) < 0.1)
        draw_frame = extract_canvas_draw_frame(page)
        np_report = analyze_nameplate_frame(draw_frame, ct120_players)
        m["canvasNameplates"] = np_report
        if (
            np_report["eligibleCount"] != 5
            or np_report["matchedCount"] != 5
            or np_report["degradedCount"] != 0
            or np_report["minFontPx"] < 12.0 - 0.001
            or np_report["maxPlatePlateOverlap"] > 0.0
            or np_report["maxInkInkOverlap"] > 0.0
            or np_report["maxInkOtherPlateOverlap"] > 0.0
            or np_report["maxPlateTokenOverlap"] > 0.0
            or np_report["maxPlateHostOverlap"] > 0.0
            or np_report["maxPlateForegroundOverlap"] > 0.0
            or np_report["clipped"]
        ):
            failures.append("02 canvas draw-ops nameplates")
        if width == 1440:
            c_contrast = measure_canvas_label_contrast(page, draw_frame)
            m["canvasNameplateContrast"] = c_contrast
            if len(c_contrast) != 5 or any(r["minimumContrast"] < 4.5 for r in c_contrast):
                failures.append("02 canvas nameplate WCAG contrast")
    elif step == 4:
        c_ink = page.evaluate("window.__idvVisualRegion?.canvasInk || []")
        m["regionCanvasInk"] = c_ink
        if len(c_ink) < 9 or any(i["cssFontPx"] < 11.99 or i["minimum"] < 4.5 for i in c_ink):
            failures.append("04 canvas ink contrast/size")

    if step == 5:
        panel = page.locator(".pil-right")
        badge = page.locator("[data-layout-idx='2'] .ded-layout-badge.unique")
        assert panel.evaluate("e => e.scrollTop") == 0
        if width < 1920:
            badge.scroll_into_view_if_needed()
            settle(page)
        geometry = badge.evaluate("""e => {
            const box = r => [r.left, r.top, r.right, r.bottom];
            const range = new Range();
            range.selectNodeContents(e);
            const clips = [[0, 0, innerWidth, innerHeight]];
            for (let p = e.parentElement; p; p = p.parentElement) {
                const style = getComputedStyle(p);
                if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
                const b = p.getBoundingClientRect(), x = b.left + p.clientLeft, y = b.top + p.clientTop;
                clips.push([x, y, x + p.clientWidth, y + p.clientHeight]);
            }
            return {
                text: box(range.getBoundingClientRect()),
                badge: box(e.getBoundingClientRect()),
                button: box(e.parentElement.getBoundingClientRect()),
                clips,
            };
        }""")

        def contains(outer, inner):
            return outer[0] <= inner[0] + 0.5 and outer[1] <= inner[1] + 0.5 and outer[2] >= inner[2] - 0.5 and outer[3] >= inner[3] - 0.5

        assert contains(geometry["badge"], geometry["text"])
        assert all(contains(b, geometry["badge"]) for b in [geometry["button"], *geometry["clips"]])
        readable = samples if width == 1920 else contrast.measure(page)
        m["candidateContrast"] = [r for r in readable if r["label"] in ("第3组", "候选密码机布局")]
        assert {r["label"] for r in m["candidateContrast"] if r["minimum"] >= 4.5} == {"第3组", "候选密码机布局"}
        m["candidateGeometry"] = geometry
        panel.evaluate("e => e.scrollTop = 0")

    world = cached_payloads[CHINATOWN_MATCH]["replay"]["world"]["map_underlay"]["world_rect"]
    world_width = world["max_x"] - world["min_x"]

    if step in (2, 4, 5):
        target_meta = json.loads((TARGETS / f"{step:02}.json").read_text("utf8"))
        vp_spec = target_meta["viewports"][str(width)]
        x, y, w, h = footprint(page, step, world_width)
        bounds["cleanMap"] = [x, y, w, h]
        region = (max(0, math.ceil(x)), max(60, math.ceil(y)), min(width, math.floor(x + w)), min(height, math.floor(y + h)))
        final_stats = _rec709_stats(np.asarray(live.crop(region)))
        m.update(
            footprint=region,
            p50=final_stats["medianY"],
            p95=final_stats["p95Y"],
            finalPhotometry=final_stats,
            compass=repair.glyph_sizes(page, ".step.show .compass text"),
        )

        # D-016 / D-025 §1 desktop multi-column table verification
        margin = 10 if width < 1440 else 12 if width < 1600 else 16
        exp_desk = width * 0.05
        exp_folio_w = width * 0.32
        exp_board_x = margin + exp_desk
        exp_board_w = width - 2 * margin - exp_desk - 10.0 - exp_folio_w
        if step == 4:
            submode_h = shell["submodeTotalH"]
            if not (54.0 <= submode_h <= 58.0):
                failures.append(f"04 submode bar height out of [54,58]: {submode_h}")
            exp_board_h = height - 110 - submode_h
        else:
            exp_board_h = height - (120 if step == 2 else 110)
        bx, by, bw, bh = bounds["board"]
        fx, _, fw, _ = bounds["folio"]
        if (
            abs(bx - exp_board_x) > 0.25
            or abs(bw - exp_board_w) > 0.25
            or abs(fx - (bx + bw + 10.0)) > 0.25
            or abs(fw - exp_folio_w) > 0.25
            or abs(bh - exp_board_h) > 0.5
        ):
            failures.append(f"D-016 desktop geometry mismatch: board={bounds['board']} folio={bounds['folio']} exp_h={exp_board_h}")

        # Footprint width ratio & area retention (D-025 §1: 04 accounts for 56px submode bar; 02 & 05 stay >=0.95)
        prev_ltrb = vp_spec["previousFootprintLTRB"]
        prev_area = (prev_ltrb[2] - prev_ltrb[0]) * (prev_ltrb[3] - prev_ltrb[1])
        width_ratio = w / bw
        area_ratio = (w * h) / prev_area
        min_area_ratio = 0.83 if step == 4 else 0.95
        m.update(
            widthRatio=round(width_ratio, 4),
            areaOverAttempt2=round(area_ratio, 4),
            leftGutter=round(x - bx, 3),
            rightGutter=round((bx + bw) - (x + w), 3),
        )
        if (
            width_ratio < 0.70
            or (step == 4 and width == 1440 and width_ratio < 0.85)
            or area_ratio < min_area_ratio
            or x < bx - 1.0
            or y < by - 1.0
            or (x + w) > (bx + bw + 1.0)
            or (y + h) > (by + bh + 1.0)
        ):
            failures.append(f"map footprint budget: widthRatio={width_ratio:.4f} areaRatio={area_ratio:.4f}")

        # 40m calibrated scale ruler check (<= 2px)
        if step == 2:
            s_geo = _sandbox_geometry(page, world_width)
            ticks = s_geo["ticks"]
            ruler_err = max(
                abs((b["cssX"] - a["cssX"]) - (b["meters"] - a["meters"]) * s_geo["pxPerMeter"])
                for a, b in zip(ticks, ticks[1:])
            )
            m["rulerErrorPx"] = round(ruler_err, 4)
            if ruler_err > 2.0:
                failures.append(f"02 scale ruler error {ruler_err}")
        else:
            ruler_err = page.evaluate("""step => {
              const host = document.querySelector('.step.show');
              const frame = host.querySelector('.pil-aspect-frame').getBoundingClientRect();
              const span = host.querySelector('.scale path').getTotalLength();
              return Math.abs(span - 40 * frame.width / (step === 4 ? 166.2 : 151.5));
            }""", step)
            m["rulerErrorPx"] = round(float(ruler_err), 4)
            if ruler_err > 2.0:
                failures.append(f"0{step} scale ruler error {ruler_err}")

        # 04 D-017 occupied-bounds zero-clipping & single-pass audit
        if step == 4:
            d017 = page.evaluate("""() => {
              const clipEl = document.querySelector('#s4 .pil-viewport-clip');
              const clip = clipEl.getBoundingClientRect();
              const canvas = document.querySelector('#s4 [data-test=region-canvas]');
              const cr = canvas.getBoundingClientRect();
              const s = cr.width / 750;
              const q = globalThis.idvFootprints.get(canvas).map(p => [cr.x + p.x * cr.width / canvas.width, cr.y + p.y * cr.height / canvas.height]);
              const zones = [];
              for (let i = 0; i < 9; i++) {
                const col = Math.floor(i / 3), row = i % 3;
                const l = cr.x + (27 + col * 226.1) * s, t = cr.y + (30 + row * 197) * s;
                zones.push([l, t, l + 226.1 * s, t + 197 * s]);
              }
              const svg = document.querySelector('#s4 .spawn-diff');
              let maxAlignErr = 0;
              const svgBoxes = [];
              if (svg) {
                for (const el of svg.querySelectorAll('circle, rect')) {
                  const b = el.getBoundingClientRect();
                  if (b.width > 0 && b.height > 0) svgBoxes.push([b.left, b.top, b.right, b.bottom]);
                }
                const pts = idvFlowStore.reveal.truth.spawn.perPlayer;
                [...svg.querySelectorAll('[data-test=practice-spawn-point]')].forEach((c, idx) => {
                  const b = c.getBoundingClientRect();
                  maxAlignErr = Math.max(maxAlignErr, Math.hypot(b.left + b.width / 2 - (cr.x + pts[idx].px * s), b.top + b.height / 2 - (cr.y + pts[idx].py * s)));
                });
              }
              return {
                clipLTRB: [clip.left, clip.top, clip.right, clip.bottom],
                clipOverflow: getComputedStyle(clipEl).overflow,
                corners: q,
                zones,
                svgBoxes,
                maxAlignErr,
                singlePass: {
                  filter: window.__idvVisualRegion?.canvasFilter,
                  roofOverlays: window.__idvVisualRegion?.roofOverlays,
                  alpha: window.__idvVisualRegion?.clean?.alpha,
                },
              };
            }""")
            cl, ct, cr_x, cb = d017["clipLTRB"]
            tol = 1.0
            clipped_c = sum(1 for cx, cy in d017["corners"] if not (cl - tol <= cx <= cr_x + tol and ct - tol <= cy <= cb + tol))
            clipped_z = sum(1 for zl, zt, zr, zb in d017["zones"] if not (cl - tol <= zl and zr <= cr_x + tol and ct - tol <= zt and zb <= cb + tol))
            clipped_s = sum(1 for sl, st, sr, sb in d017["svgBoxes"] if not (cl - tol <= sl and sr <= cr_x + tol and ct - tol <= st and sb <= cb + tol))
            m["d017Fit"] = {
                "clipLTRB": d017["clipLTRB"],
                "clipOverflow": d017["clipOverflow"],
                "clippedCorners": clipped_c,
                "clippedRegions": clipped_z,
                "clippedEntities": clipped_s,
                "maxAlignErr": round(d017["maxAlignErr"], 4),
                "singlePass": d017["singlePass"],
            }
            if (
                d017["clipOverflow"] != "hidden"
                or clipped_c or clipped_z or clipped_s
                or d017["maxAlignErr"] > 0.5
                or d017["singlePass"] != {"filter": "none", "roofOverlays": 0, "alpha": 1}
            ):
                failures.append("04 D-017 occupied fit / single-pass")

        # 04/05 6/6 whole-map spread in [40, 52] + clean de-overlaid diagnostic
        if step in (4, 5):
            clean_url = (
                page.evaluate("window.__idvVisualRegion.clean.dataUrl")
                if step == 4
                else page.locator("#s5 .ded-map-img").evaluate("e => e.src")
            )
            clean_src = _decode_data_url_png(clean_url)
            cw_px = max(1, region[2] - region[0])
            ch_px = max(1, region[3] - region[1])
            clean_resized = clean_src.resize((cw_px, ch_px), Image.Resampling.LANCZOS)
            clean_stats = _rec709_stats(np.asarray(clean_resized))
            m["cleanPhotometry"] = clean_stats
            if width == 1440:
                clean_resized.save(shots / f"clean-0{step}-1440.png")
            if not (40.0 <= final_stats["medianSpread"] <= 52.0 and 40.0 <= clean_stats["medianSpread"] <= 52.0):
                failures.append(f"0{step} whole-map spread out of [40,52]")
            if clean_stats["medianY"] < 100.0 or clean_stats["p95Y"] < 190.0:
                failures.append(f"0{step} clean luminance below D-008")

        if step == 5:
            m["imageStyles"] = _check_05_image_styles(page)
        if step in (2, 4):
            m["seal"] = repair.glyph_sizes(page, ".step.show .verdict svg text,.step.show .wax-seal text")
            if sorted(round(n, 2) for n in m["seal"].values()) != [13, 14]:
                failures.append("bilingual seal")
        if step in (4, 5):
            m["header"] = _check_pil_header(page)

        toggle = page.locator(".step.show .folio-toggle")
        toggle.click()
        settle(page)
        m["closedBoard"] = boxes_closed = page.locator(".board" if step == 2 else ".step.show .pil-board-wrap").bounding_box()
        closed_submode_h = (
            page.evaluate("""() => {
              const s = document.querySelector('#regionView > .region-submode-bar')?.getBoundingClientRect();
              const pm = document.querySelector('#regionView > .pil-main')?.getBoundingClientRect();
              return s && pm ? +(pm.top - s.top).toFixed(3) : 0;
            }""")
            if step == 4
            else 0
        )
        exp_closed_board_h = (height - 110 - closed_submode_h) if step == 4 else exp_board_h
        page.screenshot(path=shots / f"{stem}-collapsed.png")
        toggle.click()
        settle(page)
        if m["p50"] < 100 or m["p95"] < 190 or boxes_closed["width"] < 0.98 * width or abs(boxes_closed["width"] - (width - 2 * margin)) > 0.25:
            failures.append("map budget/luminance")
        if abs(bounds["board"][3] - exp_board_h) > 0.5 or abs(boxes_closed["height"] - exp_closed_board_h) > 0.5:
            failures.append("map height")
        if set(m["compass"]) != set("NESW") or min(m["compass"].values()) < 12 or abs(bounds["compass"][2] - 64.0) > 0.5:
            failures.append("compass")

    if step == 1:
        m["seals"] = page.evaluate((RESULTS / "T-014-art/geometry.js").read_text("utf8"), "01")
        if not all(sorted(round(l["cssPx"], 2) for l in c["lines"]) == [13, 14] and not c["frameOverlap"] for c in m["seals"]):
            failures.append("card seals")
        m["cardEntries"] = page.locator(".entry-buttons button").evaluate_all("""els => els.slice(0,8).map(e => {
            const b = e.getBoundingClientRect();
            return {
                text: e.textContent.trim(),
                focusable: e.tabIndex >= 0,
                hit: e.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)),
            };
        })""")
        if len(m["cardEntries"]) != 8 or not all(c["hit"] and c["focusable"] for c in m["cardEntries"]):
            failures.append("archive CTA hit")

    if step == 3:
        geo = m["contribution"] = page.evaluate((RESULTS / "T-014-art/geometry.js").read_text("utf8"), "03")
        m["axes"] = page.locator("#analysis svg text").evaluate_all("""els => els.map(e => {
          const m = e.getScreenCTM();
          return parseFloat(getComputedStyle(e).fontSize) * Math.hypot(m.c, m.d);
        })""")
        if len(m["axes"]) != 12 or any(abs(n - 13) > 0.05 for n in m["axes"]):
            failures.append("axis text")
        parts = [geo["hint"], geo["title"], *(p for row in geo["rows"] for p in row["parts"].values())]
        if len(geo["rows"]) != 4 or any(any(p["frameOverflow"] + p["viewportOverflow"]) for p in parts):
            failures.append("contribution overflow")
        data = cached_payloads[CHINATOWN_MATCH]["analytics"]["survivor_metrics"]
        total = sum(row["cipher_contrib_pct"] for row in data)
        for row in data:
            actual = next(r for r in geo["rows"] if r["uid"] == str(row["uid"]))
            raw = row["cipher_contrib_pct"]
            if actual["raw"] != f"{raw:.2f}%" or abs(actual["widthPct"] - 100 * raw / total) >= 0.015:
                failures.append("contribution value")
        if page.locator(".overview-values svg").count() != 4:
            failures.append("KPI icons")
        if page.locator(".desk-nib, .desk-still > img, .photo-pin").count() != 0:
            failures.append("03 leaked desk props")

    if width == 1440:
        failures.extend(compare(step, shots, live, bounds, page))
    save(shots / (stem + ".json"), m)
    assert shell["oneRow"] and shell["overflow"] == shell["rail"] == 0 and bounds["topbar"][3] == 60
    assert shell["minFont"] >= 12 and shell["dpr"] == shell["zoom"] == 1 and all(v == 1 for v in shell["dim"]), shell
    assert not failures, failures


@pytest.mark.parametrize("step", [2, 4, 5])
def test_desk_breakpoints(scene, step):
    """D-024 §5.1 18-state Phase 5 declutter + expanded 1366/1440 + collapsed zoom/pan/popovers."""
    page, base, shots = scene
    page.set_viewport_size(dict(width=1920, height=1080))
    setup_page(page, base, step, shots, 1920)
    summary = {}

    def assert_decluttered(data, opened, label):
        assert data["overflow"] == 0 and not data["overlaps"] and not data["mapHits"], (label, data)
        assert data["nonInteractive"] and data["toggleHit"], (label, data)
        assert data["bookmarkVisible"] == opened and not data["bookmarkOverlaps"], (label, data)
        assert data["manorMapFrameVisible"], (label, data)
        assert not data["pinVisible"] and data["pinCount"] == 0, (label, data)
        assert data["props"] == [] and data["leakedPropImgs"] == 0, (label, data)
        assert data["clutterVisible"] == 0 and data["folioFoot"] == "0px", (label, data)

    # Check expanded on 1366 & 1440, plus full 18 states across 1679 / 1680 / 1920 × open / closed
    cases = [(1366, 768, (True,)), (1440, 900, (True,)), (1679, 1080, (True, False)), (1680, 1080, (True, False)), (1920, 1080, (True, False))]
    for width, height, open_states in cases:
        page.set_viewport_size(dict(width=width, height=height))
        toggle = page.locator(".step.show .folio-toggle")
        for opened in open_states:
            if toggle.get_attribute("aria-expanded") != str(opened).lower():
                toggle.click()
            settle(page)
            data = page.evaluate(DESK_BREAKPOINT_JS, dict(step=step, open=opened))
            stem = f"desk-{step:02}-{width}-{'open' if opened else 'closed'}"
            if width in (1679, 1680, 1920):
                save(shots / (stem + ".json"), data)
                page.screenshot(path=shots / (stem + ".png"))
            summary[stem] = {
                "overflow": data["overflow"],
                "overlaps": data["overlaps"],
                "mapHits": data["mapHits"],
                "toggleHit": data["toggleHit"],
                "bookmarkVisible": data["bookmarkVisible"],
                "bookmarkOverlaps": data["bookmarkOverlaps"],
                "manorMapFrameVisible": data["manorMapFrameVisible"],
                "pinCount": data["pinCount"],
                "propsCount": len(data["props"]),
                "leakedPropImgs": data["leakedPropImgs"],
                "clutterVisible": data["clutterVisible"],
                "folioFoot": data["folioFoot"],
            }
            assert_decluttered(data, opened, stem)

    # Verify zoom, pan, and popovers on collapsed 1920 remain completely decluttered & unclipped
    interaction_evidence = {}
    if step == 2:
        page.set_viewport_size(dict(width=1920, height=1080))
        toggle = page.locator("#stage2 .folio-toggle")
        if toggle.get_attribute("aria-expanded") != "false":
            toggle.click()
        settle(page)
        cbox = page.locator("[data-test=board-canvas]").bounding_box()
        cx, cy = cbox["x"] + cbox["width"] / 2, cbox["y"] + cbox["height"] / 2
        page.mouse.move(cx, cy)
        page.mouse.wheel(0, -640)
        settle(page)
        z_data = page.evaluate(DESK_BREAKPOINT_JS, dict(step=2, open=False))
        assert_decluttered(z_data, False, "zoom640")
        interaction_evidence["zoom640"] = "clean"

        _sandbox_fit(page)
        settle(page)
        assert_decluttered(page.evaluate(DESK_BREAKPOINT_JS, dict(step=2, open=False)), False, "fit1")

        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 325, cy, steps=10)
        page.mouse.up()
        settle(page)
        p_data = page.evaluate(DESK_BREAKPOINT_JS, dict(step=2, open=False))
        assert_decluttered(p_data, False, "pan325")
        interaction_evidence["pan325"] = "clean"

        _sandbox_fit(page)
        settle(page)
        page.click("[data-test=btn-view-settings]")
        settle(page)
        assert_decluttered(page.evaluate(DESK_BREAKPOINT_JS, dict(step=2, open=False)), False, "viewSettingsOpen")
        page.click("[data-test=btn-view-close]")
        settle(page)
        assert_decluttered(page.evaluate(DESK_BREAKPOINT_JS, dict(step=2, open=False)), False, "viewSettingsClosed")
        interaction_evidence["viewSettingsPopover"] = "clean"
    elif step == 4:
        page.set_viewport_size(dict(width=1920, height=1080))
        toggle = page.locator("#s4 .folio-toggle")
        if toggle.get_attribute("aria-expanded") != "false":
            toggle.click()
        settle(page)
        for sel in (".zone-picker summary", "[data-test=region-display-btn]"):
            page.click(sel)
            settle(page)
            assert_decluttered(page.evaluate(DESK_BREAKPOINT_JS, dict(step=4, open=False)), False, sel + ":open")
            page.click(sel)
            settle(page)
            assert_decluttered(page.evaluate(DESK_BREAKPOINT_JS, dict(step=4, open=False)), False, sel + ":closed")
        interaction_evidence["stage04Popovers"] = "clean"

    save(shots / f"desk-states-{step:02}.json", {"states": summary, "interactions": interaction_evidence})


def test_archive_entry_wheel(scene, cached_payloads):
    page, base, shots = scene
    setup_page(page, base, 2, shots, 1440)
    world = cached_payloads[CHINATOWN_MATCH]["replay"]["world"]["map_underlay"]["world_rect"]
    for width, height in SIZES:
        page.set_viewport_size(dict(width=width, height=height))
        toggle = page.locator("#stage2 .folio-toggle")
        for opened in (True, False):
            if toggle.get_attribute("aria-expanded") != str(opened).lower():
                toggle.click()
            for delta in (-320, -640):
                _sandbox_fit(page)
                _sandbox_zoom(page, shots, world["max_x"] - world["min_x"], "paused", delta, opened)


def _check_eversleeping_rotation(page, base):
    """Adapted from T-016 capture.py::check_rotation for single-pass D-016 (zero .ded-map-patina)."""
    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear()")
    page.reload(wait_until="networkidle")
    page.click("#steps button[data-step='4']")
    page.select_option("[data-test=region-map-select]", "6")
    _wait_map_baked(page, 4)
    settle(page)
    board = page.locator("#s4 .pil-aspect-frame")

    def project(frame_loc, px, py):
        b = frame_loc.bounding_box()
        return [b["x"] + px * b["width"] / 750, b["y"] + py * b["height"] / 874]

    cemetery = project(board, 89.4 + (1.35 + 1.65 / 2) * 206.1, 30.2 + (3 + 1.16 / 2) * 196.3)
    page.mouse.click(*cemetery)
    assert "surv" in (page.locator("[data-zone-idx='9']").get_attribute("class") or "").split()

    samples = {}
    for step in (4, 5):
        if step == 5:
            page.click("#steps button[data-step='5']")
            _wait_map_baked(page, 5)
            settle(page)
        # D-025 §1.3: compute expected projected bounds per step from that step's own .pil-aspect-frame
        step_frame = page.locator(".step.show .pil-aspect-frame")
        expected = [*project(step_frame, 88.9, 29.1), *project(step_frame, 708.4, 847.2)]
        fx, fy, fw, fh = footprint(page, step, None)
        delta = [round(a - b, 4) for a, b in zip((fx, fy, fx + fw, fy + fh), expected)]
        frame_box = step_frame.bounding_box()
        north = page.locator(".step.show .compass g[transform]").first.get_attribute("transform")
        meters40 = page.locator(".step.show .scale > path").evaluate("p => p.getTotalLength()")
        assert max(map(abs, delta)) < 1.0 and north == "rotate(90 36 36)", (step, delta, north)
        assert abs(meters40 - 40 * frame_box["width"] / 137.0) <= 0.05, (step, meters40, frame_box)
        samples[str(step)] = {"projectionDelta": delta, "surface": frame_box, "ruler": meters40, "north": north}

    samples["5"]["imageStyles"] = _check_05_image_styles(page)
    preset = page.locator("#s5 .map-preset")
    preset.select_option("original")
    page.wait_for_function("document.querySelector('#s5 .ded-map-img')?.dataset.mapPreset === 'original'")
    assert page.locator("#s5 .ded-map-patina").count() == 0
    preset.select_option("clarity")
    page.wait_for_function("document.querySelector('#s5 .ded-map-img')?.dataset.mapPreset === 'clarity' && document.querySelector('#s5 .ded-map-img')?.src.startsWith('data:')")
    _check_05_image_styles(page)

    board5 = page.locator("#s5 .pil-aspect-frame")
    b5 = board5.bounding_box()
    point = [b5["x"] + 161 * b5["width"] / 750, b5["y"] + 234 * b5["height"] / 874]
    cipher = page.locator("[data-cipher-idx='1']")
    bounds = cipher.bounding_box()
    error = [bounds["x"] + bounds["width"] / 2 - point[0], bounds["y"] + bounds["height"] / 2 - point[1]]
    assert max(map(abs, error)) < 0.1, error
    page.click("[data-test=deduce-reset]")
    assert cipher.evaluate("(e, xy) => e.contains(document.elementFromPoint(...xy))", point)
    page.mouse.click(*point)
    page.wait_for_selector(".ded-marker.user-yes[data-cipher-idx='1']")
    return {
        "zone10Click": cemetery,
        "cipher": cipher.get_attribute("data-cipher-name"),
        "cipherClick": point,
        "cipherError": error,
        "views": samples,
    }


def test_dense_and_rotation(scene, monkeypatch):
    page, base, shots = scene
    monkeypatch.setattr(page, "goto", partial(page.goto, wait_until="networkidle"))
    monkeypatch.setattr(page, "reload", partial(page.reload, wait_until="networkidle"))
    monkeypatch.setattr(detail, "ART", shots)
    evidence = {}
    detail.dense(page, base, evidence, strict=True)
    evidence["rotation"] = _check_eversleeping_rotation(page, base)
    save(shots / "dense-rotation.json", evidence)


def test_real_chain(scene):
    page, base, shots = scene
    page.goto(base + "/?chain#s=5&auto=0", wait_until="networkidle")
    page.select_option("[data-test=deduce-map-select]", "7")
    page.click("[data-test=deduce-reset]")
    for name in ("花店", "肉铺"):
        page.click(f"[data-cipher-name='{name}']")
    button = page.locator("[data-step-idx]", has_text="裁缝铺内 - 花店 - 肉铺 - 醉芳庭").first
    button.click()
    points = page.locator("polyline.chain-line").evaluate("e => Array.from(e.points, p => [p.x, p.y])")
    assert points == [[344, 220], [760, 332], [1042, 249], [1103, 841]]
    assert points[0] != points[-1]
    save(shots / "chain.json", dict(map="唐人街", marks=["花店", "肉铺"], rule=button.inner_text(), points=points))
    page.screenshot(path=shots / "chain-chinatown.png")

    # Verify 9-map rule inventory in frontend/src/tactical/maps.ts has 0 closed 3-vertex rules
    maps_ts = (REPO_ROOT / "frontend/src/tactical/maps.ts").read_text("utf8")
    inventory = []
    closed_three = []
    for kind, body in re.findall(r"\b(chainThree|chain)\(\{([\s\S]*?)\}\)", maps_ts):
        names_m = re.search(r"cipherNames:\s*\[([^\]]+)\]", body)
        names = re.findall(r"'([^']+)'", names_m.group(1)) if names_m else []
        cyclic = bool(re.search(r"\bcyclic:\s*true\b", body))
        entry = {"kind": kind, "cipherNames": names, "cyclic": cyclic, "vertexCount": len(names)}
        inventory.append(entry)
        if cyclic and len(set(names)) == 3:
            closed_three.append(entry)
    chain_three_count = sum(1 for item in inventory if item["kind"] == "chainThree")
    assert chain_three_count >= 1 and len(inventory) >= 4 and closed_three == [], (inventory, closed_three)
    save(
        shots / "chain-inventory.json",
        {
            "totalChainRules": len(inventory),
            "chainThreeCount": chain_three_count,
            "closedThreeVertexRules": closed_three,
            "rules": inventory,
        },
    )


def test_roof_colors(scene):
    """D-016 / D-020 homologous UV roof ROIs, 04 steel 13x13 swatch, whole-map spread [40,52], and 05 neutral edge."""
    page, base, shots = scene
    page.set_viewport_size(dict(width=1440, height=900))
    data = {}
    r2_baseline = {"4-red": 63.0, "4-blue": 56.0, "5-blue": 24.0}
    r2_old_target = {"4-red": 88.0, "4-blue": 156.0, "5-blue": 78.0}

    for step in (4, 5):
        target_meta = json.loads((TARGETS / f"0{step}.json").read_text("utf8"))
        setup_page(page, base, step, shots, 1440)
        _wait_map_baked(page, step)
        settle(page)
        live = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
        gx, gy, gw, gh = footprint(page, step, None)
        crop_box = (max(0, math.ceil(gx)), max(60, math.ceil(gy)), min(1440, math.floor(gx + gw)), min(900, math.floor(gy + gh)))
        clean_url = (
            page.evaluate("window.__idvVisualRegion.clean.dataUrl")
            if step == 4
            else page.locator("#s5 .ded-map-img").evaluate("e => e.src")
        )
        clean_src = _decode_data_url_png(clean_url)
        clean_resized = clean_src.resize((max(1, crop_box[2] - crop_box[0]), max(1, crop_box[3] - crop_box[1])), Image.Resampling.LANCZOS)
        clean_frame = Image.new("RGB", live.size, (0, 0, 0))
        clean_frame.paste(clean_resized, (crop_box[0], crop_box[1]))

        whole_final = _rec709_stats(np.asarray(live.crop(crop_box)))
        whole_clean = _rec709_stats(np.asarray(clean_resized))
        data[f"{step}-whole"] = {
            "cleanMapXYWH": [round(gx, 3), round(gy, 3), round(gw, 3), round(gh, 3)],
            "footprintLTRB": list(crop_box),
            "final": whole_final,
            "clean": whole_clean,
        }
        assert 40.0 <= whole_final["medianSpread"] <= 52.0, data[f"{step}-whole"]
        assert 40.0 <= whole_clean["medianSpread"] <= 52.0, data[f"{step}-whole"]
        assert whole_final["medianY"] >= 100.0 and whole_final["p95Y"] >= 190.0

        sheet = Image.new("RGB", (440, len(target_meta["roofLandmarks"]) * 136), "#23201d")
        sd = ImageDraw.Draw(sheet)
        for row_idx, (color, spaces) in enumerate(target_meta["roofLandmarks"].items()):
            uv = spaces["new-target"]["uv"]
            poly = [(gx + u * gw, gy + v * gh) for u, v in uv]
            final_px = _polygon_samples(live, poly)
            clean_px = _polygon_samples(clean_frame, poly)
            final_spread = float(np.median(np.ptp(final_px, axis=1)))
            clean_spread = float(np.median(np.ptp(clean_px, axis=1)))
            t018_spread = spaces["new-target"]["medianSpread"]
            r2_val = r2_baseline[f"{step}-{color}"]
            r2_tgt = r2_old_target[f"{step}-{color}"]
            row = data[f"{step}-{color}"] = {
                "uv": uv,
                "livePolygon": [[round(px, 3), round(py, 3)] for px, py in poly],
                "pixels": int(len(final_px)),
                "changedPixels": int(np.any(clean_px != final_px, axis=1).sum()),
                "cleanSpread": round(clean_spread, 3),
                "finalSpread": round(final_spread, 3),
                "t018TargetSpread": t018_spread,
                "r2Spread": r2_val,
                "cleanRGB": [round(float(np.median(clean_px[:, c])), 2) for c in range(3)],
                "finalRGB": [round(float(np.median(final_px[:, c])), 2) for c in range(3)],
            }
            xs, ys = zip(*poly)
            c_rect = (max(0, int(min(xs)) - 14), max(0, int(min(ys)) - 14), min(1440, int(max(xs)) + 14), min(900, int(max(ys)) + 14))
            sheet.paste(clean_frame.crop(c_rect), (10, row_idx * 136 + 26))
            sheet.paste(live.crop(c_rect), (226, row_idx * 136 + 26))
            sd.text((10, row_idx * 136 + 6), f"0{step} {color} clean ({clean_spread:.0f})", fill="#ffe8b9")
            sd.text((226, row_idx * 136 + 6), f"0{step} {color} final ({final_spread:.0f})", fill="#ffe8b9")

            if step == 4 and color == "blue":
                assert 62.0 <= clean_spread <= 95.0 and 62.0 <= final_spread <= 95.0, row
                cx_uv = sum(u for u, _ in uv) / len(uv)
                cy_uv = sum(v for _, v in uv) / len(uv)
                scx, scy = round(gx + cx_uv * gw), round(gy + cy_uv * gh)
                sw_clean = np.asarray(clean_frame.crop((scx - 6, scy - 6, scx + 7, scy + 7)))
                sw_final = np.asarray(live.crop((scx - 6, scy - 6, scx + 7, scy + 7)))
                swatch = {
                    "center": [scx, scy],
                    "clean": {**_rec709_stats(sw_clean), "redZero": int((sw_clean[..., 0] == 0).sum())},
                    "final": {**_rec709_stats(sw_final), "redZero": int((sw_final[..., 0] == 0).sum())},
                }
                row["steelSwatch13x13"] = swatch
                assert swatch["clean"]["redZero"] == 0 and swatch["final"]["redZero"] == 0, swatch
                assert 62.0 <= swatch["final"]["medianSpread"] <= 95.0, swatch
            else:
                assert abs(final_spread - r2_tgt) < abs(r2_val - r2_tgt), row
                assert abs(final_spread - t018_spread) <= 6.0 and abs(clean_spread - t018_spread) <= 6.0, row
        sheet.save(shots / f"roofs-0{step}-live.png")

        if step == 5:
            t_map = target_meta["anchors"]["cleanMap"]["new"]
            u_edge = (909.0 - t_map[0]) / t_map[2]
            v_edge = (361.0 - t_map[1]) / t_map[3]
            ex, ey = round(gx + u_edge * gw), round(gy + v_edge * gh)
            px_final = [int(v) for v in live.getpixel((ex, ey))]
            px_clean = [int(v) for v in clean_frame.getpixel((ex, ey))]
            patch_final = _rec709_stats(np.asarray(live.crop((ex - 3, ey - 3, ex + 4, ey + 4))))
            data["5-neutral-edge"] = {
                "xy": [ex, ey],
                "finalPixel": px_final,
                "cleanPixel": px_clean,
                "finalPatch": patch_final,
            }
            assert px_final[2] - px_final[0] <= 10 and px_clean[2] - px_clean[0] <= 10, data["5-neutral-edge"]
            assert patch_final["medianSpread"] <= 18.0, data["5-neutral-edge"]

    save(shots / "roof-spread.json", data)


def test_replay_folio_and_jumps(scene, cached_payloads):
    page, base, shots = scene
    page.set_viewport_size(dict(width=1440, height=900))
    setup_page(page, base, 2, shots, 1440)
    inner = page.locator("#rightCol .folio-inner")
    clutter = page.locator("#rightCol .folio-corner, #rightCol .folio-edge-flourish, #rightCol .card-flourish")
    clip = page.locator("#rightCol > .binder-clip")

    def clip_rect():
        return clip.evaluate("e => e.getBoundingClientRect().toJSON()")

    before = clip_rect()
    folio_meta = inner.evaluate("""e => {
      const cs = getComputedStyle(e);
      return {
        padding: [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight), parseFloat(cs.paddingBottom)],
        folioFoot: getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim(),
      };
    }""")
    inner.evaluate("e => e.scrollTop = e.scrollHeight")
    scroll = inner.evaluate("e => e.scrollTop")
    assert scroll > 0 and clutter.count() == 0 and clip_rect() == before
    assert folio_meta["folioFoot"] == "0px" and min(folio_meta["padding"]) >= 16.0, folio_meta
    for tab in ("events", "tools", "status"):
        button = page.locator(f"[data-right-tab='{tab}']")
        button.click()
        assert "on" in button.get_attribute("class").split()
    page.click("#steps [data-step='3']")
    page.wait_for_function("document.querySelector('.event-register button') !== null")
    data = cached_payloads[CHINATOWN_MATCH]["analytics"]
    duration = cached_payloads[CHINATOWN_MATCH]["replay"]["match"]["duration_s"]
    uid = data["survivor_metrics"][0]["uid"]
    chase = next(c for c in data["chase_segments"] if c["survivor_uid"] == uid)
    jumps = {}
    for selector, expected in [
        (".phase.midgame", data["phases"][1]["start_t"]),
        (".chart svg", None),
        (".gantt .seg", chase["start_t"]),
        (".kpi.hot button", data["hunter_metrics"]["first_chase_t"]),
    ]:
        control = page.locator(selector).first
        if expected is None:
            first, last = control.locator("text[text-anchor=middle]").evaluate_all("""els =>
                [els[0], els.at(-1)].map(e => new DOMPoint(e.x.baseVal[0].value, 0).matrixTransform(e.getScreenCTM()).x)""")
            x = round((first + last) / 2)
            expected = duration * (x - first) / (last - first)
            page.mouse.click(x, control.bounding_box()["y"] + 25)
        else:
            control.click()
        page.locator("[data-test=clock]").wait_for()
        actual = page.evaluate("idvAppStore.t")
        jumps[selector] = dict(expected=expected, actual=actual)
        assert abs(actual - expected) < 0.1
        page.click("#steps [data-step='3']")
    save(shots / "folio-jumps.json", dict(scroll=scroll, corners=before, jumps=jumps))


def test_region_prediction_and_hospital_scope(scene, monkeypatch):
    page, base, shots = scene
    monkeypatch.setattr(repair, "ART", shots)
    page.add_init_script(detail.PROBE)
    page.set_viewport_size(dict(width=1440, height=900))
    setup_page(page, base, 4, shots, 1440)
    box = page.locator(".pil-aspect-frame").bounding_box()
    line = detail.sightline(page, dict(surface=[box[k] for k in ("x", "y", "width", "height")]))
    layer = page.get_by_label("出生点图层")
    layer.select_option("pro")
    assert not page.locator("#s4 .verdict").count()
    layer.select_option("mine")
    assert not page.locator(".spawn-diff").count()
    hit = repair.check_hit(page, base, MATCHES[4])
    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear()")
    setup_page(page, base, 5, shots, 1440)
    for button in page.locator("[data-step-idx]").all():
        button.click()
        if page.locator(".scope-ring,.chain-line").count():
            break
    assert page.locator(".scope-ring").count() > 0
    local_rule = button.inner_text()
    page.screenshot(path=shots / "hospital-scope.png")
    page.select_option("[data-test=deduce-map-select]", "0")
    page.click("[data-test=deduce-reset]")
    page.screenshot(path=shots / "unknown.png")
    evidence, crops = {}, {}
    repair.marker_sample(page, evidence, "军工厂重置", crops)
    page.click("[data-cipher-name='正门']")
    repair.marker_sample(page, evidence, "正门点击一次", crops)
    page.click("[data-cipher-name='正门废墟']")
    assert "矛盾" in page.locator("[data-test=deduce-conclusion]").inner_text()
    page.screenshot(path=shots / "contradiction.png")
    page.set_viewport_size(dict(width=1366, height=768))
    page.click("#steps [data-step='4']")
    titles = []
    for mid in ("4", "6"):
        page.select_option("[data-test=region-map-select]", mid)
        titles.append(_check_pil_header(page))
    save(shots / "region-scope.json", dict(line=line, hit=hit, hospitalRule=local_rule, headers=titles, markers=evidence))


def test_crowded_canvas_draw_ops_and_contrast(scene):
    """D-016 real Canvas draw-ops crowded-frame matrix (T-019 frames.json) + Chinatown 120s zoomed crop."""
    page, base, shots = scene
    frames_data = json.loads(T019_FRAMES_JSON.read_text("utf8"))
    assert len(frames_data) >= 10
    matrix = []

    def open_paused(mid, t_sec, width, height):
        page.set_viewport_size({"width": width, "height": height})
        page.goto(f"{base}/?crowded={mid}-{t_sec}-{width}#m={mid}&s=2&t={t_sec}&auto=0", wait_until="networkidle")
        page.locator("[data-test=board-canvas]").wait_for()
        page.locator(".case-lineup").wait_for(state="attached")
        page.wait_for_function(
            """([mId, tgt]) => {
              const s = globalThis.idvAppStore, c = document.querySelector('[data-test=board-canvas]');
              return s && s.replay?.match.match_id === mId && Math.abs(s.t - tgt) < 0.25 && globalThis.idvFootprints?.has(c);
            }""",
            arg=[mid, float(t_sec)],
            timeout=20000,
        )
        if page.evaluate("idvAppStore.playing"):
            page.click("[data-test=btn-play]")
        page.locator("[data-test=scrubber]").fill(f"{t_sec:g}")
        settle(page)

    for entry in frames_data:
        mid = entry["id"]
        t_sec = float(entry["t"])
        expected_players = entry["players"]
        is_ct120 = mid == CHINATOWN_MATCH and abs(t_sec - 120.0) < 0.1
        combos = [(w, h, st) for w, h in SIZES for st in ("open", "closed")] if is_ct120 else [(1440, 900, "open")]
        for width, height, state in combos:
            open_paused(mid, t_sec, width, height)
            toggle = page.locator("#stage2 .folio-toggle")
            if toggle.get_attribute("aria-expanded") != str(state == "open").lower():
                toggle.click()
                settle(page)
            _sandbox_fit(page)
            settle(page)

            fr = extract_canvas_draw_frame(page)
            rep = analyze_nameplate_frame(fr, expected_players)
            assert rep["eligibleCount"] == 5 and rep["drawnCount"] == 5 and rep["matchedCount"] == 5, (entry["map"], t_sec, width, state, rep)
            assert rep["degradedCount"] == 0 and rep["minFontPx"] >= 12.0 and not rep["clipped"], rep
            assert rep["maxPlatePlateOverlap"] == 0.0 and rep["maxInkInkOverlap"] == 0.0 and rep["maxInkOtherPlateOverlap"] == 0.0, rep
            assert rep["maxPlateTokenOverlap"] == 0.0 and rep["maxPlateHostOverlap"] == 0.0 and rep["maxPlateForegroundOverlap"] == 0.0, rep

            if is_ct120 and width == 1440 and state == "open":
                # Seek-away & return determinism (<= 0.01 px plate & token drift)
                page.locator("[data-test=scrubber]").fill(f"{t_sec + 5.0:g}")
                settle(page)
                page.locator("[data-test=scrubber]").fill(f"{t_sec:g}")
                settle(page)
                fr2 = extract_canvas_draw_frame(page)
                rep2 = analyze_nameplate_frame(fr2, expected_players)
                max_plate_drift = max(
                    abs(a - b)
                    for r1, r2 in zip(rep["perUid"], rep2["perUid"])
                    for a, b in zip(r1["plateLocal"], r2["plateLocal"])
                )
                max_tok_drift = max(
                    math.hypot(a["centerLocal"][0] - b["centerLocal"][0], a["centerLocal"][1] - b["centerLocal"][1])
                    for a, b in zip(fr["tokenCircles"], fr2["tokenCircles"])
                )
                assert max_plate_drift <= 0.01 and max_tok_drift <= 0.01, (max_plate_drift, max_tok_drift)
                rep["repeatMaxPlateDriftPx"] = round(max_plate_drift, 5)
                rep["repeatMaxTokenDriftPx"] = round(max_tok_drift, 5)

                # Zoomed 2x crop of the Chinatown 120.0s formerly colliding bottom-left trio
                shot_img = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
                trio = [r["plateViewport"] for r in rep["perUid"] if r["uid"] in {1000006, 1000008, 1000010}]
                x0 = max(0, int(min(b[0] for b in trio)) - 48)
                y0 = max(0, int(min(b[1] for b in trio)) - 48)
                x1 = min(shot_img.width, int(max(b[2] for b in trio)) + 48)
                y1 = min(shot_img.height, int(max(b[3] for b in trio)) + 48)
                crop_1x = shot_img.crop((x0, y0, x1, y1))
                crop_1x.resize((crop_1x.width * 2, crop_1x.height * 2), Image.Resampling.NEAREST).save(
                    shots / "crowded-chinatown-120-crop.png"
                )

                # Real Canvas WCAG contrast on Chinatown 120.0s (also verifies labels=false token drift <= 0.01px)
                c_contrast = measure_canvas_label_contrast(page, fr)
                assert len(c_contrast) == 5 and all(r["minimumContrast"] >= 4.5 for r in c_contrast), c_contrast
                rep["canvasContrast"] = c_contrast

            matrix.append({
                "matchId": mid,
                "map": entry["map"],
                "t": t_sec,
                "viewport": [width, height],
                "folio": state,
                "dpr": fr["dpr"],
                "canvasSize": [fr["canvasW"], fr["canvasH"]],
                **rep,
            })

    save(shots / "crowded-canvas-draw-ops.json", {"evaluations": len(matrix), "results": matrix})


def test_phase5_sandbox_pil2d_parity(scene):
    """D-024 §5.2 Stage 02 PIL 2D Parity visual & functional live Edge audit at 1440x900."""
    page, base, shots = scene
    page.set_viewport_size(dict(width=1440, height=900))
    nav_hits = {}

    def on_nav_resp(resp):
        if "/assets/nav-grid/" in resp.url:
            nav_hits[resp.url.split("/")[-1]] = resp.status

    page.on("response", on_nav_resp)
    try:
        page.goto(base + "/?p5-sandbox#s=2&auto=0", wait_until="networkidle")
        page.locator("[data-test=board-canvas]").wait_for()
        page.wait_for_function("globalThis.idvFootprints?.has(document.querySelector('[data-test=board-canvas]'))")
        settle(page)

        # Ensure standalone whiteboard on 军工厂 (mapId = 0)
        if page.locator("[data-test=sandbox-map-select]").count() == 0:
            page.locator("#transport .mode-pills button", has_text="白板").click()
            settle(page)
        if page.locator("[data-test=sandbox-map-select]").input_value() != "0":
            page.select_option("[data-test=sandbox-map-select]", "0")
            settle(page)
        page.wait_for_function("() => performance.getEntriesByType('resource').some(r => r.name.includes('/assets/nav-grid/ArmsFactory.png'))")
        assert nav_hits.get("ArmsFactory.png") == 200 or page.evaluate(
            "async () => (await fetch('/assets/nav-grid/ArmsFactory.png')).status === 200"
        )

        def map_pt(u, v):
            return page.evaluate("""([u, v]) => {
              const c = document.querySelector('[data-test=board-canvas]');
              const r = c.getBoundingClientRect();
              const q = globalThis.idvFootprints.get(c).map(p => [r.x + p.x * r.width / c.width, r.y + p.y * r.height / c.height]);
              const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
              const l = Math.min(...xs), t = Math.min(...ys), w = Math.max(...xs) - l, h = Math.max(...ys) - t;
              return [l + u * w, t + v * h];
            }""", [u, v])

        # 1. 密码机速查 card in tools -> inspect
        page.click("[data-right-tab='tools']")
        page.click("[data-panel-tool='inspect']")
        card = page.locator("[data-test=tac-cipher-card]")
        card.wait_for()
        assert card.locator("[data-cipher-card-row]").count() == 7
        group_before = card.inner_text()
        page.click("[data-test=btn-cipher-card-next]")
        assert card.inner_text() != group_before
        card.locator("[data-cipher-card-row]").first.click()
        assert "active" in (card.locator("[data-cipher-card-row]").first.get_attribute("class") or "").split()

        # 2. Live cursor coords (toggle-show-coords -> tac-coords-tip)
        page.click("[data-test=btn-view-settings]")
        coords_chk = page.locator("[data-test=toggle-show-coords]")
        if not coords_chk.is_checked():
            coords_chk.click()
        page.click("[data-test=btn-view-close]")
        cx, cy = map_pt(0.45, 0.45)
        page.mouse.move(cx, cy)
        tip = page.locator("[data-test=tac-coords-tip]")
        tip.wait_for()
        assert "px (" in tip.inner_text() and "m)" in tip.inner_text()

        # 3. Measure route ('路径线·绕障') across obstacle on 军工厂 + ETA + vault/autofix toggles
        page.click("[data-panel-tool='measure']")
        page.click("[data-test=btn-measure-route]")
        assert page.locator("[data-test=toggle-measure-vault]").is_checked()
        assert page.locator("[data-test=toggle-measure-autofix]").is_checked()
        p1 = map_pt(0.24, 0.34)
        p2 = map_pt(0.76, 0.66)
        page.mouse.click(p1[0], p1[1])
        page.mouse.click(p2[0], p2[1])
        page.locator("[data-test=measure-sim-result] .tac-routed-pill").first.wait_for(timeout=15000)
        sim_text = page.locator("[data-test=measure-sim-result]").inner_text()
        assert "总长" in sim_text and "耗时" in sim_text and "绕障" in sim_text
        # Toggle 允许翻窗 & 自动修正阻挡点
        page.locator("[data-test=toggle-measure-vault]").click()
        settle(page)
        page.locator("[data-test=toggle-measure-vault]").click()
        page.locator("[data-test=toggle-measure-autofix]").click()
        page.locator("[data-test=toggle-measure-autofix]").click()
        settle(page)
        page.screenshot(path=shots / "phase5-02-route-measure.png")

        # 4. Range nav-grid Carry & Tide 5-band contour + basement chair toggle + chair table
        page.click("[data-panel-tool='range']")
        page.click("[data-test=btn-range-carry]")
        page.click("[data-test=btn-range-mode-chair]")
        page.click("[data-test=toggle-range-basement]")
        page.wait_for_function("() => (document.querySelector('[data-test=range-summary]')?.textContent || '').includes('绕障导航')", timeout=15000)
        assert page.locator("[data-test=range-legend] [data-band]").count() == 5
        page.screenshot(path=shots / "phase5-02-carry-contour.png")
        page.click("[data-test=btn-range-tide]")
        page.click("[data-test=btn-range-mode-point]")
        pt_r = map_pt(0.50, 0.50)
        page.mouse.click(pt_r[0], pt_r[1])
        page.locator("[data-test=range-chair-table] [data-chair-row]").first.wait_for(timeout=15000)
        assert page.locator("[data-test=range-chair-table] [data-chair-row]").count() >= 5

        # 5. Anim auto-pathing + scrubber + 90-degree rotation + keyboard shortcuts (Arrow nudge + Ctrl+Z)
        page.click("[data-panel-tool='place']")
        page.click("[data-test=place-camp-survivor]")
        page.click("[data-test=role-btn-seer]")
        tok_pt = map_pt(0.30, 0.42)
        page.mouse.click(tok_pt[0], tok_pt[1])
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() >= 1

        # ArrowRight nudge + Ctrl+Z undo
        def last_tok_x():
            return page.evaluate("() => JSON.parse(localStorage.getItem('idv.pil.v2') || '{}').boards?.['0']?.tokens?.at(-1)?.x")

        x0 = last_tok_x()
        page.locator("[data-test=placed-list] [data-placed-token]").last.click()
        page.evaluate("() => document.activeElement?.blur?.()")
        page.keyboard.press("ArrowRight")
        x1 = last_tok_x()
        assert x1 > x0 + 0.002, (x0, x1)
        page.keyboard.press("Control+z")
        x2 = last_tok_x()
        assert abs(x2 - x0) < 1e-4, (x0, x1, x2)

        # Anim auto-pathing (re-select token after Ctrl+Z undo)
        page.click("[data-panel-tool='anim']")
        page.locator("[data-test=tool-panel-anim] .tac-chip-grid button").last.click()
        assert page.locator("[data-test=toggle-anim-autoroute]").is_checked()
        page.click("[data-test=btn-anim-arm]")
        wp = map_pt(0.70, 0.56)
        page.mouse.click(wp[0], wp[1])
        page.locator("[data-test=anim-waypoint-list] .tac-routed-pill").first.wait_for(timeout=15000)
        page.locator("[data-test=tac-anim-scrubber]").wait_for()
        page.locator("[data-test=tac-anim-scrubber]").fill("2")
        assert float(page.locator("[data-test=tac-anim-clock]").inner_text().split("s")[0]) >= 1.5

        # 90-degree board rotation
        page.click("[data-test=btn-view-settings]")
        page.click("[data-test=btn-board-rotate-90]")
        page.click("[data-test=btn-view-close]")
        assert "偏航 90°" in page.locator(".board .hud").inner_text()
        _sandbox_fit(page)

        # Verify WCAG contrast >= 4.5 and 0 overflow on Phase 5 PIL whiteboard
        samples = contrast.measure(page)
        assert min(r["minimum"] for r in samples) >= 4.5, samples[:5]
        assert page.evaluate("document.documentElement.scrollWidth - innerWidth") == 0
        save(shots / "phase5-sandbox-parity.json", {"navHits": nav_hits, "sim": sim_text, "minContrast": samples[0]["minimum"]})
    finally:
        page.remove_listener("response", on_nav_resp)


def _wait_predict_map_baked(page, expected_map_name: str | None = None):
    """Wait until SpawnPredictorView finishes baking its enhanced data: URL map image."""
    page.wait_for_function(
        """name => {
          const b = document.querySelector('[data-test=spawn-predict-board]');
          const im = document.querySelector('.sp-map-img');
          if (!b || !im) return false;
          if (name && b.getAttribute('data-map-name') !== name) return false;
          return Boolean(im.complete && im.naturalWidth > 0 && im.src.startsWith('data:'));
        }""",
        arg=expected_map_name,
    )


def test_phase5_stage04_spawn_predictor_and_linkage(scene):
    """D-024 §5.2 Stage 04 Opening Spawn Predictor + 36 portraits + 永眠镇/湖景村 + Mode B & Stage 02 linkage."""
    page, base, shots = scene
    page.set_viewport_size(dict(width=1440, height=900))
    page.goto(base + "/?p5-predict#s=4&auto=0", wait_until="networkidle")
    page.locator("[data-test=region-submode-tabs]").wait_for()
    settle(page)

    # Switch to Mode A (开局选点预测)
    page.click("[data-test=btn-region-mode-predict]")
    page.locator("[data-test=spawn-predict-board]").wait_for()
    _wait_predict_map_baked(page)
    settle(page)

    # Open 35-Hunter modal, verify 36/36 portraits HTTP 200 (0 external), search & select hunter
    page.click("[data-test=btn-predict-hunter]")
    modal = page.locator("[data-test=spawn-hunter-modal]")
    modal.wait_for()
    assert modal.locator("[data-hunter-idx]").count() == 36
    portrait_statuses = page.evaluate("""async () => {
      const imgs = [...document.querySelectorAll('[data-test=spawn-hunter-modal] img')];
      return Promise.all(imgs.map(async i => {
        const src = i.getAttribute('src') || '';
        const resp = await fetch(src);
        return { src, status: resp.status };
      }));
    }""")
    assert len(portrait_statuses) == 36 and all(p["status"] == 200 for p in portrait_statuses), portrait_statuses
    page.fill("[data-test=spawn-hunter-search]", "宿伞")
    assert modal.locator("[data-hunter-idx]").count() >= 1
    modal.locator("[data-hunter-idx]").first.click()
    modal.wait_for(state="hidden")
    assert "宿伞" in page.locator("[data-test=btn-predict-hunter]").inner_text()
    # Reset back to 不限监管 so full map pool is active for deterministic picks
    page.click("[data-test=btn-predict-hunter]")
    modal.locator("[data-hunter-idx='-1']").click()
    modal.wait_for(state="hidden")

    # Pick 4 Survivor GEO cells on 军工厂 + 标备选 (我) + verify badge, heatmap, 我的预判对比, Top-20 table
    page.select_option("[data-test=predict-map-select]", "0")
    _wait_predict_map_baked(page, "军工厂")
    settle(page)
    for cid in ("11", "13", "31", "33"):
        page.click(f"[data-predict-cell='{cid}']")
    page.locator("[data-test=predict-best-badge]").wait_for()
    stats_texts = page.locator(".sp-cell-stat").all_inner_texts()
    assert len(stats_texts) >= 4 and all("% · " in t and "局" in t for t in stats_texts), stats_texts
    assert page.locator("[data-test=predict-records-table] tbody tr").count() >= 1

    # Mark personal alt prediction "我" on a free cell
    page.click("[data-test=btn-predict-mark-alt]")
    page.click("[data-predict-cell='22']")
    assert page.locator("[data-test=predict-my-alt-marker]").is_visible()
    assert "我的预判对比" in page.locator("[data-test=predict-my-alt-diff]").inner_text()
    page.click("[data-test=btn-predict-mark-alt]")  # exit mark-alt mode
    page.screenshot(path=shots / "phase5-04-predict-active.png")

    # Contrast & overflow check on Mode A active board
    samples_a = contrast.measure(page)
    assert min(r["minimum"] for r in samples_a) >= 4.5, samples_a[:5]
    assert page.evaluate("document.documentElement.scrollWidth - innerWidth") == 0

    # Top-6 layout preset & 随机实局
    page.locator("[data-test=predict-top-layouts] button[data-layout-key]").first.click()
    page.locator("[data-test=predict-best-badge]").wait_for()
    page.click("[data-test=btn-predict-random]")
    page.locator("[data-test=predict-best-badge]").wait_for()

    # 永眠镇 (mapId=6): 10 cells including 14
    page.select_option("[data-test=predict-map-select]", "6")
    _wait_predict_map_baked(page, "永眠镇")
    settle(page)
    assert page.locator("[data-predict-cell]").count() == 10
    assert page.locator("[data-predict-cell='14']").is_visible()
    page.locator("[data-test=predict-top-layouts] button[data-layout-key]").first.click()
    page.locator("[data-test=predict-best-badge]").wait_for()

    # 湖景村 (mapId=3): 12 cells + 带入封禁分析 -> Mode B lock cipher + 发送到战术沙盘 -> Step 02 whiteboard 5 tokens
    page.select_option("[data-test=predict-map-select]", "3")
    _wait_predict_map_baked(page, "湖景村")
    settle(page)
    assert page.locator("[data-predict-cell]").count() == 12
    page.locator("[data-test=predict-top-layouts] button[data-layout-key]").first.click()
    page.locator("[data-test=predict-best-badge]").wait_for()
    best_coord = page.locator("[data-test=predict-best-coord]").inner_text().strip()
    assert best_coord

    # Transfer to Mode B (带入封禁分析)
    page.click("[data-test=btn-predict-to-lock]")
    page.locator("[data-test=region-canvas]").wait_for()
    _wait_map_baked(page, 4)
    settle(page)
    assert page.locator("[data-test=region-map-select]").input_value() == "3"
    assert "4 / 4" in page.locator("[data-test=region-side-survivor]").inner_text()
    assert "1 / 1" in page.locator("[data-test=region-side-hunter]").inner_text()
    lock_name = page.locator("[data-test=lock-cipher-name]").inner_text().strip()
    lock_dist = page.locator("[data-test=lock-cipher-dist]").inner_text().strip()
    assert lock_name and lock_name != "--" and lock_dist and lock_dist != "--"

    # Return to Mode A and click 发送到战术沙盘 -> Step 02 whiteboard on 湖景村 with 5 opening tokens
    page.click("[data-test=btn-region-mode-predict]")
    page.locator("[data-test=spawn-predict-board]").wait_for()
    _wait_predict_map_baked(page, "湖景村")
    settle(page)
    page.locator("[data-test=predict-top-layouts] button[data-layout-key]").first.click()
    page.locator("[data-test=predict-best-badge]").wait_for()
    page.click("[data-test=btn-predict-to-sandbox]")
    page.locator("#s2.show [data-test=board-canvas]").wait_for()
    page.wait_for_function("globalThis.idvFootprints?.has(document.querySelector('[data-test=board-canvas]'))")
    settle(page)
    assert page.locator("[data-test=sandbox-map-select]").input_value() == "3"
    page.click("[data-right-tab='tools']")
    page.click("[data-panel-tool='place']")
    assert page.locator("[data-test=placed-list] [data-placed-token]").count() == 5
    save(shots / "phase5-stage04-predict.json", {
        "portraitsLoaded": len(portrait_statuses),
        "modeAMinContrast": samples_a[0]["minimum"],
        "lakesideBestCoord": best_coord,
        "transferredLockCipher": lock_name,
        "transferredLockDist": lock_dist,
        "sandboxOpeningTokens": 5,
    })


def test_phase6_visual_craft_and_typography_parity(scene, frontend_server):
    """D-026 §2–§5 & T-033 §1: offline italic/600/900 .woff2 HTTP 200, custom .sel, topbar plaques & crimson V, 11/11 SHA-256."""
    import hashlib

    page, base, shots = scene
    page.set_viewport_size(dict(width=1440, height=900))
    woff_hits = {}

    def on_woff_resp(resp):
        if resp.url.startswith(base) and ".woff2" in resp.url:
            woff_hits[resp.url.split("/")[-1]] = resp.status

    page.on("response", on_woff_resp)
    try:
        # 1. Verify bundled offline .woff2 files exist in build output, serve HTTP 200 with wOF2 header, and load in document.fonts
        dist_assets = Path(frontend_server["out_dir"]) / "assets"
        required_woff2_patterns = {
            "cormorant_600_italic": "cormorant-garamond-latin-600-italic-",
            "cormorant_700_italic": "cormorant-garamond-latin-700-italic-",
            "noto_600": "-600-normal-",
            "noto_900": "-900-normal-",
        }
        matched_woff2 = {}
        for key, pat in required_woff2_patterns.items():
            candidates = sorted(
                p.name
                for p in dist_assets.glob("*.woff2")
                if pat in p.name and (not key.startswith("noto_") or p.name.startswith("noto-serif-sc-"))
            )
            assert candidates, (key, pat)
            matched_woff2[key] = candidates[0]

        page.goto(base + "/?p6-craft#s=1&auto=0", wait_until="networkidle")
        settle(page)
        woff_probe = page.evaluate(
            """async names => {
              const out = {};
              for (const [k, fname] of Object.entries(names)) {
                const r = await fetch('/assets/' + fname);
                const buf = new Uint8Array(await r.arrayBuffer());
                const magic = String.fromCharCode(...buf.slice(0, 4));
                out[k] = { file: fname, status: r.status, magic, bytes: buf.length };
              }
              const synth = [...document.querySelectorAll('.archive-brand small, #bar #steps small, #dropZone header em')]
                .map(e => getComputedStyle(e).fontSynthesisStyle);
              return { fetched: out, fontSynthesisStyles: synth };
            }""",
            matched_woff2,
        )
        for key, info in woff_probe["fetched"].items():
            assert info["status"] == 200 and info["magic"] == "wOF2" and info["bytes"] > 5000, (key, info)
            assert woff_hits.get(info["file"]) == 200, (key, info, woff_hits)
        assert all(s == "none" for s in woff_probe["fontSynthesisStyles"]), woff_probe["fontSynthesisStyles"]

        # 2. Verify topbar plaques, vivid crimson brand V (>= 4.5:1), .sel appearance==='none', and 0 desk props across 01/02/04/05
        stage_checks = {}
        for step in (1, 2, 4, 5):
            setup_page(page, base, step, shots, 1440)
            if step in (4, 5):
                _wait_map_baked(page, step)
            settle(page)
            state_info = page.evaluate(
                """step => {
                  const inactive = [...document.querySelectorAll('#bar #steps button:not(.on)')].map(b => {
                    const cs = getComputedStyle(b);
                    return [cs.backgroundColor, cs.backgroundImage];
                  });
                  const activeCs = getComputedStyle(document.querySelector('#bar #steps button.on'));
                  const vRgb = (getComputedStyle(document.querySelector('#bar .identity i')).color.match(/\\d+/g) || []).slice(0, 3).map(Number);
                  const sels = [...document.querySelectorAll('#bar select.sel, .step.show select.sel')]
                    .filter(s => s.checkVisibility())
                    .map(s => ({
                      test: s.dataset.test || s.className,
                      appearance: getComputedStyle(s).appearance,
                      hasBgImage: getComputedStyle(s).backgroundImage !== 'none',
                    }));
                  return {
                    inactive,
                    activeHasGradient: activeCs.backgroundImage.includes('linear-gradient'),
                    activeHasShadow: activeCs.boxShadow !== 'none',
                    vRgb,
                    sels,
                    deskImgs: document.querySelectorAll('.desk-still > img').length,
                    photoPins: document.querySelectorAll('.photo-pin').length,
                    leakedProps: [...document.querySelectorAll('img')].filter(i =>
                      /desk-(fountain-pen|pocket-watch|vintage-postcard)\\.png/i.test((i.getAttribute('src') || '') + ' ' + (i.currentSrc || ''))
                    ).length,
                    clutterVisible: [...document.querySelectorAll('.folio-corner,.folio-edge-flourish,.card-flourish,.foot-corner,.well-corner,.plate-corner,.phase-corner,.board-flourish')]
                      .filter(e => e.checkVisibility()).length,
                  };
                }""",
                step,
            )
            orn = _ornament_contrast(page)
            brand_rows = [r for r in orn if r["kind"] == "brand" and r["label"] == "V"]
            assert brand_rows and min(r["minimum"] for r in brand_rows) >= 4.5, (step, brand_rows)
            assert len(state_info["inactive"]) == 4 and all(x == ["rgba(0, 0, 0, 0)", "none"] for x in state_info["inactive"]), (step, state_info)
            assert state_info["activeHasGradient"] and state_info["activeHasShadow"], (step, state_info)
            r_ch, g_ch, _ = state_info["vRgb"]
            assert r_ch >= 220 and (r_ch - g_ch) >= 110, (step, state_info["vRgb"])
            assert len(state_info["sels"]) >= 1 and all(s["appearance"] == "none" and s["hasBgImage"] for s in state_info["sels"]), (step, state_info["sels"])
            assert (
                state_info["deskImgs"] == 0
                and state_info["photoPins"] == 0
                and state_info["leakedProps"] == 0
                and state_info["clutterVisible"] == 0
            ), (step, state_info)
            state_info["brandVMinContrast"] = brand_rows[0]["minimum"]
            stage_checks[f"0{step}"] = state_info

            # Also check Stage 02 Whiteboard .sel controls and Stage 04 Spawn Predictor .sel controls
            if step == 2:
                page.locator("#transport .mode-pills button", has_text="白板").click()
                settle(page)
                page.click("[data-right-tab='tools']")
                page.click("[data-panel-tool='range']")
                settle(page)
                wb_sels = page.evaluate(
                    """() => [...document.querySelectorAll('#s2 select.sel')].filter(s => s.checkVisibility()).map(s => ({
                      test: s.dataset.test || s.className,
                      appearance: getComputedStyle(s).appearance,
                      hasBgImage: getComputedStyle(s).backgroundImage !== 'none',
                    }))"""
                )
                assert len(wb_sels) >= 4 and all(s["appearance"] == "none" and s["hasBgImage"] for s in wb_sels), wb_sels
                stage_checks["02-whiteboard-sels"] = wb_sels
            elif step == 4:
                page.click("[data-test=btn-region-mode-predict]")
                page.locator("[data-test=spawn-predict-board]").wait_for()
                _wait_predict_map_baked(page)
                settle(page)
                sp_sels = page.evaluate(
                    """() => [...document.querySelectorAll('#s4 select.sel')].filter(s => s.checkVisibility()).map(s => ({
                      test: s.dataset.test || s.className,
                      appearance: getComputedStyle(s).appearance,
                      hasBgImage: getComputedStyle(s).backgroundImage !== 'none',
                    }))"""
                )
                assert len(sp_sels) >= 2 and all(s["appearance"] == "none" and s["hasBgImage"] for s in sp_sels), sp_sels
                stage_checks["04-predict-sels"] = sp_sels

        # 3. Verify 11/11 frontend/public/assets/dossier/**/*.png SHA-256 unchanged vs 3f0c35be & built out_dir
        dossier_dir = REPO_ROOT / "frontend/public/assets/dossier"
        rev = "3f0c35be19e9f02c54b1a2e0b453e356ff1d5e4a"
        hashes = {}
        for p in sorted(dossier_dir.rglob("*.png")):
            rel = p.relative_to(REPO_ROOT).as_posix()
            ref_bytes = subprocess.check_output(["git", "show", f"{rev}:{rel}"], cwd=REPO_ROOT)
            built_p = Path(frontend_server["out_dir"]) / p.relative_to(REPO_ROOT / "frontend/public")
            assert ref_bytes == p.read_bytes() == built_p.read_bytes(), rel
            hashes[rel] = hashlib.sha256(ref_bytes).hexdigest()
        assert len(hashes) == 11, hashes

        save(
            shots / "phase6-visual-craft.json",
            {"woff2": woff_probe, "stages": stage_checks, "dossierPngHashes": hashes},
        )
    finally:
        page.remove_listener("response", on_woff_resp)


def test_final_integrity(audit_fingerprint_before, repo_cache_fingerprint_before):
    from conftest import AUDIT_DIR, REPO_CACHE_DIR, tree_fingerprint
    assert tree_fingerprint(AUDIT_DIR) == audit_fingerprint_before
    assert tree_fingerprint(REPO_CACHE_DIR) == repo_cache_fingerprint_before
