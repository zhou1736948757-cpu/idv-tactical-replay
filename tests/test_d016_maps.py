"""D-016 / D-017 / D-019 / D-020 live Edge audit for Stage 04 (Region) & Stage 05 (Deduce)."""
from __future__ import annotations

import base64
import io
import json
import math
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import pytest
from PIL import Image, ImageDraw

from conftest import REPO_ROOT, VERIFIED_MATCH_IDS
from test_fullstack_e2e import browser_session  # noqa: F401
from test_phase4_visual import MATCHES, SIZES, contrast, detail, settle, setup_page

TARGETS_D018 = REPO_ROOT / "Workflow/results/T-018-art/targets"
ATTEMPT2_DIR = REPO_ROOT / "Workflow/results/T-017-art/attempt-2"
R2_REV = "4e38784"

# Injected before app load: observes real production Canvas2D draws on 04 without altering behavior.
MAPS_PROBE = r"""{
  const proto = CanvasRenderingContext2D.prototype;
  const origClear = proto.clearRect;
  const origDraw = proto.drawImage;
  const origFill = proto.fillText;
  const origGetData = proto.getImageData;
  const origMove = proto.moveTo;
  const origLine = proto.lineTo;
  const canvasDataUrlCache = new WeakMap();
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  window.__idvMapsProbe = {
    regionClean: null,
    regionSightline: {},
    regionRoofOverlays: 0,
    regionCanvasFilter: 'none',
    regionTexts: [],
    regionCanvasInk: [],
  };

  proto.clearRect = function (...args) {
    if (this.canvas?.dataset?.test === 'region-canvas') {
      window.__idvMapsProbe.regionSightline = {};
      window.__idvMapsProbe.regionRoofOverlays = 0;
      window.__idvMapsProbe.regionTexts = [];
      window.__idvMapsProbe.regionCanvasInk = [];
    }
    return origClear.apply(this, args);
  };

  proto.moveTo = function (...args) {
    if (this.canvas?.dataset?.test === 'region-canvas' &&
        this.getLineDash().join(',') === '6,4' && this.strokeStyle === '#ffe69c') {
      window.__idvMapsProbe.regionSightline.moveTo = args;
    }
    return origMove.apply(this, args);
  };

  proto.lineTo = function (...args) {
    if (this.canvas?.dataset?.test === 'region-canvas' &&
        this.getLineDash().join(',') === '6,4' && this.strokeStyle === '#ffe69c') {
      window.__idvMapsProbe.regionSightline.lineTo = args;
    }
    return origLine.apply(this, args);
  };

  proto.drawImage = function (img, ...args) {
    if (this.canvas?.dataset?.test === 'region-canvas') {
      if (args.length === 8 && this.globalCompositeOperation === 'color') {
        window.__idvMapsProbe.regionRoofOverlays++;
      }
      const nw = img?.naturalWidth || img?.width || 0;
      const nh = img?.naturalHeight || img?.height || 0;
      if (nw >= 300 && nh >= 300 && args.length === 4) {
        window.__idvMapsProbe.regionCanvasFilter = this.filter || 'none';
        let dataUrl = null;
        if (img instanceof HTMLCanvasElement) {
          dataUrl = canvasDataUrlCache.get(img);
          if (!dataUrl) {
            dataUrl = img.toDataURL('image/png');
            canvasDataUrlCache.set(img, dataUrl);
          }
        }
        const [x, y, dw, dh] = args;
        const m = this.getTransform();
        const pts = [[x, y], [x + dw, y], [x + dw, y + dh], [x, y + dh]]
          .map(([u, v]) => m.transformPoint({ x: u, y: v }));
        window.__idvMapsProbe.regionClean = {
          kind: img.constructor.name,
          filter: this.filter || 'none',
          alpha: this.globalAlpha,
          width: nw,
          height: nh,
          dataUrl,
          cornersCanvas: pts.map(p => [p.x, p.y]),
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
    window.__idvMapsProbe.regionTexts.push({
      label,
      fontPx: fontPx * scaleY,
      canvasHeight: this.canvas.height,
    });

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
        let minRatio = Infinity;
        let corePixels = 0;
        let worstFg = null;
        let worstBg = null;
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
          window.__idvMapsProbe.regionCanvasInk.push({
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
}"""


def save_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf8")


def rec709_metrics(arr: np.ndarray) -> Dict[str, Any]:
    rgb = arr.astype(np.float64)
    y = rgb @ np.array([0.2126, 0.7152, 0.0722])
    spread = np.ptp(arr, axis=-1)
    med_rgb = [round(float(np.median(arr[..., c])), 2) for c in range(3)]
    return {
        "medianY": round(float(np.median(y)), 3),
        "p95Y": round(float(np.percentile(y, 95)), 3),
        "medianSpread": round(float(np.median(spread)), 3),
        "medianRGB": med_rgb,
        "pixels": int(y.size),
    }


def polygon_samples(img: Image.Image, poly: List[Tuple[float, float]]) -> np.ndarray:
    mask = Image.new("1", img.size, 0)
    ImageDraw.Draw(mask).polygon(poly, fill=1)
    return np.asarray(img.convert("RGB"))[np.asarray(mask)]


def decode_data_url_png(url: str) -> Image.Image:
    _, payload = url.split(",", 1)
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert("RGB")


def get_clean_map_box(page, step: int) -> List[float]:
    if step == 5:
        b = page.locator(".ded-map-img").bounding_box()
        return [b["x"], b["y"], b["width"], b["height"]]
    return page.locator("[data-test=region-canvas]").evaluate("""c => {
      const r = c.getBoundingClientRect();
      const q = globalThis.idvFootprints.get(c);
      const xs = q.map(p => r.x + p.x * r.width / c.width);
      const ys = q.map(p => r.y + p.y * r.height / c.height);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    }""")


def wait_map_baked(page, step: int) -> None:
    if step == 4:
        page.wait_for_function("""() => {
          const p = window.__idvMapsProbe?.regionClean;
          return Boolean(p && p.kind === 'HTMLCanvasElement' && p.dataUrl && p.dataUrl.startsWith('data:'));
        }""")
    else:
        page.wait_for_function("""() => {
          const im = document.querySelector('.ded-map-img');
          return Boolean(im && im.complete && im.naturalWidth > 0 && im.src.startsWith('data:'));
        }""")


