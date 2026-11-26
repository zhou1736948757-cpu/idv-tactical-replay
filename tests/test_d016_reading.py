"""D-016 T-021 reading views (01 Archive & 03 Analytics) live Edge audit."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from conftest import CHINATOWN_MATCH, REPO_ROOT
from test_fullstack_e2e import browser_session
from test_phase4_visual import contrast, settle, setup_page

SIZES = [(1366, 768), (1440, 900), (1920, 1080)]
RESULTS = REPO_ROOT / "Workflow/results"
TARGETS = RESULTS / "T-018-art/targets"
CONCEPTS = Path(os.environ.get("IDV_CONCEPT_DIR", r"i:\geminiiii\ui-concepts"))
CONCEPT_FILES = {1: "stage01-archive.png", 3: "stage03-analytics.png"}


def _save_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf8")


def _check_errors(browser_session: dict) -> None:
    errors = browser_session["errors"]
    assert not any(errors[k] for k in ("console", "page", "external", "http", "failed")), errors


def _make_compare_sheet(step: int, shots: Path, live: Image.Image) -> None:
    key = f"{step:02}"
    target = Image.open(TARGETS / f"{key}.png").convert("RGB")
    concept_path = CONCEPTS / CONCEPT_FILES[step]
    panels = []
    if concept_path.is_file():
        concept = Image.open(concept_path).convert("RGB")
        concept.thumbnail((1440, 900), Image.Resampling.LANCZOS)
        panels.append(concept)
    panels.extend([target, live])
    sheet = Image.new("RGB", (1440 * len(panels), 900), "#161e2b")
    for idx, img in enumerate(panels):
        sheet.paste(img, (1440 * idx + (1440 - img.width) // 2, (900 - img.height) // 2))
    sheet.save(shots / f"compare-{key}.jpg", quality=92)
    Image.blend(target, live, 0.5).save(shots / f"overlay-{key}.png")


def _crop_clamped(img: Image.Image, box: tuple[int, int, int, int], out: Path) -> None:
    l = max(0, min(img.width - 1, int(round(box[0]))))
    t = max(0, min(img.height - 1, int(round(box[1]))))
    r = max(l + 1, min(img.width, int(round(box[2]))))
    b = max(t + 1, min(img.height, int(round(box[3]))))
    img.crop((l, t, r, b)).save(out)


def _measure_shell_basics(page) -> dict:
    return page.evaluate(
        """() => {
          const text = [...document.querySelectorAll('#bar *, .step.show *')].filter(
            e => e.getClientRects().length
              && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
              && e.checkVisibility()
          );
          const sizes = text
            .filter(e => e instanceof HTMLElement || e instanceof SVGTextElement)
            .map(e => {
              const m = e.getScreenCTM?.();
              return parseFloat(getComputedStyle(e).fontSize) * (m ? Math.hypot(m.c, m.d) : 1);
            });
          const dimOpacities = text.filter(e => {
            const s = getComputedStyle(e), rgb = s.color.match(/[0-9]+/g);
            return rgb && '#' + rgb.map(n => (+n).toString(16).padStart(2, '0')).join('') === s.getPropertyValue('--dim').trim().toLowerCase();
          }).map(e => {
            let op = 1;
            for (let n = e; n; n = n.parentElement) op *= +getComputedStyle(n).opacity;
            return op;
          });
          const tabs = [...document.querySelectorAll('#steps [data-step]')].map(e => e.getBoundingClientRect());
          return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            stageX: document.querySelector('#stage').getBoundingClientRect().x,
            barHeight: document.querySelector('#bar').getBoundingClientRect().height,
            dpr: devicePixelRatio,
            minFont: Math.min(...sizes),
            dimOpacities: [...new Set(dimOpacities)],
            oneRow: tabs.length === 5 && tabs.every((r, i) => r.y === tabs[0].y && r.right <= innerWidth && (!i || tabs[i - 1].right <= r.left)),
          };
        }"""
    )


ARCHIVE_AUDIT_JS = r"""() => {
  const q = s => document.querySelector(s), all = s => [...document.querySelectorAll(s)];
  const rect = el => {
    if (!el || !el.checkVisibility()) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [r.x, r.y, r.width, r.height] : null;
  };
  const overlapArea = (a, b) => {
    if (!a || !b) return 0;
    const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    return +(x * y).toFixed(3);
  };
  const cards = all('#mapGrid .mapcard');
  const firstFour = cards.slice(0, 4);
  const cardRects = firstFour.map(rect);
  const crossCardOverlaps = [];
  for (let i = 0; i < cardRects.length; i++) {
    for (let j = i + 1; j < cardRects.length; j++) {
      const ov = overlapArea(cardRects[i], cardRects[j]);
      if (ov > 0) crossCardOverlaps.push({ a: i, b: j, area: ov });
    }
  }
  const declutter = {
    deskImgs: all('.desk-still > img').length,
    photoPins: all('.photo-pin').length,
    leakedPropImgs: all('img').filter(i => /desk-(fountain-pen|pocket-watch|vintage-postcard)\.png/i.test((i.getAttribute('src') || '') + ' ' + (i.currentSrc || ''))).length,
    clutterVisible: all('.folio-corner, .folio-edge-flourish, .card-flourish, .foot-corner, .well-corner, .plate-corner, .phase-corner, .board-flourish').filter(rect).length,
    bookmarkBox: rect(q('.desk-still > .bookmark')),
    folioFoot: getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim(),
  };
  const cardDetails = firstFour.map((card, idx) => {
    const cr = rect(card);
    const fig = rect(card.querySelector('figure.photograph'));
    const img = card.querySelector('figure.photograph img');
    const rivet = card.querySelector('.folio-rivet');
    const seal = rect(card.querySelector('.wax-seal'));
    const ctas = [...card.querySelectorAll('.entry-buttons button')].map(btn => {
      const b = rect(btn);
      const cx = b ? b[0] + b[2] / 2 : -1;
      const cy = b ? b[1] + b[3] / 2 : -1;
      const hitEl = b ? document.elementFromPoint(cx, cy) : null;
      return {
        test: btn.dataset.test,
        text: btn.textContent.trim(),
        box: b,
        focusable: btn.tabIndex >= 0,
        hit: Boolean(hitEl && (hitEl === btn || btn.contains(hitEl))),
        overlapSeal: overlapArea(b, seal),
        overlapPhoto: overlapArea(b, fig),
      };
    });
    const ctaCross = ctas.length >= 2 ? overlapArea(ctas[0].box, ctas[1].box) : 0;
    const cs = getComputedStyle(card);
    return {
      index: idx,
      matchId: card.dataset.match,
      box: cr,
      inViewport: Boolean(cr && cr[0] >= 0 && cr[1] >= 60 && cr[0] + cr[2] <= innerWidth && cr[1] + cr[3] <= innerHeight + 0.5),
      photoBox: fig,
      imgLoaded: Boolean(img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0),
      imgSrc: img ? img.getAttribute('src') : null,
      rivetNonInteractive: Boolean(rivet && getComputedStyle(rivet).pointerEvents === 'none'),
      hasParchmentTexture: cs.backgroundImage.includes('parchment-tile.png'),
      hasLayeredShadow: (cs.boxShadow.match(/rgba?\(/g) || []).length >= 2,
      sealBox: seal,
      ctaCross,
      ctas,
    };
  });

  const pickBtn = q('#dropZone .pick');
  const pickRect = rect(pickBtn);
  const pickHitEl = pickRect ? document.elementFromPoint(pickRect[0] + pickRect[2] / 2, pickRect[1] + pickRect[3] / 2) : null;
  const gateImg = q('#dropZone .drop-etching');
  const clipEl = q('.import-stack > .binder-clip');
  const clipRect = rect(clipEl);
  const dropZone = q('#dropZone');
  const dropCss = getComputedStyle(dropZone);
  const importStack = q('.import-stack');
  const boardRect = rect(q('.archive-board'));
  const folioRect = rect(dropZone);
  declutter.bookmarkOverlap = overlapArea(declutter.bookmarkBox, boardRect) + overlapArea(declutter.bookmarkBox, folioRect);

  const anchors = {
    board: boardRect,
    folio: folioRect,
    select: pickRect,
    'brass-clip': clipRect,
    'import-well': rect(q('#dropZone .drop-well')),
    'gate-etching': rect(gateImg),
  };
  const filterLabels = ['全部地图 ▾', '全部模式 ▾', '全部结果 ▾', '搜索玩家 / 地图 / PID', '刷新'];
  filterLabels.forEach((lbl, i) => {
    anchors['filter/' + lbl] = rect(q(`#filters > :nth-child(${i + 2})`));
  });
  firstFour.forEach((card, i) => {
    anchors[`card${i}`] = rect(card);
    anchors[`photo${i}`] = rect(card.querySelector('figure.photograph'));
    anchors[`cta${i}-0`] = rect(card.querySelector('.cta-replay'));
    anchors[`cta${i}-1`] = rect(card.querySelector('.cta-practice'));
  });

  const nonInteractiveCheck = all('.board-flourish, .card-flourish, .foot-corner, .well-corner, .folio-edge-flourish, .folio-rivet, .wax-seal, .binder-clip, .folio-laurel')
    .filter(el => getComputedStyle(el).pointerEvents !== 'none').length;

  const laurelEl = q('#dropZone header .folio-laurel');
  const laurelRect = rect(laurelEl);
  const textRangeBox = el => {
    if (!el) return null;
    const range = new Range();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [r.x, r.y, r.width, r.height] : null;
  };
  const h2TextBox = textRangeBox(q('#dropZone header h2'));
  const emTextBox = textRangeBox(q('#dropZone header em'));

  return {
    totalCards: cards.length,
    crossCardOverlaps,
    cardDetails,
    photoMountStraight: firstFour.every(c => {
      const m = c.querySelector('.photo-mount');
      return Boolean(m && getComputedStyle(m).transform === 'none');
    }),
    selectAppearances: all('#filters select.sel').map(s => getComputedStyle(s).appearance),
    declutter,
    importFolio: {
      box: folioRect,
      hasParchmentTexture: dropCss.backgroundImage.includes('parchment-tile.png'),
      padding: [parseFloat(dropCss.paddingTop), parseFloat(dropCss.paddingRight), parseFloat(dropCss.paddingBottom), parseFloat(dropCss.paddingLeft)],
      stackPseudos: importStack ? [getComputedStyle(importStack, '::before').content, getComputedStyle(importStack, '::after').content] : [],
      hasClip: Boolean(clipRect),
      clipTop: clipRect ? clipRect[1] : null,
      clipNonInteractive: Boolean(clipEl && getComputedStyle(clipEl).pointerEvents === 'none'),
      hasLaurel: Boolean(laurelRect),
      laurelBox: laurelRect,
      laurelNonInteractive: Boolean(laurelEl && getComputedStyle(laurelEl).pointerEvents === 'none'),
      laurelOverlaps: {
        h2: overlapArea(laurelRect, h2TextBox),
        em: overlapArea(laurelRect, emTextBox),
        clip: overlapArea(laurelRect, clipRect),
      },
      pickHit: Boolean(pickHitEl && (pickHitEl === pickBtn || pickBtn.contains(pickHitEl))),
      gateLoaded: Boolean(gateImg && gateImg.complete && gateImg.naturalWidth > 0),
    },
    nonInteractiveViolations: nonInteractiveCheck,
    anchors,
  };
}"""


ANALYTICS_AUDIT_JS = r"""() => {
  const q = s => document.querySelector(s), all = s => [...document.querySelectorAll(s)];
  const rect = el => {
    if (!el || !el.checkVisibility()) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [r.x, r.y, r.width, r.height] : null;
  };
  const overlapArea = (a, b) => {
    if (!a || !b) return 0;
    const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    return +(x * y).toFixed(3);
  };

  const analysisEl = q('#analysis');
  const analysisCss = getComputedStyle(analysisEl);
  const stackEl = q('.analysis-stack');
  const clipEl = q('.analysis-stack > .binder-clip');
  const clipRect = rect(clipEl);
  const folioBox = rect(analysisEl);
  const declutter = {
    deskImgs: all('.desk-still > img').length,
    photoPins: all('.photo-pin').length,
    leakedPropImgs: all('img').filter(i => /desk-(fountain-pen|pocket-watch|vintage-postcard)\.png/i.test((i.getAttribute('src') || '') + ' ' + (i.currentSrc || ''))).length,
    clutterVisible: all('.folio-corner, .folio-edge-flourish, .card-flourish, .foot-corner, .well-corner, .plate-corner, .phase-corner, .board-flourish').filter(rect).length,
    bookmarkBox: rect(q('.desk-still > .bookmark')),
    folioFoot: getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim(),
  };
  declutter.bookmarkOverlap = overlapArea(declutter.bookmarkBox, folioBox);

  const phases = all('#analysis .phase').map((p, idx) => {
    const etch = p.querySelector('.phase-etching');
    const rib = p.querySelector('h3.ribbon-h');
    const stats = [...p.querySelectorAll('.stats div')].map(d => d.textContent.trim());
    return {
      idx,
      phaseId: p.dataset.phase,
      box: rect(p),
      ribbonBox: rect(rib),
      ribbonBg: rib ? getComputedStyle(rib).backgroundImage : '',
      etchingBox: rect(etch),
      etchingBg: etch ? getComputedStyle(etch).backgroundImage : '',
      statCount: stats.length,
      stats,
    };
  });
  const phaseOverlaps = [];
  for (let i = 0; i < phases.length; i++) {
    for (let j = i + 1; j < phases.length; j++) {
      const ov = overlapArea(phases[i].box, phases[j].box);
      if (ov > 0) phaseOverlaps.push({ a: i, b: j, area: ov });
    }
  }

  const axisTexts = all('#analysis svg text').map(t => {
    const m = t.getScreenCTM();
    const b = rect(t);
    return {
      text: t.textContent.trim(),
      cssPx: +(parseFloat(getComputedStyle(t).fontSize) * Math.hypot(m.c, m.d)).toFixed(3),
      box: b,
    };
  });

  const chartSvg = q('[data-test="distance-chart"] svg[role="img"]');
  const chartBox = rect(chartSvg);
  const curvePaths = all('[data-test="distance-chart"] svg[role="img"] path').map(p => ({
    dLen: (p.getAttribute('d') || '').length,
    stroke: p.getAttribute('stroke'),
  }));
  const chaseRects = all('[data-test="distance-chart"] svg[role="img"] rect').filter(r => r.getAttribute('fill') === '#c2654c');

  const jumpBtns = all('[data-test="chart-jumps"] button').map(btn => {
    const b = rect(btn);
    const hitEl = b ? document.elementFromPoint(b[0] + b[2] / 2, b[1] + b[3] / 2) : null;
    return {
      jump: btn.dataset.jump,
      text: btn.textContent.trim(),
      disabled: btn.disabled,
      box: b,
      hit: Boolean(hitEl && (hitEl === btn || btn.contains(hitEl))),
      overlapSvg: overlapArea(b, chartBox),
    };
  });
  const jumpCrossOverlaps = [];
  for (let i = 0; i < jumpBtns.length; i++) {
    for (let j = i + 1; j < jumpBtns.length; j++) {
      const ov = overlapArea(jumpBtns[i].box, jumpBtns[j].box);
      if (ov > 0) jumpCrossOverlaps.push({ a: i, b: j, area: ov });
    }
  }

  const contribPanel = q('.contributions.phase-plate');
  const contribPanelRect = rect(contribPanel);
  const contribRows = all('.contributor').map(row => {
    const b = rect(row);
    return {
      uid: row.dataset.contributor,
      box: b,
    };
  });

  const anchors = {
    folio: folioBox,
    kpis: rect(q('.overview')),
    kpiTitle: rect(q('.overview h2')),
    plot: rect(q('.chart')),
    plotTitle: rect(q('.chart h2')),
    contributions: contribPanelRect,
    tableTitle: rect(q('.contributions h2')),
    'brass-clip': clipRect,
  };
  phases.forEach((p, i) => {
    anchors[`phase${i}`] = p.box;
    anchors[`phaseTitle${i}`] = p.ribbonBox;
    anchors[`phase-etching/${i}`] = p.etchingBox;
  });

  const nonInteractiveViolations = all('.plate-corner, .phase-corner, .phase-etching, .binder-clip')
    .filter(el => getComputedStyle(el).pointerEvents !== 'none').length;

  return {
    declutter,
    folioParchment: analysisCss.backgroundImage.includes('parchment-tile.png'),
    folioPadding: [parseFloat(analysisCss.paddingTop), parseFloat(analysisCss.paddingRight), parseFloat(analysisCss.paddingBottom), parseFloat(analysisCss.paddingLeft)],
    stackPseudos: stackEl ? [getComputedStyle(stackEl, '::before').content, getComputedStyle(stackEl, '::after').content] : [],
    stackShadowLayers: (getComputedStyle(stackEl).boxShadow.match(/rgba?\(/g) || []).length,
    clipBox: clipRect,
    clipNonInteractive: Boolean(clipEl && getComputedStyle(clipEl).pointerEvents === 'none'),
    phases,
    phaseOverlaps,
    phaseMedallionCount: all('#analysis .phase .phase-medallion svg').length,
    headerMapScript: (q('#analysis .header-map-script')?.textContent || '').trim(),
    darkLegacyCount: all('#analysis .dark').length,
    selectAppearances: all('#analysis select.sel').map(s => getComputedStyle(s).appearance),
    kpiIconCount: all('.overview-values svg').length,
    axisTexts,
    curvePaths,
    chaseRectCount: chaseRects.length,
    jumpBtns,
    jumpCrossOverlaps,
    contribRows,
    nonInteractiveViolations,
    anchors,
  };
}"""


def _rendered_ornament_contrast(page) -> list[dict]:
    """Probe rendered contrast for non-interactive/ornamental text (wax seals, ribbons, medallions, brand V)."""
    selector = ".identity i,.wax-seal text,.ribbon-h,.ribbon-h small,.contrib-seal"
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
                : e.closest('.ribbon-h') ? 'ribbon'
                : e.classList.contains('contrib-seal') ? 'medallion'
                : 'brand';
              out.push({ label: n.textContent.trim(), kind, color, rect: [x, y, right, bottom] });
            }
          }
          return out;
        }""",
        selector,
    )

    def probe(color: str) -> np.ndarray:
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
        l, t = max(0, math.floor(x)), max(0, math.floor(y))
        r, b = math.ceil(right), math.ceil(bottom)
        glyph = mask[t:b, l:r]
        if not glyph.any():
            continue
        bg = back[t:b, l:r][glyph]
        lum = contrast.luminance(bg)
        fg = contrast.luminance(np.array(row["color"]))
        ratios = (np.maximum(lum, fg) + 0.05) / (np.minimum(lum, fg) + 0.05)
        j = int(ratios.argmin())
        yy, xx = np.where(glyph)
        result.append(
            dict(
                **row,
                minimum=round(float(ratios[j]), 4),
                xy=[int(l + xx[j]), int(t + yy[j])],
                backing=bg[j].tolist(),
            )
        )
    return sorted(result, key=lambda r: r["minimum"])


def _contains_rect(outer: list[float], inner: list[float], tol: float = 1.0) -> bool:
    return (
        outer[0] - tol <= inner[0]
        and outer[1] - tol <= inner[1]
        and outer[0] + outer[2] + tol >= inner[0] + inner[2]
        and outer[1] + outer[3] + tol >= inner[1] + inner[3]
    )


def _audit_anchors(step: int, shots: Path, measured: dict[str, list[float] | None]) -> list[str]:
    """D-025 §2 clean-folio anchor audit for 01 Archive & 03 Analytics."""
    target = json.loads((TARGETS / f"{step:02}.json").read_text("utf8"))
    rows = []
    failures = []
    board = measured.get("board")
    folio = measured.get("folio")
    if step == 1 and board and folio:
        if abs(board[1] - folio[1]) > 8.0 or abs((board[1] + board[3]) - (folio[1] + folio[3])) > 8.0:
            failures.append(f"01 left/right top-bottom alignment: board={board} folio={folio}")
    for name, got in measured.items():
        if name not in target["anchors"] or got is None:
            continue
        exp = target["anchors"][name]["new"]
        diff = [round(a - b, 3) for a, b in zip(got, exp)]
        if step == 1:
            if name in ("board", "folio"):
                # D-025 §2: horizontal <= 8px, vertical +10px clean breathing room <= 16px
                limit = "D-025:xy<=8,h<=16"
                within = max(abs(diff[0]), abs(diff[1]), abs(diff[2])) <= 8.0 and abs(diff[3]) <= 16.0
            elif name == "brass-clip":
                # D-024 §2.2 compact non-crowding clip inside top-right of folio
                limit = "D-025:compact-clip"
                within = bool(folio and _contains_rect(folio, got, tol=10.0) and max(abs(d) for d in diff) <= 28.0)
            elif name in ("import-well", "gate-etching"):
                limit = "D-025:folio-child<=20"
                within = bool(folio and _contains_rect(folio, got) and max(abs(d) for d in diff) <= 20.0)
            elif name == "select":
                limit = "D-025:folio-cta<=10"
                within = bool(folio and _contains_rect(folio, got) and max(abs(d) for d in diff) <= 10.0)
            else:
                # Cards, photos, CTAs, filters shifted by D-024 §2.2 14px/16px padding & card gap
                limit = "D-025:board-child<=12"
                within = bool(board and _contains_rect(board, got) and max(abs(d) for d in diff) <= 12.0)
        else:
            if name == "folio":
                limit = 8
                within = max(abs(d) for d in diff) <= 8.0
            elif name == "brass-clip" or name.startswith("phase-etching/"):
                limit = "D-025:ornament<=20"
                within = bool(folio and _contains_rect(folio, got, tol=10.0) and max(abs(d) for d in diff) <= 20.0)
            else:
                # D-025 §2: interior plates shifted +14px by 16px 20px folio padding & 14px gap
                limit = "D-025:folio-interior<=18"
                within = bool(
                    folio
                    and _contains_rect(folio, got)
                    and got[0] >= folio[0] + 16.0 - 0.5
                    and (got[0] + got[2]) <= (folio[0] + folio[2] - 16.0 + 0.5)
                    and max(abs(d) for d in diff) <= 18.0
                )
        rows.append([name, exp, [round(v, 3) for v in got], *diff, limit, within])
        if not within:
            failures.append(f"{name}: diff={diff} limit={limit}")
    with (shots / f"anchors-{step:02}.csv").open("w", encoding="utf8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["anchor", "targetXYWH", "actualXYWH", "dx", "dy", "dw", "dh", "limit", "within"])
        w.writerows(rows)
    return failures


@pytest.mark.parametrize("width,height", SIZES)
def test_archive_reading_view(browser_session, screenshot_dir, width, height):
    page, base = browser_session["page"], browser_session["base"]
    page.set_viewport_size({"width": width, "height": height})
    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    setup_page(page, base, 1, screenshot_dir, width)
    settle(page)

    live_path = screenshot_dir / f"{width}-01.png"
    live = Image.open(io.BytesIO(page.screenshot(path=str(live_path)))).convert("RGB")
    shell = _measure_shell_basics(page)
    audit = page.evaluate(ARCHIVE_AUDIT_JS)
    seals = page.evaluate((RESULTS / "T-014-art/geometry.js").read_text("utf8"), "01")
    samples = contrast.measure(page)
    ornament_samples = _rendered_ornament_contrast(page)

    _save_json(screenshot_dir / f"contrast-{width}-01.json", samples)
    _save_json(screenshot_dir / f"ornament-contrast-{width}-01.json", ornament_samples)
    min_contrast = min(row["minimum"] for row in samples)
    min_ornament = min(row["minimum"] for row in ornament_samples)
    payload = dict(
        viewport=[width, height],
        edge=browser_session["browser_version"],
        shell=shell,
        audit=audit,
        seals=seals,
        minimumContrast=min_contrast,
        minimumOrnamentContrast=min_ornament,
        worstContrastRows=samples[:8],
        worstOrnamentRows=ornament_samples[:8],
    )
    anchor_failures = []
    if width == 1440:
        anchor_failures = _audit_anchors(1, screenshot_dir, audit["anchors"])
        payload["anchorFailures"] = anchor_failures
        _make_compare_sheet(1, screenshot_dir, live)
        c0 = audit["anchors"]["card0"]
        _crop_clamped(live, (c0[0] - 8, c0[1] - 8, c0[0] + 225, c0[1] + 265), screenshot_dir / "crop-01-card-corner.png")
        _crop_clamped(live, (c0[0] + 220, c0[1] - 6, c0[0] + c0[2] + 10, c0[1] + c0[3] + 10), screenshot_dir / "crop-01-seal-cta.png")
        folio = audit["anchors"]["folio"]
        _crop_clamped(live, (folio[0] - 8, 60, folio[0] + folio[2] + 10, folio[1] + 280), screenshot_dir / "crop-01-import-clip.png")
    _save_json(screenshot_dir / f"{width}-01.json", payload)

    assert shell["oneRow"] and shell["overflow"] == 0 and shell["stageX"] == 0 and shell["barHeight"] == 60, shell
    assert shell["minFont"] >= 12 and shell["dpr"] == 1 and all(v == 1 for v in shell["dimOpacities"]), shell
    assert audit["totalCards"] >= 4 and len(audit["cardDetails"]) == 4
    assert not audit["crossCardOverlaps"], audit["crossCardOverlaps"]
    assert audit["nonInteractiveViolations"] == 0
    dec = audit["declutter"]
    assert dec["deskImgs"] == 0 and dec["photoPins"] == 0 and dec["leakedPropImgs"] == 0, dec
    assert dec["clutterVisible"] == 0 and dec["folioFoot"] == "0px", dec
    assert dec["bookmarkBox"] and dec["bookmarkBox"][2] > 0 and dec["bookmarkBox"][3] > 0 and dec["bookmarkOverlap"] == 0, dec

    for card in audit["cardDetails"]:
        assert card["inViewport"], card
        assert card["imgLoaded"], card
        assert card["rivetNonInteractive"], card
        assert card["hasParchmentTexture"] and card["hasLayeredShadow"], card
        assert card["ctaCross"] == 0, card
        assert len(card["ctas"]) == 2
        for cta in card["ctas"]:
            assert cta["hit"] and cta["focusable"], cta
            assert cta["box"][3] >= 32, cta
            assert cta["overlapSeal"] == 0 and cta["overlapPhoto"] == 0, cta

    assert len(seals) >= 4
    for s in seals[:4]:
        assert sorted(round(line["cssPx"], 2) for line in s["lines"]) == [13, 14], s
        assert not s["frameOverlap"], s
        assert all(not line["clipped"] and not line["overlap"] for line in s["lines"]), s

    imp = audit["importFolio"]
    assert imp["hasParchmentTexture"] and imp["hasClip"] and imp["clipNonInteractive"], imp
    assert min(imp["padding"][1], imp["padding"][3]) >= 16.0 and min(imp["padding"]) >= (14.0 if height < 820 else 16.0), imp
    assert imp["stackPseudos"] == ["none", "none"], imp
    assert imp["clipTop"] >= 60, imp
    # D-026 §4.1 & §5.1: restored gold V laurel crest in #dropZone header with 0 px^2 overlap
    assert imp["hasLaurel"] and imp["laurelNonInteractive"], imp
    assert imp["laurelOverlaps"] == {"h2": 0, "em": 0, "clip": 0}, imp
    assert audit["photoMountStraight"] and audit["selectAppearances"] == ["none", "none", "none"], audit
    assert imp["pickHit"] and imp["gateLoaded"], imp

    assert min_contrast >= 4.5, samples[:5]
    assert {r["kind"] for r in ornament_samples} >= {"brand", "wax"}
    assert min_ornament >= 4.5, ornament_samples[:5]
    if width == 1440:
        assert not anchor_failures, anchor_failures

    _check_errors(browser_session)


def test_archive_cta_navigation_and_filters(browser_session, screenshot_dir):
    page, base = browser_session["page"], browser_session["base"]
    page.set_viewport_size({"width": 1366, "height": 768})
    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    setup_page(page, base, 1, screenshot_dir, 1366)
    settle(page)

    # Filter checks (including bot/neutral outcome visibility when filtered)
    page.select_option("[data-test='f-mode']", "custom")
    settle(page)
    custom_cards = page.locator("#mapGrid .mapcard")
    assert custom_cards.count() >= 1
    neutral_samples = contrast.measure(page)
    assert min(r["minimum"] for r in neutral_samples) >= 4.5, neutral_samples[:5]
    page.select_option("[data-test='f-mode']", "all")
    settle(page)

    # First 4 cards CTA live click-to-entry verification (Replay -> Step 2, Blind Practice -> Step 4)
    page.locator("#mapGrid .mapcard").first.locator("[data-test='entry-replay']").click()
    page.locator(".board").wait_for()
    assert page.evaluate("idvAppStore.step === 2")

    page.click("#steps button[data-step='1']")
    page.locator("#mapGrid .mapcard").first.wait_for()
    page.locator("#mapGrid .mapcard").first.locator("[data-test='entry-practice']").click()
    page.locator("#regionView").wait_for()
    assert page.evaluate("idvAppStore.step === 4 && idvFlowStore.mode === 'blind'")
    _check_errors(browser_session)


@pytest.mark.parametrize("width,height", SIZES)
def test_analytics_reading_view(browser_session, screenshot_dir, cached_payloads, width, height):
    page, base = browser_session["page"], browser_session["base"]
    page.set_viewport_size({"width": width, "height": height})
    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    setup_page(page, base, 3, screenshot_dir, width)
    settle(page)

    live_path = screenshot_dir / f"{width}-03.png"
    live = Image.open(io.BytesIO(page.screenshot(path=str(live_path)))).convert("RGB")
    shell = _measure_shell_basics(page)
    audit = page.evaluate(ANALYTICS_AUDIT_JS)
    geo = page.evaluate((RESULTS / "T-014-art/geometry.js").read_text("utf8"), "03")
    samples = contrast.measure(page)
    ornament_samples = _rendered_ornament_contrast(page)

    _save_json(screenshot_dir / f"contrast-{width}-03.json", samples)
    _save_json(screenshot_dir / f"ornament-contrast-{width}-03.json", ornament_samples)
    min_contrast = min(row["minimum"] for row in samples)
    min_ornament = min(row["minimum"] for row in ornament_samples)
    payload = dict(
        viewport=[width, height],
        edge=browser_session["browser_version"],
        shell=shell,
        audit=audit,
        geometry=geo,
        minimumContrast=min_contrast,
        minimumOrnamentContrast=min_ornament,
        worstContrastRows=samples[:8],
        worstOrnamentRows=ornament_samples[:8],
    )
    anchor_failures = []
    if width == 1440:
        anchor_failures = _audit_anchors(3, screenshot_dir, audit["anchors"])
        payload["anchorFailures"] = anchor_failures
        _make_compare_sheet(3, screenshot_dir, live)
        folio = audit["anchors"]["folio"]
        _crop_clamped(live, (folio[0] + folio[2] - 280, folio[1] + folio[3] - 120, 1440, 900), screenshot_dir / "crop-03-paper-edge.png")
        p0 = audit["anchors"]["phase0"]
        _crop_clamped(live, (p0[0] - 8, p0[1] - 8, p0[0] + p0[2] + 8, p0[1] + p0[3] + 8), screenshot_dir / "crop-03-phase-ribbon.png")
        plot = audit["anchors"]["plot"]
        contrib = audit["anchors"]["contributions"]
        _crop_clamped(live, (plot[0] + plot[2] - 320, plot[1] + plot[3] - 130, contrib[0] + contrib[2] + 8, contrib[1] + contrib[3] + 10), screenshot_dir / "crop-03-chart-contrib.png")
    _save_json(screenshot_dir / f"{width}-03.json", payload)

    assert shell["oneRow"] and shell["overflow"] == 0 and shell["stageX"] == 0 and shell["barHeight"] == 60, shell
    assert shell["minFont"] >= 12 and shell["dpr"] == 1 and all(v == 1 for v in shell["dimOpacities"]), shell
    dec = audit["declutter"]
    assert dec["deskImgs"] == 0 and dec["photoPins"] == 0 and dec["leakedPropImgs"] == 0, dec
    assert dec["clutterVisible"] == 0 and dec["folioFoot"] == "0px", dec
    assert dec["bookmarkBox"] and dec["bookmarkBox"][2] > 0 and dec["bookmarkBox"][3] > 0 and dec["bookmarkOverlap"] == 0, dec
    assert audit["folioParchment"] and audit["stackShadowLayers"] >= 2, audit
    assert min(audit["folioPadding"]) >= 16.0 and audit["stackPseudos"] == ["none", "none"], audit
    assert audit["clipBox"] and audit["clipBox"][1] >= 60 and audit["clipNonInteractive"], audit
    assert audit["nonInteractiveViolations"] == 0

    # 3 real phase cards with 3 distinct sepia etchings, 3 bronze medallions, and 4 counts each
    assert len(audit["phases"]) == 3 and not audit["phaseOverlaps"], audit["phases"]
    assert audit["phaseMedallionCount"] == 3 and audit["headerMapScript"] == "Chinatown", audit
    assert audit["darkLegacyCount"] == 0 and all(a == "none" for a in audit["selectAppearances"]), audit
    etching_urls = {p["etchingBg"] for p in audit["phases"]}
    assert len(etching_urls) == 3 and all("phase-" in u for u in etching_urls), etching_urls
    for p in audit["phases"]:
        assert p["statCount"] == 4 and p["ribbonBox"] and p["etchingBox"], p

    # 4 KPIs with crisp dividers and icons
    assert audit["kpiIconCount"] == 4 and len(geo["cells"]) == 4, geo["cells"]
    for cell in geo["cells"]:
        assert not cell["overlap"] and not cell["clipped"] and cell["overflow"] == 0, cell

    # 13px SVG axis labels (5 Y + 7 X = 12), 4 curves + chase shading
    assert len(audit["axisTexts"]) == 12, audit["axisTexts"]
    assert all(abs(t["cssPx"] - 13.0) <= 0.05 for t in audit["axisTexts"]), audit["axisTexts"]
    assert len(audit["curvePaths"]) == 4 and all(p["dLen"] > 20 for p in audit["curvePaths"]), audit["curvePaths"]
    assert audit["chaseRectCount"] > 0

    # 4 quick-jump triggers in chart footer
    assert len(audit["jumpBtns"]) == 4 and not audit["jumpCrossOverlaps"], audit["jumpBtns"]
    for jb in audit["jumpBtns"]:
        assert not jb["disabled"] and jb["hit"] and jb["overlapSvg"] == 0, jb

    # 4 contributor rows + original values + team shares cleanly inside viewport and frame
    assert len(audit["contribRows"]) == 4, audit["contribRows"]
    parts = [geo["hint"], geo["title"], *(p for row in geo["rows"] for p in row["parts"].values())]
    assert len(geo["rows"]) == 4, geo
    for part in parts:
        assert not any(part["frameOverflow"]) and not any(part["viewportOverflow"]), part

    expected_rows = cached_payloads[CHINATOWN_MATCH]["analytics"]["survivor_metrics"]
    total = sum(row["cipher_contrib_pct"] for row in expected_rows)
    for row in expected_rows:
        actual = next(r for r in geo["rows"] if r["uid"] == str(row["uid"]))
        raw = row["cipher_contrib_pct"]
        assert actual["raw"] == f"{raw:.2f}%", actual
        assert abs(actual["widthPct"] - 100 * raw / total) < 0.015, actual

    assert min_contrast >= 4.5, samples[:5]
    assert {r["kind"] for r in ornament_samples} >= {"brand", "wax", "ribbon", "medallion"}
    assert min_ornament >= 4.5, ornament_samples[:5]
    if width == 1440:
        assert not anchor_failures, anchor_failures

    _check_errors(browser_session)


def test_analytics_four_jump_triggers(browser_session, screenshot_dir, cached_payloads):
    page, base = browser_session["page"], browser_session["base"]
    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(base, wait_until="networkidle")
    page.evaluate("localStorage.clear(); sessionStorage.clear();")
    setup_page(page, base, 3, screenshot_dir, 1440)
    settle(page)

    data = cached_payloads[CHINATOWN_MATCH]["analytics"]
    duration = cached_payloads[CHINATOWN_MATCH]["replay"]["match"]["duration_s"]
    uid = data["survivor_metrics"][0]["uid"]
    chase = next(c for c in data["chase_segments"] if c["survivor_uid"] == uid)

    jumps = {}
    # 4 classic analytics jump triggers
    classic_cases = [
        (".phase.midgame", data["phases"][1]["start_t"]),
        (".chart svg", None),
        (".gantt .seg", chase["start_t"]),
        (".kpi.hot button", data["hunter_metrics"]["first_chase_t"]),
    ]
    for selector, expected in classic_cases:
        control = page.locator(selector).first
        if expected is None:
            first, last = control.locator("text[text-anchor=middle]").evaluate_all(
                """els => [els[0], els.at(-1)].map(e => new DOMPoint(e.x.baseVal[0].value, 0).matrixTransform(e.getScreenCTM()).x)"""
            )
            x = round((first + last) / 2)
            expected = duration * (x - first) / (last - first)
            page.mouse.click(x, control.bounding_box()["y"] + 25)
        else:
            control.click()
        page.locator("[data-test=clock]").wait_for()
        actual = page.evaluate("idvAppStore.t")
        jumps[f"classic:{selector}"] = {"expected": expected, "actual": actual}
        assert abs(actual - expected) < 0.1, (selector, expected, actual)
        page.click("#steps [data-step='3']")
        page.locator(".contributor").first.wait_for()

    # 4 chart-footer quick-jump triggers
    quick_cases = [
        ("[data-jump='phase']", data["phases"][1]["start_t"]),
        ("[data-jump='curve']", duration / 2),
        ("[data-jump='chase']", chase["start_t"]),
        ("[data-jump='first-chase']", data["hunter_metrics"]["first_chase_t"]),
    ]
    for selector, expected in quick_cases:
        page.locator(selector).click()
        page.locator("[data-test=clock]").wait_for()
        actual = page.evaluate("idvAppStore.t")
        jumps[f"quick:{selector}"] = {"expected": expected, "actual": actual}
        assert abs(actual - expected) < 0.1, (selector, expected, actual)
        page.click("#steps [data-step='3']")
        page.locator(".contributor").first.wait_for()

    _save_json(screenshot_dir / "analytics-jumps.json", jumps)
    _check_errors(browser_session)


def test_original_materials_unchanged(frontend_server, screenshot_dir):
    folder = "frontend/public/assets/dossier"
    revision = "3f0c35be19e9f02c54b1a2e0b453e356ff1d5e4a"
    hashes = {}
    for path in sorted((REPO_ROOT / folder).rglob("*.png")):
        key = path.relative_to(REPO_ROOT).as_posix()
        source = subprocess.check_output(["git", "show", f"{revision}:{key}"], cwd=REPO_ROOT)
        built = frontend_server["out_dir"] / path.relative_to(REPO_ROOT / "frontend/public")
        assert source == path.read_bytes() == built.read_bytes(), key
        hashes[key] = hashlib.sha256(source).hexdigest()
    assert len(hashes) == 11
    _save_json(screenshot_dir / "material-hashes.json", hashes)
