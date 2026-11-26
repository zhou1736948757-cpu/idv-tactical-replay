"""D-016 shared shell, measured in production Edge on real replay fixtures."""
import hashlib
import io
import json
import math
import subprocess

import numpy as np
import pytest
from PIL import Image

from conftest import REPO_ROOT
from test_fullstack_e2e import browser_session
from test_phase4_visual import setup_page, settle, contrast

SIZES = [(1366, 768), (1440, 900), (1679, 900), (1680, 900), (1920, 1080)]
MAPS = (2, 4, 5)
SCENES = [(step, w, h) for w, h in SIZES for step in
          (MAPS if w in (1679, 1680) else range(1, 6))]
TARGETS = REPO_ROOT / "Workflow/results/T-018-art/targets"


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf8")


MEASURE = r"""step => {
  const q=s=>document.querySelector(s), all=s=>Array.from(document.querySelectorAll(s));
  function box(e) {
    if (!e || !e.checkVisibility()) return null;
    const {x,y,width:w,height:h}=e.getBoundingClientRect();
    return w && h ? [x,y,w,h] : null;
  }
  function visibleBox(e) {
    let r=box(e);
    for(let p=e.parentElement;r && p;p=p.parentElement) {
      const rect=p.getBoundingClientRect(), css=getComputedStyle(p);
      for(const [i,axis] of [[0,'X'],[1,'Y']]) if(css['overflow'+axis]!=='visible'){
        const start=i?rect.top:rect.left, end=i?rect.bottom:rect.right;
        const far=Math.min(r[i]+r[i+2],end);
        r[i]=Math.max(start,r[i]); r[i+2]=far-r[i];
        if(r[i+2]<=0) return null;
      }
    }
    return r;
  }
  const area=r=>r?Math.max(0,r[2])*Math.max(0,r[3]):0;
  const rectOverlap=(a,b)=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*
                           Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
  const directImgs=all('.desk-still > img').map(e=>{
    const b=box(e), v=visibleBox(e);
    return {name:e.getAttribute('class'),tag:e.tagName,src:e.getAttribute('src'),
      naturalWidth:e.naturalWidth,naturalHeight:e.naturalHeight,
      display:getComputedStyle(e).display,box:b,
      clipped:b?Math.max(0,+(area(b)-area(v)).toFixed(3)):0};
  });
  const leakedPropImgs=all('img').filter(i=>/desk-(fountain-pen|pocket-watch|vintage-postcard)\.png/i.test((i.getAttribute('src')||'')+' '+(i.currentSrc||''))).map(i=>({cls:i.className,src:i.getAttribute('src')}));
  const props=Object.fromEntries(directImgs.map(i=>[i.name,i.box]));
  const controls=all('button,select,summary,input,a[href],[role=button],#uploadBtn,.scale,.compass,.map-key,.legend-card,.ded-marker,.contributor,.phase-plate,.pil-aspect-frame,.zone-picker[open],.folio-phases,.view-pop,.archive-pop,.pil-popover,.flow-preferences,#strip.hud-expanded .hud-content,.transport-help[open] p');
  const hits=[];
  for(const [key,p] of Object.entries(props)) if(p) for(const el of controls){
    const c=visibleBox(el);
    if(!c) continue;
    const ov=rectOverlap(p,c);
    if(ov) hits.push({key,control:el.id||el.dataset?.test||el.className?.baseVal||el.className,area:ov});
  }
  const boardCanvas=q('[data-test=board-canvas]');
  let mapFootprint=null;
  if(boardCanvas && globalThis.idvFootprints?.get(boardCanvas)){
    const cr=boardCanvas.getBoundingClientRect();
    const sx=cr.width/boardCanvas.width, sy=cr.height/boardCanvas.height;
    const pts=globalThis.idvFootprints.get(boardCanvas).map(pt=>[cr.x+pt.x*sx,cr.y+pt.y*sy]);
    const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
    const l=Math.max(cr.left,Math.min(...xs)), t=Math.max(cr.top,Math.min(...ys));
    const r=Math.min(cr.right,Math.max(...xs)), b=Math.min(cr.bottom,Math.max(...ys));
    if(r>l && b>t) mapFootprint=[l,t,r-l,b-t];
  }
  const mapHits=[];
  if(mapFootprint){
    const propEntries=[...Object.entries(props),['photo-pin',box(q('.photo-pin'))]];
    for(const [key,p] of propEntries) if(p){
      const ov=rectOverlap(p,mapFootprint);
      if(ov) mapHits.push({key,area:ov});
    }
  }
  const contribEls=step===3?all('.contributor'):[];
  const contributors=step===3?{
    count:contribEls.length,
    clipped:contribEls.filter(e=>{const b=box(e),v=visibleBox(e);return !b||!v||b.some((val,i)=>Math.abs(val-v[i])>.5);}).length
  }:null;
  const folio=q(['','#dropZone','#rightCol','#analysis','#region-folio','#deduce-folio'][step]);
  const folioPadTarget=step===2?q('#rightCol > .folio-inner'):(step===4||step===5)?q('.step.show .pil-right'):folio;
  const folioPadding=folioPadTarget && box(folioPadTarget) ? (() => {
    const cs=getComputedStyle(folioPadTarget);
    return [parseFloat(cs.paddingTop),parseFloat(cs.paddingRight),parseFloat(cs.paddingBottom),parseFloat(cs.paddingLeft)];
  })() : null;
  const folioStackEl=step===1?q('.import-stack'):step===3?q('.analysis-stack'):folio;
  const folioStackPseudos=folioStackEl && box(folioStackEl)
    ? [getComputedStyle(folioStackEl,'::before').content, getComputedStyle(folioStackEl,'::after').content]
    : null;
  const clutterVisible=all('.folio-corner,.folio-edge-flourish,.card-flourish,.foot-corner,.well-corner,.plate-corner,.phase-corner,.board-flourish').filter(box).length;
  const corners=all('.folio-stack > .folio-corner').filter(box);
  const decorations=all('.desk-still,.desk-still *,.manor-map-frame,.manor-map-frame *,.binder-clip,.folio-corner').filter(box);
  const rect=s=>box(q(s));
  const boardRect=rect(['','.archive-board','.board','#analysis','.pil-board-wrap','.pil-board-wrap'][step]);
  const bookmarkRect=rect('.desk-still > .bookmark');
  const folioRect=box(folio);
  const bookmarkOverlaps=bookmarkRect ? [boardRect,folioRect,mapFootprint].filter(Boolean).reduce((s,r)=>s+rectOverlap(bookmarkRect,r),0) : 0;
  const submodeBar=step===4?rect('#regionView > .region-submode-bar'):null;
  const pilMainTop=step===4?(q('#regionView > .pil-main')?.getBoundingClientRect().top ?? null):null;
  const submodeTotalH=(submodeBar && pilMainTop!==null)?+(pilMainTop-submodeBar[1]).toFixed(3):0;
  const manorMapFrame=(step===2||step===4||step===5)?rect('.step.show .manor-map-frame'):null;
  const folioFootVar=getComputedStyle(document.documentElement).getPropertyValue('--folio-foot').trim();
  const stripRect=rect('#strip');
  const tbEl=q('#toolbar');
  const toolbarBudget=boardRect && stripRect && tbEl ? {
    boardWidth: boardRect[2],
    stripRightRel: +(stripRect[0]+stripRect[2]-boardRect[0]).toFixed(2),
    availableWidth: +(boardRect[0]+boardRect[2]-(stripRect[0]+stripRect[2])-16).toFixed(2),
    toolbarBoxWidth: +(rect('#toolbarWrap')?.[2] ?? 0).toFixed(2),
    toolbarScrollWidth: tbEl.scrollWidth,
    toolbarOverflowPx: Math.max(0, tbEl.scrollWidth - Math.round(tbEl.clientWidth)),
  } : null;
  const stageEl=q('#stage');
  const inactiveStepBgs=all('#bar #steps button:not(.on)').map(b=>{
    const cs=getComputedStyle(b);
    return [cs.backgroundColor, cs.backgroundImage];
  });
  const onStepBtn=q('#bar #steps button.on');
  const activeStepBg=onStepBtn?(()=>{
    const cs=getComputedStyle(onStepBtn);
    return {hasGradient:cs.backgroundImage.includes('linear-gradient'),hasShadow:cs.boxShadow!=='none'};
  })():null;
  const brandVEl=q('#bar .identity i');
  const brandVColor=brandVEl?(getComputedStyle(brandVEl).color.match(/\d+/g)||[]).slice(0,3).map(Number):[];
  const selectAppearances=all('#bar select.sel, .step.show select.sel').filter(box).map(s=>getComputedStyle(s).appearance);
  return {directImgs,leakedPropImgs,props,hits,mapFootprint,mapHits,contributors,
    clutterVisible,folioFootVar,folioPadding,folioStackPseudos,bookmarkOverlaps,
    submodeBar,submodeTotalH,manorMapFrame,
    inactiveStepBgs,activeStepBg,brandVColor,selectAppearances,
    stageAttrs:{propRetreat:stageEl?.getAttribute('data-prop-retreat'),mapZoomed:stageEl?.getAttribute('data-map-zoomed')},
    controls:controls.filter(visibleBox).length,decorations:decorations.length,
    intercept:decorations.filter(e=>getComputedStyle(e).pointerEvents!=='none').map(e=>e.tagName),
    stage:rect('#stage'),bar:rect('#bar'),board:boardRect,
    folio:folioRect,bookmark:bookmarkRect,ink:rect('.bookmark-ink'),text:q('.bookmark-ink').textContent,
    clip:rect('.binder-clip'),pin:rect('.photo-pin'),
    clippedCorners:corners.filter(e=>box(e).some((v,i)=>Math.abs(v-visibleBox(e)?.[i])>.1)).length,
    overflow:document.documentElement.scrollWidth-innerWidth,
    strip:stripRect,toolbar:rect('#toolbarWrap'),toolbarBudget,scale:rect('.scale'),compass:rect('.compass'),
    match:idvAppStore.selectedId,t:idvAppStore.t,
    activeTools:all('#toolbar [aria-pressed=true],#toolbar .on,.pil-topbar .on').map(e=>e.textContent.trim())};
}"""