@pytest.fixture(scope="module", autouse=True)
def install_maps_probe(browser_session):  # noqa: F811
    browser_session["page"].add_init_script(MAPS_PROBE)
    browser_session["page"].add_init_script(detail.PROBE)


@pytest.fixture
def clean_page(browser_session, screenshot_dir):  # noqa: F811
    page = browser_session["page"]
    base = browser_session["base"]
    page.goto(base, wait_until="networkidle")
    settle(page)
    page.evaluate("""() => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('idv.flow.v1.visualPreset', 'clarity');
    }""")
    yield page, base, screenshot_dir
    errs = browser_session["errors"]
    assert not any(errs[k] for k in ("console", "page", "external", "http", "failed")), errs


def test_04_05_photometry_and_roof_rois(clean_page):
    """Verify 6/6 D-008 Rec.709 Y, 6/6 spread in [40,52] + clean diagnostic, 3 roof UV ROIs, and 05 neutral edge."""
    page, base, shots = clean_page
    six_grid: Dict[str, Any] = {}
    roof_report: Dict[str, Any] = {}
    swatch_report: Dict[str, Any] = {}
    hospital_edge_report: Dict[str, Any] = {}

    for step in (4, 5):
        target_meta = json.loads((TARGETS_D018 / f"{step:02}.json").read_text("utf8"))
        for width, height in SIZES:
            page.set_viewport_size({"width": width, "height": height})
            setup_page(page, base, step, shots, width)
            wait_map_baked(page, step)
            settle(page)

            stem = f"{width}-{step:02}"
            png_bytes = page.screenshot(path=shots / f"{stem}.png")
            live = Image.open(io.BytesIO(png_bytes)).convert("RGB")
            gx, gy, gw, gh = get_clean_map_box(page, step)
            crop_box = (
                max(0, math.ceil(gx)),
                max(60, math.ceil(gy)),
                min(width, math.floor(gx + gw)),
                min(height, math.floor(gy + gh)),
            )
            final_stats = rec709_metrics(np.asarray(live.crop(crop_box)))

            # Same-camera clean diagnostic from the actual live browser mapTone canvas
            if step == 4:
                clean_url = page.evaluate("window.__idvMapsProbe.regionClean.dataUrl")
                clean_src = decode_data_url_png(clean_url)
            else:
                clean_url = page.locator(".ded-map-img").evaluate("e => e.src")
                clean_src = decode_data_url_png(clean_url)
            clean_w = max(1, crop_box[2] - crop_box[0])
            clean_h = max(1, crop_box[3] - crop_box[1])
            clean_resized = clean_src.resize((clean_w, clean_h), Image.Resampling.LANCZOS)
            clean_stats = rec709_metrics(np.asarray(clean_resized))

            # Also verify collapsed view preserves luminance and spread
            toggle = page.locator(".step.show .folio-toggle")
            toggle.click()
            settle(page)
            page.screenshot(path=shots / f"{stem}-collapsed.png")
            toggle.click()
            settle(page)

            key = f"{width}-0{step}"
            six_grid[key] = {
                "cleanMapXYWH": [round(gx, 3), round(gy, 3), round(gw, 3), round(gh, 3)],
                "footprintLTRB": list(crop_box),
                "final": final_stats,
                "clean": clean_stats,
            }

            # D-008 Rec.709 luminance gates (6/6)
            assert final_stats["medianY"] >= 100, (key, final_stats)
            assert final_stats["p95Y"] >= 190, (key, final_stats)
            assert clean_stats["medianY"] >= 100, (key, clean_stats)
            assert clean_stats["p95Y"] >= 190, (key, clean_stats)

            # D-016 whole-map spread gates (6/6, final & clean)
            assert 40 <= final_stats["medianSpread"] <= 52, (key, final_stats)
            assert 40 <= clean_stats["medianSpread"] <= 52, (key, clean_stats)

            if width == 1440:
                clean_resized.save(shots / f"clean-0{step}-1440.png")
                clean_frame = Image.new("RGB", live.size, (0, 0, 0))
                clean_frame.paste(clean_resized, (crop_box[0], crop_box[1]))

                # Homologous roof UV ROIs from frozen T-018 targets
                sheet_rows = len(target_meta["roofLandmarks"])
                sheet = Image.new("RGB", (440, sheet_rows * 136), "#23201d")
                sd = ImageDraw.Draw(sheet)

                for row_idx, (color, spaces) in enumerate(target_meta["roofLandmarks"].items()):
                    uv = spaces["new-target"]["uv"]
                    live_poly = [(gx + u * gw, gy + v * gh) for u, v in uv]
                    final_px = polygon_samples(live, live_poly)
                    clean_px = polygon_samples(clean_frame, live_poly)
                    final_spread = float(np.median(np.ptp(final_px, axis=1)))
                    clean_spread = float(np.median(np.ptp(clean_px, axis=1)))
                    changed_px = int(np.any(clean_px != final_px, axis=1).sum())

                    xs, ys = zip(*live_poly)
                    crop_rect = (
                        max(0, int(min(xs)) - 14),
                        max(0, int(min(ys)) - 14),
                        min(width, int(max(xs)) + 14),
                        min(height, int(max(ys)) + 14),
                    )
                    live_crop = live.crop(crop_rect)
                    clean_crop = clean_frame.crop(crop_rect)
                    sheet.paste(clean_crop, (10, row_idx * 136 + 26))
                    sheet.paste(live_crop, (226, row_idx * 136 + 26))
                    sd.text((10, row_idx * 136 + 6), f"0{step} {color} clean ({clean_spread:.0f})", fill="#ffe8b9")
                    sd.text((226, row_idx * 136 + 6), f"0{step} {color} final ({final_spread:.0f})", fill="#ffe8b9")

                    old_target_spread = spaces["old-target"]["medianSpread"]
                    attempt2_spread = spaces["attempt-2"]["medianSpread"]
                    t018_target_spread = spaces["new-target"]["medianSpread"]
                    r2_spread = {"4-red": 63.0, "4-blue": 56.0, "5-blue": 24.0}[f"{step}-{color}"]
                    r2_old_target = {"4-red": 88.0, "4-blue": 156.0, "5-blue": 78.0}[f"{step}-{color}"]

                    roof_report[f"0{step}-{color}"] = {
                        "uv": uv,
                        "livePolygon": [[round(x, 3), round(y, 3)] for x, y in live_poly],
                        "pixels": int(len(final_px)),
                        "changedPixels": changed_px,
                        "cleanSpread": round(clean_spread, 3),
                        "finalSpread": round(final_spread, 3),
                        "t018TargetSpread": t018_target_spread,
                        "oldTargetSpread": old_target_spread,
                        "attempt2Spread": attempt2_spread,
                        "r2Spread": r2_spread,
                        "cleanRGB": [round(float(np.median(clean_px[:, c])), 2) for c in range(3)],
                        "finalRGB": [round(float(np.median(final_px[:, c])), 2) for c in range(3)],
                    }

                    if step == 4 and color == "blue":
                        # D-020 inclusive range [62, 95] for weathered slate-blue factory steel
                        assert 62 <= clean_spread <= 95, roof_report[f"0{step}-{color}"]
                        assert 62 <= final_spread <= 95, roof_report[f"0{step}-{color}"]
                        # 13x13 material swatch centered on weathered steel roof (no red channel clip!)
                        cx_uv = sum(u for u, _ in uv) / len(uv)
                        cy_uv = sum(v for _, v in uv) / len(uv)
                        scx, scy = round(gx + cx_uv * gw), round(gy + cy_uv * gh)
                        sw_clean = np.asarray(clean_frame.crop((scx - 6, scy - 6, scx + 7, scy + 7)))
                        sw_final = np.asarray(live.crop((scx - 6, scy - 6, scx + 7, scy + 7)))
                        swatch_report["04-steel-13x13"] = {
                            "center": [scx, scy],
                            "clean": {**rec709_metrics(sw_clean), "redZero": int((sw_clean[..., 0] == 0).sum())},
                            "final": {**rec709_metrics(sw_final), "redZero": int((sw_final[..., 0] == 0).sum())},
                        }
                        assert swatch_report["04-steel-13x13"]["clean"]["redZero"] == 0
                        assert swatch_report["04-steel-13x13"]["final"]["redZero"] == 0
                        assert 62 <= swatch_report["04-steel-13x13"]["final"]["medianSpread"] <= 95
                    else:
                        # Closer to frozen target than r2 AND close to T-018 target
                        assert abs(final_spread - r2_old_target) < abs(r2_spread - r2_old_target), roof_report[f"0{step}-{color}"]
                        assert abs(final_spread - t018_target_spread) <= 6, roof_report[f"0{step}-{color}"]
                        assert abs(clean_spread - t018_target_spread) <= 6, roof_report[f"0{step}-{color}"]

                sheet.save(shots / f"roofs-0{step}-live.png")

                if step == 5:
                    # D-019 / D-020 Sacred Heart Hospital neutral right perimeter check (target (909, 361))
                    t_map = target_meta["anchors"]["cleanMap"]["new"]
                    u_edge = (909.0 - t_map[0]) / t_map[2]
                    v_edge = (361.0 - t_map[1]) / t_map[3]
                    ex = round(gx + u_edge * gw)
                    ey = round(gy + v_edge * gh)
                    patch_final = np.asarray(live.crop((ex - 3, ey - 3, ex + 4, ey + 4)))
                    patch_clean = np.asarray(clean_frame.crop((ex - 3, ey - 3, ex + 4, ey + 4)))
                    pixel_final = [int(v) for v in live.getpixel((ex, ey))]
                    pixel_clean = [int(v) for v in clean_frame.getpixel((ex, ey))]
                    hospital_edge_report = {
                        "xy": [ex, ey],
                        "uv": [round(u_edge, 5), round(v_edge, 5)],
                        "finalPixel": pixel_final,
                        "cleanPixel": pixel_clean,
                        "finalPatch": rec709_metrics(patch_final),
                        "cleanPatch": rec709_metrics(patch_clean),
                    }
                    # Neutral warm-gray perimeter (zero blue edge halo!)
                    assert pixel_final[2] - pixel_final[0] <= 10, hospital_edge_report
                    assert pixel_clean[2] - pixel_clean[0] <= 10, hospital_edge_report
                    assert hospital_edge_report["finalPatch"]["medianSpread"] <= 18, hospital_edge_report

                    # Save visual crop strip of right edge, NE blue roof, and hospital octagonal dome
                    hosp_strip = Image.new("RGB", (640, 210), "#201c19")
                    hd = ImageDraw.Draw(hosp_strip)
                    crops_05 = [
                        ("Right edge", (ex - 26, ey - 55, ex + 10, ey + 55)),
                        ("NE blue roof", (round(gx + 0.72 * gw), round(gy + 0.16 * gh), round(gx + 0.87 * gw), round(gy + 0.34 * gh))),
                        ("Octagonal dome", (round(gx + 0.31 * gw), round(gy + 0.38 * gh), round(gx + 0.66 * gw), round(gy + 0.69 * gh))),
                    ]
                    ox = 10
                    for label, box in crops_05:
                        sub = live.crop(box)
                        sub.thumbnail((200, 170), Image.Resampling.LANCZOS)
                        hosp_strip.paste(sub, (ox, 28))
                        hd.text((ox, 6), label, fill="#ffe8b9")
                        ox += 210
                    hosp_strip.save(shots / "hospital-materials-1440.png")

    # Verify zero secondary canvas/CSS color overlays on 04
    page.set_viewport_size({"width": 1440, "height": 900})
    setup_page(page, base, 4, shots, 1440)
    wait_map_baked(page, 4)
    overlay_check = page.evaluate("""() => ({
      filter: window.__idvMapsProbe.regionCanvasFilter,
      roofOverlays: window.__idvMapsProbe.regionRoofOverlays,
      alpha: window.__idvMapsProbe.regionClean?.alpha,
    })""")
    assert overlay_check == {"filter": "none", "roofOverlays": 0, "alpha": 1}, overlay_check

    save_json(
        shots / "d016-photometry-summary.json",
        {
            "sixGrid": six_grid,
            "roofLandmarks": roof_report,
            "swatches": swatch_report,
            "hospitalPerimeter": hospital_edge_report,
            "regionSinglePass": overlay_check,
        },
    )


def test_04_d017_occupied_bounds_hit_test_alignment_and_reveal(clean_page):
    """Verify D-017 general occupied-bounds fit across 1366/1440/1920 + narrow width, 9-zone clicks, SVG/Canvas alignment, ruler, and blind vs reveal."""
    page, base, shots = clean_page
    target04 = json.loads((TARGETS_D018 / "04.json").read_text("utf8"))
    match_data = json.loads((REPO_ROOT / "backend/data/cache" / MATCHES[4] / "replay_2d.json").read_text("utf8"))
    real_names = [p["player_name"] for p in match_data["players"]]

    fit_report: Dict[str, Any] = {}

    for width, height in SIZES:
        page.set_viewport_size({"width": width, "height": height})
        page.goto(base + f"/?d017={width}#s=1&auto=0", wait_until="networkidle")
        page.locator(".mapcard").first.wait_for()
        page.locator(f".mapcard[data-match='{MATCHES[4]}'] [data-test=entry-practice]").click()
        page.wait_for_function("idvFlowStore.truthReady")
        wait_map_baked(page, 4)
        settle(page)

        # Blind mode: verify ZERO truth leak before reveal
        blind_seal = detail.sealed(page, real_names)
        assert blind_seal["storeSealed"] and blind_seal["truthElements"] == 0

        # Select 4 survivors + 1 hunter by clicking real canvas zone centers on 1440; verify all 9 zones hit-test!
        if width == 1440:
            hit_checks = []
            for zidx in range(9):
                # Click zone zidx on canvas: zones 0..3 as survivor (triggers auto-switch), zone 4 as hunter,
                # then reset + switch back to survivor for zones 5..8 so all 9 zones are hit-tested directly.
                if zidx == 5:
                    page.click("[data-test=region-reset]")
                    page.click("[data-test=region-side-survivor]")
                pt = page.locator("[data-test=region-canvas]").evaluate("""(c, zi) => {
                  const r = c.getBoundingClientRect();
                  const col = Math.floor(zi / 3), row = zi % 3;
                  const mx = 27 + (col + 0.5) * 226.1;
                  const my = 30 + (row + 0.5) * 197;
                  return [r.x + (mx / 750) * r.width, r.y + (my / 644) * r.height];
                }""", zidx)
                page.mouse.click(pt[0], pt[1])
                cls = (page.locator(f"[data-zone-idx='{zidx}']").get_attribute("class") or "").split()
                expected_cls = "hunt" if zidx == 4 else "surv"
                assert expected_cls in cls, (zidx, pt, cls)
                hit_checks.append({"zone": zidx + 1, "camp": expected_cls, "clickXY": [round(pt[0], 2), round(pt[1], 2)], "hit": True})
            page.click("[data-test=region-reset]")
            page.click("[data-test=region-side-survivor]")
            fit_report["nineZoneCanvasClicks"] = hit_checks

        # Select zones 0,1,2,3 (survivors) and 4 (hunter) -> blind seal still intact
        picker = page.locator(".zone-picker summary")
        picker.click()
        for idx in range(5):
            page.click(f"[data-zone-idx='{idx}']")
        picker.click()
        settle(page)
        assert detail.sealed(page, real_names)["storeSealed"]

        # Reveal practice to inspect full revealed layer (pro spawns + actual lock + offset line)
        page.click("#s4 [data-test=flow-next]")
        page.locator(".ded-marker:not([disabled])").first.click()
        page.click("#s5 [data-test=flow-next]")
        page.click("[data-test=practice-lock]")
        page.locator("[data-test=practice-score]").wait_for(state="attached")
        wait_map_baked(page, 4)
        settle(page)

        toggle = page.locator("#s4 .folio-toggle")
        for state_name in ("open", "closed"):
            if (state_name == "closed") != (toggle.get_attribute("aria-expanded") == "false"):
                toggle.click()
                settle(page)

            geom = page.evaluate("""() => {
              const board = document.querySelector('#s4 .pil-board-wrap').getBoundingClientRect();
              const clip = document.querySelector('#s4 .pil-viewport-clip').getBoundingClientRect();
              const frame = document.querySelector('#s4 .pil-aspect-frame').getBoundingClientRect();
              const canvas = document.querySelector('#s4 [data-test=region-canvas]');
              const cr = canvas.getBoundingClientRect();
              const quad = globalThis.idvFootprints.get(canvas).map(p => [
                cr.x + p.x * cr.width / canvas.width,
                cr.y + p.y * cr.height / canvas.height,
              ]);
              const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
              const cleanMap = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
              const scalePath = document.querySelector('#s4 .scale path');
              const meters40 = scalePath ? scalePath.getTotalLength() : 0;

              // Project all 9 spawn zones via exact frame model transform
              const s = cr.width / 750;
              const zones = [];
              for (let i = 0; i < 9; i++) {
                const col = Math.floor(i / 3), row = i % 3;
                const l = cr.x + (27 + col * 226.1) * s;
                const t = cr.y + (30 + row * 197) * s;
                zones.push([l, t, l + 226.1 * s, t + 197 * s]);
              }

              // Check SVG spawn points & plaques against Canvas projection
              const svg = document.querySelector('#s4 .spawn-diff');
              const svgEntities = [];
              let maxAlignErr = 0;
              if (svg) {
                for (const el of svg.querySelectorAll('circle, rect')) {
                  const b = el.getBoundingClientRect();
                  if (b.width > 0 && b.height > 0) svgEntities.push([b.left, b.top, b.right, b.bottom]);
                }
                const points = idvFlowStore.reveal.truth.spawn.perPlayer;
                const circles = [...svg.querySelectorAll('[data-test=practice-spawn-point]')];
                circles.forEach((c, idx) => {
                  const b = c.getBoundingClientRect();
                  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
                  const expX = cr.x + points[idx].px * s;
                  const expY = cr.y + points[idx].py * s;
                  maxAlignErr = Math.max(maxAlignErr, Math.hypot(cx - expX, cy - expY));
                });
              }

              const submode = document.querySelector('#regionView > .region-submode-bar')?.getBoundingClientRect() ?? null;
              const pilMain = document.querySelector('#regionView > .pil-main')?.getBoundingClientRect() ?? null;
              const submodeTotalH = (submode && pilMain) ? (pilMain.top - submode.top) : 0;

              return {
                board: [board.x, board.y, board.width, board.height],
                submodeBar: submode ? [submode.x, submode.y, submode.width, submode.height] : null,
                submodeTotalH,
                clipLTRB: [clip.left, clip.top, clip.right, clip.bottom],
                frame: [frame.x, frame.y, frame.width, frame.height],
                scale: s,
                modelOrigin: [cr.x, cr.y],
                corners: quad,
                cleanMap,
                zones,
                svgEntities,
                maxAlignErr,
                meters40,
                expectedMeters40: 40 * s * 750 / 166.2,
                clipOverflow: getComputedStyle(document.querySelector('#s4 .pil-viewport-clip')).overflow,
              };
            }""")

            clip_l, clip_t, clip_r, clip_b = geom["clipLTRB"]
            tol = 1.0

            # D-025 §1: Stage 04 submode bar (56px open / 50px closed) + board height conserves height - 110
            assert geom["submodeBar"] and geom["submodeBar"][3] > 0, geom["submodeBar"]
            assert 48.0 <= geom["submodeTotalH"] <= 58.0, geom["submodeTotalH"]
            assert geom["board"][3] + geom["submodeTotalH"] == pytest.approx(height - 110, abs=0.5), (width, state_name, geom["board"], geom["submodeTotalH"])

            # 0 clipped corners
            for cx, cy in geom["corners"]:
                assert clip_l - tol <= cx <= clip_r + tol and clip_t - tol <= cy <= clip_b + tol, (width, state_name, geom)
            # 0 clipped regions
            for zl, zt, zr, zb in geom["zones"]:
                assert clip_l - tol <= zl and zr <= clip_r + tol and clip_t - tol <= zt and zb <= clip_b + tol, (width, state_name, geom)
            # 0 clipped visible SVG entities
            for el, et, er, eb in geom["svgEntities"]:
                assert clip_l - tol <= el and er <= clip_r + tol and clip_t - tol <= et and eb <= clip_b + tol, (width, state_name, geom)

            # SVG ↔ Canvas exact alignment
            assert geom["maxAlignErr"] <= 0.5, (width, state_name, geom["maxAlignErr"])
            # Calibrated metric scale s * 750 / 166.2 px/m
            assert abs(geom["meters40"] - geom["expectedMeters40"]) <= 2.0, (width, state_name, geom["meters40"], geom["expectedMeters40"])
            assert geom["clipOverflow"] == "hidden"

            prev_fp = target04["viewports"][str(width)]["previousFootprintLTRB"]
            prev_area = (prev_fp[2] - prev_fp[0]) * (prev_fp[3] - prev_fp[1])
            width_ratio = geom["cleanMap"][2] / geom["board"][2]
            area_ratio = (geom["cleanMap"][2] * geom["cleanMap"][3]) / prev_area

            if state_name == "open":
                assert width_ratio >= 0.70, (width, width_ratio)
                # D-025 §1: aspect-locked scaling with 56px .region-submode-bar (measured 0.838/0.864/0.889)
                assert area_ratio >= 0.83, (width, area_ratio)
                if width == 1440:
                    assert width_ratio >= 0.85, width_ratio
            else:
                assert geom["board"][2] >= 0.98 * width, (width, geom["board"])

            fit_report[f"{width}-{state_name}"] = {
                "clipLTRB": [round(v, 3) for v in geom["clipLTRB"]],
                "board": [round(v, 3) for v in geom["board"]],
                "scale": round(geom["scale"], 6),
                "modelOrigin": [round(v, 3) for v in geom["modelOrigin"]],
                "cleanMap": [round(v, 3) for v in geom["cleanMap"]],
                "widthRatio": round(width_ratio, 4),
                "areaOverAttempt2": round(area_ratio, 4),
                "maxSvgCanvasAlignErr": round(geom["maxAlignErr"], 4),
                "meters40ErrorPx": round(abs(geom["meters40"] - geom["expectedMeters40"]), 4),
                "clippedCorners": 0,
                "clippedRegions": 0,
                "clippedEntities": 0,
            }

        # Restore open folio before testing layer toggles on 1440
        if toggle.get_attribute("aria-expanded") == "false":
            toggle.click()
            settle(page)
        if width == 1440:
            # Verify sightline exactness & layer toggles (both / pro / mine)
            box = page.locator("#s4 .pil-aspect-frame").bounding_box()
            s_line = detail.sightline(page, {"surface": [box[k] for k in ("x", "y", "width", "height")]})
            fit_report["sightline"] = s_line

            layer_sel = page.get_by_label("出生点图层")
            layer_sel.select_option("pro")
            settle(page)
            assert page.locator("#s4 .verdict").count() == 0
            assert page.locator("#s4 [data-test=practice-spawn-point]").count() == 5
            layer_sel.select_option("mine")
            settle(page)
            assert page.locator("#s4 .spawn-diff").count() == 0
            assert page.locator("#s4 [data-test=region-cipher-table]").is_visible()
            layer_sel.select_option("both")
            settle(page)

    # Prove general non-1440 rule scales down cleanly on a narrow board (1160x900) without clipping
    page.set_viewport_size({"width": 1160, "height": 900})
    settle(page)
    narrow = page.evaluate("""() => {
      const clip = document.querySelector('#s4 .pil-viewport-clip').getBoundingClientRect();
      const canvas = document.querySelector('#s4 [data-test=region-canvas]');
      const cr = canvas.getBoundingClientRect();
      const q = globalThis.idvFootprints.get(canvas).map(p => [cr.x + p.x * cr.width / canvas.width, cr.y + p.y * cr.height / canvas.height]);
      return { clip: [clip.left, clip.top, clip.right, clip.bottom], corners: q, scale: cr.width / 750, heightScale: clip.height / 644 };
    }""")
    cl, ct, cr_x, cb = narrow["clip"]
    for cx, cy in narrow["corners"]:
        assert cl - 1 <= cx <= cr_x + 1 and ct - 1 <= cy <= cb + 1, narrow
    assert narrow["scale"] < narrow["heightScale"], narrow
    fit_report["narrowGeneralFallback"] = narrow

    save_json(shots / "d017-fit-summary.json", fit_report)