def rendered_contrast(page):
    # Each source text node has its own sample box (including both seal lines).
    rows = page.evaluate(r"""() => {
      const rows=[];
      for(const e of document.querySelectorAll('.identity i,.wax-seal text,.compass text,.scale text,.ribbon-h,.ribbon-h small')){
        if(!e.checkVisibility()) continue;
        const c=getComputedStyle(e);
        for(const n of e.childNodes){
          if(n.nodeType!==3 || !n.textContent.trim()) continue;
          const range=new Range(); range.selectNodeContents(n);
          let r=range.getBoundingClientRect();
          let [x,y,right,bottom]=[r.left,r.top,r.right,r.bottom];
          for(let p=e.parentElement;p;p=p.parentElement){
            const b=p.getBoundingClientRect(),cs=getComputedStyle(p);
            if(cs.overflowY!=='visible'){y=Math.max(y,b.top);bottom=Math.min(bottom,b.bottom)}
            if(cs.overflowX!=='visible'){x=Math.max(x,b.left);right=Math.min(right,b.right)}
          }
          if(right<=x || bottom<=y) continue;
          const color=(e instanceof SVGElement?c.fill:c.color).match(/\d+/g).map(Number);
          const kind=e.closest('.wax-seal')?'wax':e.closest('.compass')?'compass':e.closest('.scale')?'scale':e.closest('.ribbon-h')?'ribbon':'brand';
          rows.push({label:n.textContent.trim(),kind,color,rect:[x,y,right,bottom]});
        }
      }return rows
    }""")
    selector = ".identity i,.wax-seal text,.compass text,.scale text,.ribbon-h,.ribbon-h small"
    def probe(color):
        style = page.add_style_tag(content=selector + "{fill:"+color+"!important;-webkit-text-fill-color:"+color+"!important}")
        try:
            return np.asarray(Image.open(io.BytesIO(page.screenshot())).convert("RGB"), dtype=np.int16)
        finally:
            style.evaluate("s=>s.remove()")
    black, white, back = [probe(color) for color in ("black", "white", "transparent")]
    mask = (white-black).min(axis=2) >= 190
    result = []
    for row in rows:
        x,y,right,bottom = row.pop("rect")
        l,t = max(0,math.floor(x)),max(0,math.floor(y))
        r,b = math.ceil(right),math.ceil(bottom)
        glyph = mask[t:b,l:r]
        if not glyph.any():
            continue
        bg = back[t:b,l:r][glyph]
        lum = contrast.luminance(bg)
        fg = contrast.luminance(np.array(row["color"]))
        ratios = (np.maximum(lum,fg)+.05)/(np.minimum(lum,fg)+.05)
        j = ratios.argmin()
        yy,xx = np.where(glyph)
        result.append(dict(**row, minimum=round(float(ratios[j]),3), xy=[int(l+xx[j]),int(t+yy[j])], backing=bg[j].tolist()))
    return result


@pytest.mark.parametrize("step,width,height", SCENES)
def test_shell(browser_session, screenshot_dir, step, width, height):
    page, base = browser_session["page"], browser_session["base"]
    page.set_viewport_size({"width":width,"height":height})
    page.goto(base)
    page.evaluate("localStorage.clear();sessionStorage.clear()")
    setup_page(page, base, step, screenshot_dir, width)
    settle(page)
    target = json.loads((TARGETS/f"{step:02}.json").read_text("utf8"))
    assert page.locator("#steps button").count() == 5
    for selector, label in [("[data-test=flow-settings]","⚙ 设置 · 手动"),("[data-step='2']","Tactical Sandbox")]:
        assert label in page.locator(selector).inner_text()
    toggle = page.locator(".folio-toggle")
    states = {}
    for state in (("open","closed") if step in MAPS else ("open",)):
        if state == "closed":
            toggle.click()
            settle(page)
        data = states[state] = page.evaluate(MEASURE, step)
        prefix = screenshot_dir / f"{width}-{step:02}-{state}"
        page.screenshot(path=str(prefix)+".png")
        if state=="open" and width not in (1679,1680):
            data["contrast"] = rendered_contrast(page)
        save(prefix.with_suffix(".json"),dict(**data, edge=browser_session["browser_version"]))
        assert data["bar"][3]==60 and data["stage"][0]==data["overflow"]==0
        assert data["controls"] and data["decorations"] and not data["intercept"]
        assert not data["hits"] and not data["clippedCorners"], data["hits"]
        if data["clip"]:
            assert data["clip"][1] >= data["stage"][1], data["clip"]
        assert data["text"] == target["evidence"]["bookmark"]["text"]
        assert bool(data["bookmark"]) == (state == "open")
        # D-024 §5.1 & D-026 §3/§5 Phase 6 strict declutter, topbar plaque & control craft assertions
        assert data["directImgs"] == [], data["directImgs"]
        assert data["pin"] is None, data["pin"]
        assert data["leakedPropImgs"] == [], data["leakedPropImgs"]
        assert data["clutterVisible"] == 0, data["clutterVisible"]
        assert data["folioFootVar"] == "0px", data["folioFootVar"]
        assert len(data["inactiveStepBgs"]) == 4 and all(bg == ["rgba(0, 0, 0, 0)", "none"] for bg in data["inactiveStepBgs"]), data["inactiveStepBgs"]
        assert data["activeStepBg"] == {"hasGradient": True, "hasShadow": True}, data["activeStepBg"]
        assert len(data["brandVColor"]) == 3 and data["brandVColor"][0] >= 220 and (data["brandVColor"][0] - data["brandVColor"][1]) >= 110, data["brandVColor"]
        assert all(app == "none" for app in data["selectAppearances"]), data["selectAppearances"]
        if state == "open" and step in (1, 2, 4, 5):
            assert len(data["selectAppearances"]) >= 1, (step, data["selectAppearances"])
        if state == "open":
            assert data["bookmark"] and data["bookmark"][2] > 0 and data["bookmark"][3] > 0
            assert data["bookmarkOverlaps"] == 0, data["bookmarkOverlaps"]
            assert data["folioStackPseudos"] == ["none", "none"], data["folioStackPseudos"]
            assert data["folioPadding"] and min(data["folioPadding"][1], data["folioPadding"][3]) >= 16.0, data["folioPadding"]
        if step == 3 and width == 1366:
            assert data["contributors"] == {"count": 4, "clipped": 0}, data["contributors"]
        if step == 2 and state == "closed" and width >= 1680:
            assert data["mapFootprint"] and not data["mapHits"], data["mapHits"]
        if "contrast" in data:
            rows=data["contrast"]
            assert {r["kind"] for r in rows} >= ({"brand","wax","compass","scale","ribbon"} if step in MAPS else {"brand","wax"})
            assert min(r["minimum"] for r in rows)>=4.5, sorted(rows,key=lambda r:r["minimum"])[:2]
        if step in MAPS:
            assert data["manorMapFrame"] and data["manorMapFrame"][2] > 0 and data["manorMapFrame"][3] > 0
            margin=10 if width<1440 else 12 if width<1600 else 16
            x,_,w,h=data["board"]
            opened=state=="open"
            assert x==pytest.approx(margin+(width*.05 if opened else 0),abs=.1)
            assert w==pytest.approx(width-2*margin-(width*.37+10 if opened else 0),abs=.1)
            if step == 4:
                # D-025 §1: Stage 04 submode bar (56px open / 50px closed) + board height conserves height - 110
                assert data["submodeBar"] and data["submodeBar"][3] > 0, data["submodeBar"]
                assert 48.0 <= data["submodeTotalH"] <= 58.0, data["submodeTotalH"]
                assert h + data["submodeTotalH"] == pytest.approx(height - 110, abs=0.5), (h, data["submodeTotalH"], height)
            else:
                assert h==pytest.approx(height-(120 if step==2 else 110),abs=.1)
            assert toggle.get_attribute("aria-expanded")==str(opened).lower()
            if opened:
                assert data["folio"][0]==pytest.approx(x+w+10,abs=.1)
                assert data["folio"][2]==pytest.approx(width*.32,abs=.1)
                assert data["compass"][2]==64 and data["scale"][2]>0
            else:
                assert not data["folio"] and w>=width*.98
                assert toggle.evaluate("e=>e===document.activeElement")
                page.keyboard.press("]")
                settle(page)
                restored=page.evaluate(MEASURE,step)
                for k in ("board","folio","match","t","activeTools"):
                    assert restored[k]==states["open"][k],k
                assert toggle.get_attribute("aria-expanded")=="true"
    assert not any(browser_session["errors"][k] for k in ("console", "page", "external", "http", "failed")), browser_session["errors"]