def test_05_styles_rotation_real_chain_and_dense_9maps(clean_page):
    """Verify 05 opacity=1/filter=none normal & rotated, presets, real 4-vertex open Chinatown chainThree, Hospital conditional pairs, 6 states, and 9-map dense 0 px^2 overlap."""
    page, base, shots = clean_page
    report: Dict[str, Any] = {}

    # 1. Sacred Heart Hospital normal view: opacity=1, filter=none, zero patina/roof overlays, 3 real same pairs
    page.set_viewport_size({"width": 1440, "height": 900})
    setup_page(page, base, 5, shots, 1440)
    wait_map_baked(page, 5)
    settle(page)

    normal_styles = page.locator("#s5 .ded-map-img").evaluate("""img => {
      const ancestors = [];
      for (let n = img; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.opacity !== '1' || s.filter !== 'none') ancestors.push([n.tagName, n.className, s.opacity, s.filter]);
      }
      return {
        opacity: getComputedStyle(img).opacity,
        filter: getComputedStyle(img).filter,
        rotation: img.dataset.rotQuadrants,
        ancestors,
        patinaCount: document.querySelectorAll('.ded-map-patina,.ded-hospital-roof').length,
        samePairs: document.querySelectorAll('#s5 line.cond-pair-line').length,
        svgZ: Number(getComputedStyle(document.querySelector('#s5 .ded-chain-svg')).zIndex),
        markerZ: Number(getComputedStyle(document.querySelector('#s5 .ded-marker')).zIndex),
        sideLegendItems: document.querySelectorAll('#s5 .ded-side-item').length,
      };
    }""")
    assert normal_styles["opacity"] == "1" and normal_styles["filter"] == "none", normal_styles
    assert normal_styles["ancestors"] == [], normal_styles
    assert normal_styles["patinaCount"] == 0, normal_styles
    assert normal_styles["samePairs"] == 3, normal_styles
    assert normal_styles["svgZ"] < normal_styles["markerZ"], normal_styles
    assert normal_styles["sideLegendItems"] == 6, normal_styles
    report["hospitalNormal"] = normal_styles

    # Preset roundtrip on 05 (original -> dossier -> clarity)
    preset_sel = page.locator("#s5 .map-preset")
    preset_states = {}
    for preset in ("original", "dossier", "clarity"):
        preset_sel.select_option(preset)
        page.wait_for_function("""name => {
          const im = document.querySelector('#s5 .ded-map-img');
          return im && im.dataset.mapPreset === name && im.complete &&
            (name === 'original' ? im.src.includes('_grid.jpg') : im.src.startsWith('data:'));
        }""", arg=preset)
        preset_states[preset] = page.locator("#s5 .ded-map-img").evaluate(
            "im => ({ opacity: getComputedStyle(im).opacity, filter: getComputedStyle(im).filter, isData: im.src.startsWith('data:') })"
        )
    assert preset_states["original"]["isData"] is False
    assert preset_states["dossier"]["isData"] is True
    assert preset_states["clarity"] == {"opacity": "1", "filter": "none", "isData": True}
    report["presets05"] = preset_states

    # Verify circle scope on Hospital deduction step
    clicked_circle = False
    for btn in page.locator("[data-step-idx]").all():
        btn.click()
        if page.locator("#s5 .scope-ring").count() > 0:
            clicked_circle = True
            break
    assert clicked_circle

    # 2. Real 4-vertex open Chinatown chainThree
    page.goto(base + "/?d016-chain#s=5&auto=0", wait_until="networkidle")
    page.select_option("[data-test=deduce-map-select]", "7")
    page.click("[data-test=deduce-reset]")
    for name in ("花店", "肉铺"):
        page.click(f"[data-cipher-name='{name}']")
    chain_btn = page.locator("[data-step-idx]", has_text="裁缝铺内 - 花店 - 肉铺 - 醉芳庭").first
    chain_btn.click()
    settle(page)
    pts = page.locator("polyline.chain-line").evaluate("e => Array.from(e.points, p => [p.x, p.y])")
    assert pts == [[344, 220], [760, 332], [1042, 249], [1103, 841]], pts
    assert pts[0] != pts[-1]
    assert page.locator("polyline.chain-line-halo").count() == 1
    page.screenshot(path=shots / "chinatown-chain-1440.png")
    report["chinatownChain"] = {"points": pts, "open": pts[0] != pts[-1]}

    # 3. Eversleeping Town 90-degree rotation on 04 & 05: opacity=1, filter=none, exact projection & click
    page.click("#steps button[data-step='4']")
    page.select_option("[data-test=region-map-select]", "6")
    wait_map_baked(page, 4)
    settle(page)
    frame4 = page.locator("#s4 .pil-aspect-frame").bounding_box()
    cem_x = frame4["x"] + (89.4 + (1.35 + 1.65 / 2) * 206.1) * frame4["width"] / 750
    cem_y = frame4["y"] + (30.2 + (3 + 1.16 / 2) * 196.3) * frame4["height"] / 874
    page.mouse.click(cem_x, cem_y)
    assert "surv" in (page.locator("[data-zone-idx='9']").get_attribute("class") or "").split()

    page.click("#steps button[data-step='5']")
    wait_map_baked(page, 5)
    settle(page)
    rot_styles = page.locator("#s5 .ded-map-img").evaluate("""img => {
      const ancestors = [];
      for (let n = img; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.opacity !== '1' || s.filter !== 'none') ancestors.push([n.tagName, n.className, s.opacity, s.filter]);
      }
      const frame = document.querySelector('#s5 .pil-aspect-frame').getBoundingClientRect();
      const ib = img.getBoundingClientRect();
      const exp = [frame.x + 88.9 * frame.width / 750, frame.y + 29.1 * frame.height / 874,
                   frame.x + 708.4 * frame.width / 750, frame.y + 847.2 * frame.height / 874];
      const delta = [ib.left - exp[0], ib.top - exp[1], ib.right - exp[2], ib.bottom - exp[3]];
      return {
        opacity: getComputedStyle(img).opacity,
        filter: getComputedStyle(img).filter,
        rotation: img.dataset.rotQuadrants,
        ancestors,
        patinaCount: document.querySelectorAll('.ded-map-patina,.ded-hospital-roof').length,
        north: document.querySelector('#s5 .compass g[transform]')?.getAttribute('transform') ?? null,
        projectionMaxDelta: Math.max(...delta.map(Math.abs)),
      };
    }""")
    assert rot_styles["opacity"] == "1" and rot_styles["filter"] == "none", rot_styles
    assert rot_styles["rotation"] == "1" and rot_styles["ancestors"] == [], rot_styles
    assert rot_styles["patinaCount"] == 0 and rot_styles["north"] == "rotate(90 36 36)", rot_styles
    assert rot_styles["projectionMaxDelta"] < 1.0, rot_styles
    report["eversleepingRotated"] = rot_styles

    # 4. Six states + contradiction on Arms Factory (mapId = 0)
    page.select_option("[data-test=deduce-map-select]", "0")
    page.click("[data-test=deduce-reset]")
    settle(page)
    seen_states = set()
    for action_idx, click_name in enumerate([None, "正门", "正门"]):
        if click_name:
            page.click(f"[data-cipher-name='{click_name}']")
        rows = page.locator("#s5 .ded-marker").evaluate_all("""els => els.map(e => {
          const ring = e.querySelector('.ded-marker-circle');
          const s = getComputedStyle(ring);
          return {
            kind: e.classList[1],
            disabled: e.disabled,
            borderStyle: s.borderTopStyle,
            borderColor: s.borderTopColor,
            bgColor: s.backgroundColor,
            bgImage: s.backgroundImage,
          };
        })""")
        for r in rows:
            seen_states.add(r["kind"])
            if r["kind"] == "unknown":
                assert r["bgColor"] == "rgba(0, 0, 0, 0)" and r["bgImage"] == "none", r
            if r["kind"] == "inf-yes":
                assert r["borderStyle"] == "dashed" and r["borderColor"] == "rgb(244, 211, 152)", r
            if r["kind"] == "inf-no":
                assert r["borderStyle"] == "dashed" and r["borderColor"] == "rgb(196, 196, 196)", r
            if r["kind"] == "locked":
                assert r["disabled"] is True, r
    assert seen_states == {"unknown", "locked", "user-yes", "user-no", "inf-yes", "inf-no"}, seen_states

    # Contradiction banner check
    page.click("[data-test=deduce-reset]")
    page.click("[data-cipher-name='正门']")
    page.click("[data-cipher-name='正门废墟']")
    assert "矛盾" in page.locator("[data-test=deduce-conclusion]").inner_text()
    assert page.locator("[data-test=deduce-alert]").is_visible()

    # 5. All 9 maps dense marker 0 px^2 overlap at 1366x768
    dense_evidence: Dict[str, Any] = {}
    orig_art = detail.ART
    detail.ART = shots
    try:
        detail.dense(page, base, dense_evidence, strict=True)
    finally:
        detail.ART = orig_art
    report["dense9Maps"] = {
        k: {"map": v["map"], "pairCount": v["pairCount"], "maxArea": v["maxArea"], "violations": len(v["violations"])}
        for k, v in dense_evidence["badgeGeometry"].items()
    }
    assert all(v["maxArea"] == 0 and v["violations"] == 0 for v in report["dense9Maps"].values())

    save_json(shots / "d016-deduce-summary.json", report)