def test_folio_persistence_reload_and_step_switch(browser_session, screenshot_dir):
    page, base = browser_session["page"], browser_session["base"]
    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(base)
    page.evaluate("localStorage.clear();sessionStorage.clear()")
    setup_page(page, base, 2, screenshot_dir, 1440)
    settle(page)
    toggle = page.locator(".folio-toggle")
    assert toggle.get_attribute("aria-expanded") == "true"
    match_before = page.evaluate("idvAppStore.selectedId")
    toggle.click()
    settle(page)
    assert toggle.get_attribute("aria-expanded") == "false"
    # Reload restores persisted collapsed state from flow.prefs.rightDrawerCollapsed
    page.reload(wait_until="networkidle")
    page.locator(".board").wait_for()
    settle(page)
    assert toggle.get_attribute("aria-expanded") == "false"
    reloaded = page.evaluate(MEASURE, 2)
    assert reloaded["board"][2] == pytest.approx(1416, abs=.1) and not reloaded["folio"]
    # Step switch to 04 preserves collapsed state; pressing ']' reopens and persists back to 02
    page.click("#steps button[data-step='4']")
    page.locator("#regionView").wait_for()
    settle(page)
    assert toggle.get_attribute("aria-expanded") == "false"
    page.keyboard.press("]")
    settle(page)
    assert toggle.get_attribute("aria-expanded") == "true"
    page.click("#steps button[data-step='2']")
    page.locator(".board").wait_for()
    settle(page)
    assert toggle.get_attribute("aria-expanded") == "true"
    reopened = page.evaluate(MEASURE, 2)
    assert reopened["board"][2] == pytest.approx(873.2, abs=.1)
    assert reopened["folio"][2] == pytest.approx(460.8, abs=.1)
    assert reopened["match"] == match_before
    assert not any(browser_session["errors"][k] for k in ("console", "page", "external", "http", "failed")), browser_session["errors"]