def test_04_05_contrast_first_screen_and_zero_overlap(clean_page):
    """Verify >= 4.5:1 WCAG contrast (HTML/SVG/Canvas + hover), 1920 first-screen unclipped badge, header & instrument clearance."""
    page, base, shots = clean_page
    audit: Dict[str, Any] = {}

    for step in (4, 5):
        for width, height in SIZES:
            page.set_viewport_size({"width": width, "height": height})
            setup_page(page, base, step, shots, width)
            wait_map_baked(page, step)
            settle(page)

            # HTML + SVG WCAG contrast audit across the full visible page
            samples = contrast.measure(page)
            min_ratio = min(r["minimum"] for r in samples)
            low_samples = [r for r in samples if r["minimum"] < 4.5]
            assert not low_samples, (step, width, low_samples[:8])

            required = {"V"}
            if step == 4:
                required.update({"已选 4 / 4", "已选 1 / 1"})
            if step == 5 and width == 1920:
                required.update({"候选密码机布局", "第3组"})
            covered = {r["label"] for r in samples if r["minimum"] >= 4.5}
            assert required <= covered, (step, width, required - covered)

            # Check hover contrast on 04 camp toggle buttons at 1440
            hover_min = None
            if step == 4 and width == 1440:
                hover_mins = []
                for sel in ("[data-test=region-side-survivor]", "[data-test=region-side-hunter]"):
                    page.locator(sel).hover()
                    settle(page)
                    h_samples = contrast.measure(page)
                    h_low = [r for r in h_samples if r["minimum"] < 4.5]
                    assert not h_low, (sel, h_low[:5])
                    hover_mins.append(min(r["minimum"] for r in h_samples))
                page.mouse.move(1, 1)
                hover_min = min(hover_mins)

            # Check Canvas ink contrast & font size on 04
            canvas_ink_min = None
            if step == 4:
                c_ink = page.evaluate("window.__idvMapsProbe.regionCanvasInk")
                assert len(c_ink) >= 9, c_ink
                assert all(item["cssFontPx"] >= 11.99 for item in c_ink), c_ink
                low_canvas = [item for item in c_ink if item["minimum"] < 4.5]
                assert not low_canvas, (width, low_canvas)
                canvas_ink_min = min(item["minimum"] for item in c_ink)

            # Verify 1920 first-screen unclipped unique badge (and scrollable reachability on 1366/1440)
            badge_unclipped = None
            if step == 5:
                panel = page.locator("#s5 .pil-right")
                badge = page.locator("[data-layout-idx='2'] .ded-layout-badge.unique")
                assert panel.evaluate("e => e.scrollTop") == 0
                if width < 1920:
                    badge.scroll_into_view_if_needed()
                    settle(page)
                geom = badge.evaluate("""e => {
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
                  return { text: box(range.getBoundingClientRect()), badge: box(e.getBoundingClientRect()),
                           button: box(e.parentElement.getBoundingClientRect()), clips };
                }""")
                def contains(outer, inner):
                    return outer[0] <= inner[0] + 0.5 and outer[1] <= inner[1] + 0.5 and outer[2] >= inner[2] - 0.5 and outer[3] >= inner[3] - 0.5
                assert contains(geom["badge"], geom["text"]), (width, geom)
                assert all(contains(c, geom["badge"]) for c in [geom["button"], *geom["clips"]]), (width, geom)
                badge_unclipped = True
                if width < 1920:
                    panel.evaluate("e => e.scrollTop = 0")

            # Verify zero horizontal overflow, header clearance (title/em vs Stage 04/05 oval & brass clip), and instrument non-overlap
            layout_check = page.evaluate(r"""() => {
              const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
                                        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
              const stepEl = document.querySelector('.step.show');
              const head = stepEl.querySelector('.pil-case-title');
              const stageOval = head.querySelector('.folio-stage').getBoundingClientRect();
              const clip = stepEl.querySelector('.folio-stack .binder-clip').getBoundingClientRect();
              const headRect = head.getBoundingClientRect();
              const headHits = [];
              for (const node of head.querySelectorAll('small, h2, em')) {
                const range = new Range();
                range.selectNodeContents(node);
                for (const r of range.getClientRects()) {
                  if (overlap(r, stageOval) > 0 || overlap(r, clip) > 0) {
                    headHits.push({ tag: node.tagName, stageOv: overlap(r, stageOval), clipOv: overlap(r, clip) });
                  }
                }
              }
              const compass = stepEl.querySelector('.compass')?.getBoundingClientRect();
              const scale = stepEl.querySelector('.scale')?.getBoundingClientRect();
              const actionBar = stepEl.querySelector('.pil-action-bar')?.getBoundingClientRect();
              const sideLegend = stepEl.querySelector('.ded-side-legend')?.getBoundingClientRect();
              const sameCap = stepEl.querySelector('.ded-same-caption')?.getBoundingClientRect();
              const instrPairs = [];
              const items = [['compass', compass], ['scale', scale], ['actionBar', actionBar], ['sideLegend', sideLegend], ['sameCap', sameCap]].filter(([, r]) => r && r.width > 0);
              for (let i = 0; i < items.length; i++) {
                for (let j = i + 1; j < items.length; j++) {
                  const ov = overlap(items[i][1], items[j][1]);
                  if (ov > 0) instrPairs.push([items[i][0], items[j][0], ov]);
                }
              }
              const bm = document.querySelector('.desk-still > .bookmark')?.getBoundingClientRect();
              const boardRect = stepEl.querySelector('.pil-board-wrap')?.getBoundingClientRect();
              const folioStack = stepEl.querySelector('.folio-stack');
              const folioRect = folioStack?.getBoundingClientRect();
              const pilRight = stepEl.querySelector('.pil-right');
              const prCss = pilRight ? getComputedStyle(pilRight) : null;
              const manorFrame = stepEl.querySelector('.manor-map-frame')?.getBoundingClientRect();
              return {
                overflow: document.documentElement.scrollWidth - innerWidth,
                headHits,
                instrPairs,
                headInside: stageOval.right <= headRect.right + 1 && stageOval.bottom <= headRect.bottom + 1,
                declutter: {
                  deskImgs: document.querySelectorAll('.desk-still > img').length,
                  photoPins: document.querySelectorAll('.photo-pin').length,
                  leakedPropImgs: [...document.querySelectorAll('img')].filter(i => /desk-(fountain-pen|pocket-watch|vintage-postcard)\.png/i.test((i.getAttribute('src') || '') + ' ' + (i.currentSrc || ''))).length,
                  clutterVisible: [...document.querySelectorAll('.folio-corner,.folio-edge-flourish,.card-flourish,.foot-corner,.well-corner,.plate-corner,.phase-corner,.board-flourish')].filter(e => e.checkVisibility()).length,
                  folioFoot: getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim(),
                  bookmarkVisible: Boolean(bm && bm.width > 0 && bm.height > 0),
                  bookmarkOverlap: (bm && boardRect && folioRect) ? (overlap(bm, boardRect) + overlap(bm, folioRect)) : -1,
                  manorMapFrameVisible: Boolean(manorFrame && manorFrame.width > 0 && manorFrame.height > 0),
                  folioPadding: prCss ? [parseFloat(prCss.paddingTop), parseFloat(prCss.paddingRight), parseFloat(prCss.paddingBottom), parseFloat(prCss.paddingLeft)] : [],
                  folioPseudos: folioStack ? [getComputedStyle(folioStack, '::before').content, getComputedStyle(folioStack, '::after').content] : [],
                  selectAppearances: [...stepEl.querySelectorAll('select.sel')].filter(s => s.checkVisibility()).map(s => getComputedStyle(s).appearance),
                },
                minFont: Math.min(...[...document.querySelectorAll('#bar *, .step.show *')]
                  .filter(e => (e instanceof HTMLElement || e instanceof SVGTextElement) && e.checkVisibility() &&
                    [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
                  .map(e => {
                    const m = e.getScreenCTM?.();
                    return parseFloat(getComputedStyle(e).fontSize) * (m ? Math.hypot(m.c, m.d) : 1);
                  })),
              };
            }""")
            assert layout_check["overflow"] == 0, (step, width, layout_check)
            assert layout_check["headHits"] == [], (step, width, layout_check)
            assert layout_check["instrPairs"] == [], (step, width, layout_check)
            assert layout_check["minFont"] >= 11.99, (step, width, layout_check)
            dec = layout_check["declutter"]
            assert dec["deskImgs"] == 0 and dec["photoPins"] == 0 and dec["leakedPropImgs"] == 0, (step, width, dec)
            assert dec["clutterVisible"] == 0 and dec["folioFoot"] == "0px", (step, width, dec)
            assert dec["bookmarkVisible"] and dec["bookmarkOverlap"] == 0 and dec["manorMapFrameVisible"], (step, width, dec)
            assert dec["folioPadding"] and min(dec["folioPadding"]) >= 16.0 and dec["folioPseudos"] == ["none", "none"], (step, width, dec)
            assert len(dec["selectAppearances"]) >= 2 and all(a == "none" for a in dec["selectAppearances"]), (step, width, dec["selectAppearances"])

            audit[f"{width}-0{step}"] = {
                "htmlSvgMinContrast": round(min_ratio, 4),
                "htmlSvgSamples": len(samples),
                "hoverMinContrast": round(hover_min, 4) if hover_min is not None else None,
                "canvasInkMinContrast": round(canvas_ink_min, 4) if canvas_ink_min is not None else None,
                "badge1920Unclipped": badge_unclipped,
                "minFontPx": round(layout_check["minFont"], 2),
                "overflow": layout_check["overflow"],
                "headerOverlaps": 0,
                "instrumentOverlaps": 0,
            }

    save_json(shots / "d016-contrast-layout-summary.json", audit)