def _assert_phase5_declutter_state(data, *, bookmark_visible):
    assert data["directImgs"] == [], data["directImgs"]
    assert data["pin"] is None, data["pin"]
    assert data["leakedPropImgs"] == [], data["leakedPropImgs"]
    assert data["clutterVisible"] == 0, data["clutterVisible"]
    assert data["folioFootVar"] == "0px", data["folioFootVar"]
    assert bool(data["bookmark"]) == bookmark_visible, (bookmark_visible, data["bookmark"])
    assert data["bookmarkOverlaps"] == 0, data["bookmarkOverlaps"]
    assert data["overflow"] == 0, data["overflow"]
    assert not data["hits"], data["hits"]
    assert not data["mapHits"], data["mapHits"]


def _reset_sandbox_view(page):
    page.click("[data-test=btn-view-settings]")
    page.click("[data-test=btn-reset]")
    page.click("[data-test=btn-view-close]")
    settle(page)


@pytest.mark.parametrize("width,height", [(1680, 900), (1680, 1080), (1920, 1080)])
def test_collapsed_zoom_and_pan_prop_retreat(browser_session, screenshot_dir, width, height):
    """D-024 §5.1: collapsed zoom/pan preserve 0 desk props, 0 clutter, and clean bookmark toggle."""
    page, base = browser_session["page"], browser_session["base"]
    page.set_viewport_size({"width": width, "height": height})
    page.goto(base)
    page.evaluate("localStorage.clear();sessionStorage.clear()")
    setup_page(page, base, 2, screenshot_dir, width)
    settle(page)

    toggle = page.locator(".folio-toggle")
    toggle.click()
    settle(page)
    assert toggle.get_attribute("aria-expanded") == "false"

    # Initial collapsed fit: zero desk-still > img props and bookmark cleanly hidden while collapsed
    fit = page.evaluate(MEASURE, 2)
    assert fit["mapFootprint"]
    _assert_phase5_declutter_state(fit, bookmark_visible=False)

    canvas = page.locator("[data-test=board-canvas]")
    box = canvas.bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cx, cy)

    # Wheel -320 triggers zoom cleanly with zero prop clutter
    page.mouse.wheel(0, -320)
    settle(page)
    z320 = page.evaluate(MEASURE, 2)
    assert z320["mapFootprint"][2] > fit["mapFootprint"][2]
    _assert_phase5_declutter_state(z320, bookmark_visible=False)

    # Wheel -640 keeps zoomed map filling board cleanly
    page.mouse.wheel(0, -640)
    settle(page)
    z640 = page.evaluate(MEASURE, 2)
    assert z640["mapFootprint"][2] >= z320["mapFootprint"][2]
    _assert_phase5_declutter_state(z640, bookmark_visible=False)
    z_prefix = screenshot_dir / f"zoom640-{width}x{height}-closed"
    page.screenshot(path=str(z_prefix) + ".png")
    save(z_prefix.with_suffix(".json"), dict(**z640, edge=browser_session["browser_version"]))

    # Reset view restores fit cleanly
    _reset_sandbox_view(page)
    restored = page.evaluate(MEASURE, 2)
    assert abs(restored["mapFootprint"][2] - fit["mapFootprint"][2]) <= 1.0
    _assert_phase5_declutter_state(restored, bookmark_visible=False)

    # +325px pan drag shifts map footprint cleanly with zero desk-prop overlap
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 325, cy, steps=10)
    page.mouse.up()
    settle(page)
    panned = page.evaluate(MEASURE, 2)
    assert panned["mapFootprint"][0] > restored["mapFootprint"][0] + 200
    _assert_phase5_declutter_state(panned, bookmark_visible=False)
    if (width, height) == (1920, 1080):
        p_prefix = screenshot_dir / f"pan325-{width}x{height}-closed"
        page.screenshot(path=str(p_prefix) + ".png")
        save(p_prefix.with_suffix(".json"), dict(**panned, edge=browser_session["browser_version"]))

    # Reset restores fit again
    _reset_sandbox_view(page)
    restored2 = page.evaluate(MEASURE, 2)
    assert abs(restored2["mapFootprint"][0] - fit["mapFootprint"][0]) <= 1.0
    _assert_phase5_declutter_state(restored2, bookmark_visible=False)

    # Expanding folio with ']' restores clean left .bookmark with 0 overlap even when zoomed
    page.keyboard.press("]")
    settle(page)
    assert toggle.get_attribute("aria-expanded") == "true"
    box_open = canvas.bounding_box()
    page.mouse.move(box_open["x"] + box_open["width"] / 2, box_open["y"] + box_open["height"] / 2)
    page.mouse.wheel(0, -320)
    settle(page)
    open_zoom = page.evaluate(MEASURE, 2)
    _assert_phase5_declutter_state(open_zoom, bookmark_visible=True)
    toggle.click()
    settle(page)
    _assert_phase5_declutter_state(page.evaluate(MEASURE, 2), bookmark_visible=False)
    page.keyboard.press("]")
    settle(page)
    _assert_phase5_declutter_state(page.evaluate(MEASURE, 2), bookmark_visible=True)
    _reset_sandbox_view(page)
    assert not any(browser_session["errors"][k] for k in ("console", "page", "external", "http", "failed")), browser_session["errors"]


@pytest.mark.parametrize("width,height", [(1680, 900), (1920, 1080)])
def test_collapsed_popovers_and_side_hooks(browser_session, screenshot_dir, width, height):
    """D-024 §5.1: collapsed Stage 02 & 04 popovers open/close cleanly with 0 desk props & 0 clutter."""
    page, base = browser_session["page"], browser_session["base"]
    page.set_viewport_size({"width": width, "height": height})
    page.goto(base)
    page.evaluate("localStorage.clear();sessionStorage.clear()")
    setup_page(page, base, 2, screenshot_dir, width)
    settle(page)

    toggle = page.locator(".folio-toggle")
    toggle.click()
    settle(page)
    _assert_phase5_declutter_state(page.evaluate(MEASURE, 2), bookmark_visible=False)

    # Step 02 active popovers open and close cleanly with zero desk-prop clutter or overflow
    for open_sel, close_sel in [
        ("[data-test=btn-view-settings]", "[data-test=btn-view-close]"),
        ("[data-test=btn-tac-archive]", "[data-test=btn-tac-archive]"),
        ("#strip .hud-toggle", "#strip .hud-toggle"),
        (".transport-help summary", ".transport-help summary"),
        ("[data-test=flow-settings]", "[data-test=flow-settings]"),
    ]:
        page.click(open_sel)
        settle(page)
        _assert_phase5_declutter_state(page.evaluate(MEASURE, 2), bookmark_visible=False)
        page.click(close_sel)
        settle(page)
        _assert_phase5_declutter_state(page.evaluate(MEASURE, 2), bookmark_visible=False)

    # Expanding folio restores .bookmark cleanly with 0 overlap
    toggle.click()
    settle(page)
    _assert_phase5_declutter_state(page.evaluate(MEASURE, 2), bookmark_visible=True)
    toggle.click()
    settle(page)

    # Step 04 collapsed popovers (.zone-picker[open] and region-display-btn.on)
    page.evaluate("localStorage.clear();sessionStorage.clear()")
    setup_page(page, base, 4, screenshot_dir, width)
    settle(page)
    page.locator("#s4 .folio-toggle").click()
    settle(page)
    _assert_phase5_declutter_state(page.evaluate(MEASURE, 4), bookmark_visible=False)
    for sel in [".zone-picker summary", "[data-test=region-display-btn]"]:
        page.click(sel)
        settle(page)
        _assert_phase5_declutter_state(page.evaluate(MEASURE, 4), bookmark_visible=False)
        page.click(sel)
        settle(page)
        _assert_phase5_declutter_state(page.evaluate(MEASURE, 4), bookmark_visible=False)

    assert not any(browser_session["errors"][k] for k in ("console", "page", "external", "http", "failed")), browser_session["errors"]


def test_original_materials(frontend_server,screenshot_dir):
    folder="frontend/public/assets/dossier"
    revision="3f0c35be19e9f02c54b1a2e0b453e356ff1d5e4a"
    hashes={}
    for path in sorted((REPO_ROOT/folder).rglob("*.png")):
        key=path.relative_to(REPO_ROOT).as_posix()
        source=subprocess.check_output(["git","show",f"{revision}:{key}"],cwd=REPO_ROOT)
        built=frontend_server["out_dir"] / path.relative_to(REPO_ROOT/"frontend/public")
        assert source==path.read_bytes()==built.read_bytes()
        hashes[key]=hashlib.sha256(source).hexdigest()
    assert len(hashes)==11
    save(screenshot_dir/"material-hashes.json",hashes)
