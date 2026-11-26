"""T-008 Full-Stack E2E (v2): live FastAPI + live Vite preview + headless Microsoft Edge.

AC-1  Live API & upload round-trips against a real ``uvicorn`` process (Phase 1 invariants).
AC-2  Real browser (Playwright with local Microsoft Edge) drives the
      v2 5-step Manor Dossier UI:
        01 档案库 (5-step rail + real assets)
        -> 02 战术沙盘 standalone 9-map whiteboard (decluttered single-row toolbar,
           ViewSettingsPopover, tokens/props, draw + undo/clear, polyline simulateMovement ETA,
           Carry/Tide range overlays, waypoint animation timeline, localStorage persistence,
           JSON export/import, untainted PNG download)
        -> 04 区域选点 (9 maps, 永眠镇 10 zones, survivor/hunter caps & mutual exclusion,
           lock cipher name/meter distance, persistence, cross-view map sync)
        -> 05 密码机推演 (必刷 locks, mark cycling, deduction steps/SVG scopes, layout preview,
           contradiction alert, persistence, cross-view map sync)
        -> 02 战术沙盘 live replay mode (2D/2.5D, B1/1F/2F, 45 u/s ruler, 3-tab #rightCol,
           seek + pulse, replay+overlay PNG export)
        -> 03 对比分析 + deep links + UI .zip upload.
AC-3  Zero console errors, zero page errors, zero local HTTP >= 400 responses,
      zero disallowed external requests, and read-only audit/cache fingerprints unchanged.

Run from the project root:  python -m pytest -p no:asyncio tests -v
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import time
import zipfile
from pathlib import Path
from typing import Dict, List

import pytest

from conftest import (
    ASSETS_DIR,
    AUDIT_DIR,
    BOT_MATCH,
    CHINATOWN_MATCH,
    PID102_MATCH,
    REPO_CACHE_DIR,
    VERIFIED_MATCH_IDS,
    build_replay_zip,
    tree_fingerprint,
)

pytestmark = pytest.mark.e2e

JPEG = b"\xff\xd8\xff"
PNG = b"\x89PNG\r\n\x1a\n"


def _vec3(v) -> bool:
    return isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in v)


def _clock_seconds(text: str) -> float:
    m = re.search(r"(\d+):(\d+(?:\.\d+)?)", text)
    assert m, f"no clock in {text!r}"
    return int(m.group(1)) * 60 + float(m.group(2))


# =========================================================================== AC-1 live API
class TestLiveApi:
    def test_health(self, api, backend_server):
        r = api.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["preloaded_matches"] >= 7
        # the live server is isolated on a temp copy of the cache (repo files stay untouched)
        assert body["cache_dir"] == str(backend_server["cache"])

    def test_matches_list_and_map_assets(self, api, web):
        r = api.get("/api/matches")
        assert r.status_code == 200
        matches = r.json()["matches"]
        ids = {m["match_id"] for m in matches}
        assert set(VERIFIED_MATCH_IDS) <= ids
        for m in matches:
            if m["match_id"] not in VERIFIED_MATCH_IDS:
                continue
            url = m["map_asset_url"]
            assert url.startswith("/assets/maps/") and url.endswith("_grid.jpg"), url
            img = web.get(url)  # served by the live frontend server
            assert img.status_code == 200, url
            assert img.content.startswith(JPEG), url
            assert (ASSETS_DIR / "maps" / url.rsplit("/", 1)[1]).is_file()

    @pytest.mark.parametrize("mid", VERIFIED_MATCH_IDS)
    def test_replay_and_analytics_contract(self, api, mid):
        r = api.get(f"/api/matches/{mid}/replay")
        assert r.status_code == 200
        rp = r.json()
        assert rp["schema_version"] == "1.0"
        assert rp["match"]["match_id"] == mid
        for key in ("match", "time", "world", "players", "entities", "trajectories", "events", "markers"):
            assert key in rp
        assert set(rp["world"]["floors"]) == {"B1", "1F", "2F"}
        assert rp["world"]["map_underlay"]["asset_url"] == rp["match"]["map_asset_url"]
        # 100% Component-17 pos + dir on gates, windows, pallets (and every other static entity)
        ents = rp["entities"]
        assert len(ents["exit_gates"]) == 2 and ents["windows"] and ents["pallets"]
        for kind in ("exit_gates", "windows", "pallets", "ciphers", "chairs"):
            for e in ents[kind]:
                assert _vec3(e["pos"]) and _vec3(e["dir"]), (kind, e["uid"])
                assert abs(e["pos"][1]) < 500
                assert e["floor"] in ("B1", "1F", "2F")
        assert len(ents["ciphers"]) == 7
        # talents: names only for survivors (camp 2); hunters keep raw ids
        players = rp["players"]
        assert len(players) == 5
        assert sum(1 for p in players if p["camp"] == 1) == 1
        for p in players:
            if p["camp"] == 1:
                assert all(t["name"] is None for t in p["talents"]), p["player_name"]
            assert str(p["uid"]) in rp["trajectories"]
            traj = rp["trajectories"][str(p["uid"])]
            assert traj and all(len(s) == 9 for s in traj[:50])

        r2 = api.get(f"/api/matches/{mid}/analytics")
        assert r2.status_code == 200
        an = r2.json()
        assert an["match_id"] == mid
        assert [p["phase_id"] for p in an["phases"]] == ["opening", "midgame", "endgame"]
        assert len(an["survivor_metrics"]) == 4
        assert an["hunter_metrics"]["uid"] == rp["match"]["hunter"]["uid"]
        if mid == PID102_MATCH:
            assert an["hunter_metrics"]["pid"] == 102
            assert an["hunter_metrics"]["distance_xz_u"] > 15000

    @pytest.mark.parametrize("path", ["/api/matches/ffffffffffffffffffffffff/replay", "/api/matches/..%2F..%2Fetc/analytics"])
    def test_unknown_match_404(self, api, path):
        assert api.get(path).status_code == 404

    def test_proxy_through_frontend(self, web):
        r = web.get("/api/matches")
        assert r.status_code == 200
        assert {m["match_id"] for m in r.json()["matches"]} >= set(VERIFIED_MATCH_IDS)


class TestLiveUpload:
    def test_upload_real_replay_zip(self, api, cached_payloads):
        data = build_replay_zip(CHINATOWN_MATCH)
        r = api.post("/api/replays/upload", files={"file": ("chinatown.zip", data, "application/zip")})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["uploaded_count"] == 1 and body["match_ids"] == [CHINATOWN_MATCH]
        assert body["matches"][0]["map_name"] == "唐人街"
        # re-extracted live replay matches the verified cache
        live = api.get(f"/api/matches/{CHINATOWN_MATCH}/replay").json()
        ref = cached_payloads[CHINATOWN_MATCH]["replay"]
        for kind in ("ciphers", "exit_gates", "windows", "pallets", "chairs"):
            assert len(live["entities"][kind]) == len(ref["entities"][kind])
        assert sorted(p["uid"] for p in live["players"]) == sorted(p["uid"] for p in ref["players"])
        assert api.get("/api/health").json()["preloaded_matches"] >= 7

    def test_upload_raw_binary_body(self, api):
        r = api.post("/api/replays/upload", content=build_replay_zip(BOT_MATCH), headers={"Content-Type": "application/zip"})
        assert r.status_code == 200, r.text
        assert r.json()["match_ids"] == [BOT_MATCH]

    def test_malicious_pickle_rejected_422(self, api, backend_server):
        before = sorted(m["match_id"] for m in api.get("/api/matches").json()["matches"])
        evil = b"\x80\x02cos\nsystem\nq\x00X\x04\x00\x00\x00exitq\x01\x85q\x02Rq\x03."
        benign = b"\x80\x02}q\x00X\x04\x00\x00\x00dataq\x01]q\x02s."
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("evil/game_info.txt", evil)
            zf.writestr("evil/total_info.txt", benign)
            zf.writestr("evil/battle_frames_snapshot_0.txt", benign)
        r = api.post("/api/replays/upload", files={"file": ("evil.zip", buf.getvalue(), "application/zip")})
        assert r.status_code == 422, r.text
        assert "Unsafe pickle" in r.json()["detail"]
        after = sorted(m["match_id"] for m in api.get("/api/matches").json()["matches"])
        assert before == after

    @pytest.mark.parametrize("entry", ["../../idv_e2e_escape.txt", "/abs_escape.txt", "C:/drive_escape.txt", "..\\..\\bs_escape.txt"])
    def test_path_traversal_zip_rejected_400(self, api, backend_server, entry):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(entry, b"pwned")
        r = api.post("/api/replays/upload", files={"file": ("bad.zip", buf.getvalue(), "application/zip")})
        assert r.status_code == 400, r.text
        assert "Unsafe" in r.json()["detail"]
        cache = backend_server["cache"]
        for p in (cache.parent / "idv_e2e_escape.txt", cache.parent.parent / "idv_e2e_escape.txt"):
            assert not p.exists()

    def test_symlink_zip_rejected_400(self, api):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            info = zipfile.ZipInfo("m/link")
            info.create_system = 3
            info.external_attr = (0o120777 << 16)
            zf.writestr(info, "../../../../Windows/win.ini")
        r = api.post("/api/replays/upload", files={"file": ("link.zip", buf.getvalue(), "application/zip")})
        assert r.status_code == 400, r.text

    @pytest.mark.parametrize("payload", [b"not a zip at all", b""])
    def test_non_zip_rejected_400(self, api, payload):
        r = api.post("/api/replays/upload", content=payload, headers={"Content-Type": "application/octet-stream"})
        assert r.status_code == 400

    def test_zip_without_replay_422(self, api):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("readme.txt", b"hello")
        r = api.post("/api/replays/upload", content=buf.getvalue(), headers={"Content-Type": "application/zip"})
        assert r.status_code == 422


# =========================================================================== AC-2 real browser
CANVAS_PROBE = """
(sel) => {
  const c = document.querySelector(sel || '[data-test=board-canvas]');
  if (!c) return null;
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0, h = 2166136261 >>> 0;
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4 * 5) {
    if (d[i + 3] > 0) opaque++;
    if (colors.size < 4096) colors.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
    h = Math.imul(h ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)), 16777619) >>> 0;
  }
  return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight, opaque, samples: d.length / 20, colors: colors.size, hash: h };
}
"""


@pytest.fixture(scope="module")
def browser_session(frontend_server, screenshot_dir):
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
        viewport={"width": 1600, "height": 1000},
        device_scale_factor=1,
        locale="zh-CN",
        accept_downloads=True,
    )
    ctx.add_init_script("""
        if (!localStorage.getItem('idv.flow.v1')) {
          localStorage.setItem('idv.flow.v1', JSON.stringify({ autoFlow: false }));
        }
        // Observe the actual Vue proxies in the production bundle, scoped to this test context.
        const NativeProxy = globalThis.Proxy;
        globalThis.Proxy = new NativeProxy(NativeProxy, {
          construct(target, args) {
            const proxy = Reflect.construct(target, args);
            if (Object.hasOwn(args[0], 'analyticsById')) globalThis.idvAppStore = proxy;
            if (Object.hasOwn(args[0], 'draftRegion')) globalThis.idvFlowStore = proxy;
            return proxy;
          }
        });
        const dash = CanvasRenderingContext2D.prototype.setLineDash;
        const clear = CanvasRenderingContext2D.prototype.clearRect;
        globalThis.idvRegionDashes = new WeakMap();
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
          if (this.canvas.dataset.test === 'region-canvas') {
            idvRegionDashes.set(this.canvas, []);
            idvCanvasText.delete(this.canvas);
          }
          return clear.apply(this, args);
        };
        CanvasRenderingContext2D.prototype.setLineDash = function (pattern) {
          idvRegionDashes.get(this.canvas)?.push(pattern.join(','));
          return dash.call(this, pattern);
        };
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        const footprints = new WeakMap();
        globalThis.idvFootprints = footprints;
        const text = CanvasRenderingContext2D.prototype.fillText;
        globalThis.idvCanvasText = new WeakMap();
        CanvasRenderingContext2D.prototype.fillText = function (label, ...args) {
          let labels = idvCanvasText.get(this.canvas);
          if (!labels) idvCanvasText.set(this.canvas, labels = new Set());
          if (labels.size < 500) labels.add(String(label));
          return text.apply(this, [label, ...args]);
        };
        CanvasRenderingContext2D.prototype.drawImage = function (img, ...args) {
          const result = draw.apply(this, [img, ...args]);
          const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (w >= 300 && h >= 300) {
            const [x, y, dw, dh] = args.length === 8 ? args.slice(4) :
              args.length === 4 ? args : [args[0], args[1], w, h];
            const matrix = this.getTransform();
            const corners = [[x,y], [x+dw,y], [x,y+dh], [x+dw,y+dh]]
              .map(([u,v]) => matrix.transformPoint({x:u,y:v}));
            const area = Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) * dw * dh;
            if (area > this.canvas.width * this.canvas.height / 10) footprints.set(this.canvas, corners);
          }
          return result;
        };
    """)
    page = ctx.new_page()
    page.set_default_timeout(12000)
    errors: Dict[str, list] = {"console": [], "page": [], "http": [], "failed": [], "assets": [], "external": []}
    base_url = str(frontend_server["base"])
    page.on("console", lambda m: errors["console"].append(f"{m.text} @ {m.location.get('url', '')}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors["page"].append(str(e)))

    def on_request(req):
        url = req.url
        if not url.startswith(base_url) and not url.startswith(("data:", "blob:", "about:")):
            errors["external"].append(url)

    def on_response(resp):
        url = resp.url
        if url.startswith(base_url):
            if resp.status >= 400:
                errors["http"].append(f"{resp.status} {url}")
            if "/assets/" in url:
                errors["assets"].append((url, resp.status))

    page.on("request", on_request)
    page.on("response", on_response)
    page.on("requestfailed", lambda req: errors["failed"].append(
        f"{req.url} {req.failure} at {page.url} ({os.environ.get('PYTEST_CURRENT_TEST', '')})"
    ))
    # D-022 §3: one-time cold-cache warmup before yielding so rapid navigations in shared callers
    # do not abort in-flight .woff2/asset fetches; zero-error listeners remain 100% unfiltered.
    page.goto(base_url + "/", wait_until="networkidle")
    page.evaluate("""async () => {
        for (const f of ['Noto Serif SC', 'Cinzel', 'Cormorant Garamond', 'LXGW WenKai Screen']) {
            await document.fonts.load('16px "' + f + '"', f.includes('SC') || f.includes('WenKai') ? '庄园' : 'Manor');
        }
        for (const [spec, sample] of [
            ['600 italic 16px "Cormorant Garamond"', 'Manor'],
            ['700 italic 18px "Cormorant Garamond"', 'Stage'],
            ['600 16px "Noto Serif SC"', '庄园'],
            ['900 22px "Noto Serif SC"', '档案库'],
        ]) {
            await document.fonts.load(spec, sample);
        }
        await document.fonts.ready;
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('idv.flow.v1', JSON.stringify({ autoFlow: false }));
    }""")
    page.wait_for_load_state("networkidle")
    session = {
        "page": page,
        "errors": errors,
        "base": base_url,
        "shots": screenshot_dir,
        "browser_version": browser.version,
    }
    try:
        yield session
    finally:
        try:
            page.close()
            ctx.close()
        finally:
            try:
                browser.close()
            finally:
                pw.stop()


def _wait_canvas(page, min_opaque_ratio=0.5, min_colors=8, timeout=20.0, selector="[data-test=board-canvas]"):
    deadline = time.time() + timeout
    probe = None
    while time.time() < deadline:
        probe = page.evaluate(CANVAS_PROBE, selector)
        if probe and probe["w"] > 0 and probe["opaque"] >= probe["samples"] * min_opaque_ratio and probe["colors"] >= min_colors:
            return probe
        page.wait_for_timeout(250)
    raise AssertionError(f"canvas {selector} stayed blank: {probe}")


def _settle(page, ms=450):
    page.wait_for_timeout(ms)


def _sandbox_fit(page):
    page.click("[data-test=btn-view-settings]")
    page.click("[data-test=btn-reset]")
    page.click("[data-test=btn-view-close]")
    page.wait_for_function("document.querySelector('.scale text:last-of-type') !== null")


def _sandbox_geometry(page, world_width):
    # Ground-plane calibration from the actual drawImage quad, independent of the UI ruler.
    return page.evaluate("""worldWidth => {
        const rect = el => {
            const {x,y,width,height} = el.getBoundingClientRect();
            return {x,y,width,height};
        };
        const visible = sel => {
            const el = document.querySelector(sel);
            return el && el.getBoundingClientRect().width ? rect(el) : null;
        };
        const c = document.querySelector('[data-test=board-canvas]'), viewport = rect(c);
        const quad = idvFootprints.get(c).map(p => ({
            x: viewport.x + p.x * viewport.width / c.width,
            y: viewport.y + p.y * viewport.height / c.height
        }));
        const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
        const x = Math.max(viewport.x, Math.min(...xs)), y = Math.max(viewport.y, Math.min(...ys));
        const map = {x,y,width:Math.min(viewport.x+viewport.width,Math.max(...xs))-x,
            height:Math.min(viewport.y+viewport.height,Math.max(...ys))-y};
        const ticks = [...document.querySelectorAll('.scale text')].map(t => ({
            meters:parseFloat(t.textContent), cssX:new DOMPoint(t.x.baseVal[0].value,0).matrixTransform(t.getScreenCTM()).x
        }));
        return {map,quad,ticks,pxPerMeter:(quad[1].x-quad[0].x)/worldWidth*45/3.8,
            scale:visible('.scale'), director:visible('[data-test=director-bar]'), transport:visible('#transport'),
            dock:visible('.map-key'), strip:visible('#sandbox-legend'), viewport};
    }""", world_width)


def _overlap(a, b):
    return (max(0, min(a["x"]+a["width"], b["x"]+b["width"])-max(a["x"], b["x"])) *
            max(0, min(a["y"]+a["height"], b["y"]+b["height"])-max(a["y"], b["y"])))


def _check_folded_legend(page, shots, filename, obstacles):
    button = page.get_by_role("button", name="图例", exact=True)
    assert button.is_visible() and button.get_attribute("aria-expanded") == "false"
    box = button.bounding_box()
    assert all(_overlap(box, other) == 0 for other in obstacles)
    for key in ("Enter", "Space"):
        button.press(key)
        assert button.get_attribute("aria-expanded") == "true"
        strip = page.locator("#sandbox-legend")
        labels = strip.locator("span").all()
        assert len(labels) == 5 and all(label.is_visible() for label in labels)
        opened = strip.bounding_box()
        assert all(_overlap(opened, other) == 0 for other in obstacles)
        if key == "Enter":
            page.screenshot(path=str(shots / (filename + "-legend.png")))
        page.keyboard.press("Escape")
        assert button.get_attribute("aria-expanded") == "false"
        assert button.evaluate("el=>el===document.activeElement")
    return {"button": box, "openedStrip": opened, "keyboard": ["Enter/Escape", "Space/Escape"]}


def _sandbox_zoom(page, shots, world_width, mode, delta, expanded):
    assert page.locator(".scale").is_visible() and page.locator("#transport").is_visible()
    page.wait_for_function("idvFootprints.has(document.querySelector('[data-test=board-canvas]'))")
    fit = _sandbox_geometry(page, world_width)
    assert [t["meters"] for t in fit["ticks"]] == [0, 10, 20, 40], fit
    v = fit["viewport"]
    page.mouse.move(v["x"] + v["width"]/2, v["y"] + v["height"]/2)
    page.mouse.wheel(0, delta)
    page.wait_for_function("""before => {
        const c=document.querySelector('[data-test=board-canvas]'), q=idvFootprints.get(c);
        return q && (q[1].x-q[0].x)*c.clientWidth/c.width > before*1.1;
    }""", arg=fit["quad"][1]["x"]-fit["quad"][0]["x"])
    zoom = _sandbox_geometry(page, world_width)
    assert zoom["pxPerMeter"] > 1.1 * fit["pxPerMeter"]
    for state in (fit, zoom):
        ticks = state["ticks"]
        assert len(ticks) >= 2 and state["scale"] and state["transport"]
        for a,b in zip(ticks, ticks[1:]):
            assert abs((b["cssX"]-a["cssX"])-(b["meters"]-a["meters"])*state["pxPerMeter"]) <= 2, state
        if mode != "paused":
            assert state["director"] and _overlap(state["director"], state["scale"]) == 0, state
            assert _overlap(state["director"], state["transport"]) == 0, state
        if state["dock"]:
            assert _overlap(state["dock"], state["map"]) == 0, state
    filename = f"repair-{page.viewport_size['width']}-{mode}-{'open' if expanded else 'closed'}-{abs(delta)}"
    if mode == "paused":
        if delta == -640:
            assert zoom["dock"] is None
        if zoom["dock"]:
            assert page.locator(".map-key span").count() == 5
        else:
            zoom.update(_check_folded_legend(page, shots, filename, [zoom["map"]]))
    page.screenshot(path=str(shots / (filename + ".png")))
    (shots / (filename + ".json")).write_text(json.dumps({"fit":fit,"zoom":zoom,"wheelDelta":delta},indent=2), "utf8")


@pytest.mark.browser
class TestBrowserUi:
    def test_01_archive_loads_with_5_step_rail_and_real_assets(self, browser_session, api):
        page, base = browser_session["page"], browser_session["base"]
        page.goto(base + "/", wait_until="networkidle")
        page.wait_for_selector("#steps button[data-step='1'].on")
        assert "庄园战术复盘档案" in page.title()

        # Verify 5-step Manor Dossier navigation rail & lock states before match selection
        step_btns = page.locator("#steps button")
        assert step_btns.count() == 5
        assert step_btns.evaluate_all("(buttons) => buttons.map(b => b.dataset.step)") == ["1","2","3","4","5"]
        assert ["".join(t.split()) for t in step_btns.all_inner_texts()] == [
            "档案库MatchArchive", "战术沙盘TacticalSandbox", "对比分析MatchReview",
            "区域选点SpawnRegion", "密码机推演CipherDeduction",
        ]
        for s_open in (1, 2, 4, 5):
            assert "lock" not in (page.locator(f"#steps button[data-step='{s_open}']").get_attribute("class") or "").split()
        assert "lock" in (page.locator("#steps button[data-step='3']").get_attribute("class") or "").split()

        cards = page.locator(".mapcard")
        expect_n = len(api.get("/api/matches").json()["matches"])
        page.wait_for_function(f"document.querySelectorAll('.mapcard').length === {expect_n}")
        assert cards.count() >= 7
        for i in range(cards.count()):
            cards.nth(i).scroll_into_view_if_needed()
        page.wait_for_function(
            "[...document.querySelectorAll('.mapcard img')].every(i => i.complete && i.naturalWidth > 0)",
            timeout=20000,
        )
        n_img = page.evaluate("document.querySelectorAll('.mapcard img').length")
        assert n_img == cards.count()

        sizes = page.evaluate(
            """async (urls) => Promise.all(urls.map(u => new Promise(res => {
                 const im = new Image(); im.onload = () => res([u, im.naturalWidth, im.naturalHeight]);
                 im.onerror = () => res([u, 0, 0]); im.src = u; })))""",
            ["/assets/bg.jpg", "/assets/seal.jpg", "/assets/maps/唐人街_grid.jpg"],
        )
        for u, w, h in sizes:
            assert w > 0 and h > 0, u
        bg = page.evaluate("getComputedStyle(document.getElementById('fx')).backgroundImage")
        assert "/assets/bg.jpg" in bg
        statuses = browser_session["errors"]["assets"]
        assert any(u.endswith("/assets/bg.jpg") and s == 200 for u, s in statuses), statuses
        assert any("/assets/maps/" in u and s == 200 for u, s in statuses), statuses
        assert all(s in (200, 304) for _, s in statuses), statuses
        page.screenshot(path=str(browser_session["shots"] / "01_archive.png"))

    def test_02_standalone_stage2_declutter_and_whiteboard_tools(self, browser_session, e2e_tmp):
        page = browser_session["page"]
        if page.url == "about:blank":
            page.goto(browser_session["base"], wait_until="networkidle")
        # Enter Stage 2 directly before selecting any replay -> standalone 9-map whiteboard
        page.click("#steps button[data-step='2']")
        page.wait_for_selector("#steps button[data-step='2'].on")
        page.wait_for_selector("[data-test=sandbox-map-select]")
        assert "战术演练" in page.locator("#ctx").inner_text()
        assert page.locator("[data-test=sandbox-map-select] option").count() == 9

        # Decluttered Stage 2 layout checks: single-row #toolbar, closed popover by default, 3-tab #rightCol
        tb_box = page.locator("#toolbar").bounding_box()
        assert tb_box and tb_box["height"] < 64, tb_box
        assert not page.locator("[data-test=view-settings-popover]").is_visible()
        assert page.locator("#rightTabs button").count() == 3
        for tab in ("status", "tools", "events"):
            assert page.locator(f"#rightTabs button[data-right-tab='{tab}']").count() == 1
        assert "on" in page.locator("[data-right-tab='status']").get_attribute("class").split()

        probe = _wait_canvas(page)
        assert probe["cssW"] > 300 and probe["cssH"] > 300
        overlay_box = page.locator("[data-test=tactical-overlay-canvas]").bounding_box()
        assert overlay_box and overlay_box["width"] > 300 and overlay_box["height"] > 300, overlay_box

        # Popover open/close check + 永眠镇 (6) 90° calibration check
        page.select_option("[data-test=sandbox-map-select]", "6")
        _settle(page)
        assert "永眠镇" in page.locator("#vCell").inner_text()
        assert "永眠镇" in page.locator("#ctx").inner_text()
        _wait_canvas(page)
        page.click("[data-test=btn-view-settings]")
        assert page.locator("[data-test=view-settings-popover]").is_visible()
        assert "90°" in page.locator("[data-test=btn-rot]").inner_text()
        page.click("[data-test=btn-view-close]")
        assert not page.locator("[data-test=view-settings-popover]").is_visible()

        # Switch back to 军工厂 (0) for tactical whiteboard flows
        page.select_option("[data-test=sandbox-map-select]", "0")
        _settle(page)
        box = page.locator("[data-test=board-canvas]").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        # 1. Place token (Explorer + treasure ring) & hunter (BloodyQueen + AquaMirror)
        page.click("[data-tool='place']")
        page.wait_for_selector("[data-test=tool-panel-place]")
        assert "on" in page.locator("[data-right-tab='tools']").get_attribute("class").split()
        page.click("[data-test=place-camp-survivor]")
        page.click("[data-test=role-btn-explorer]")
        page.mouse.click(cx - 90, cy - 50)
        _settle(page, 250)
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() == 1
        page.locator("[data-test=toggle-treasure-range]").check()
        _settle(page, 200)

        page.click("[data-test=place-camp-hunter]")
        page.click("[data-test=role-btn-bloodyQueen]")
        page.mouse.click(cx + 80, cy - 30)
        _settle(page, 250)
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() == 2
        page.click("[data-test=prop-btn-aquaMirror]")
        page.mouse.click(cx + 120, cy + 20)
        _settle(page, 250)
        assert page.locator("[data-test=placed-list] [data-placed-prop]").count() >= 2  # aquaMirror + mirrorImage

        # 2. Draw shapes (arrow + text) & undo
        page.click("[data-tool='draw']")
        page.wait_for_selector("[data-test=tool-panel-draw]")
        page.click("[data-draw-shape='arrow']")
        page.mouse.move(cx - 120, cy + 60)
        page.mouse.down()
        page.mouse.move(cx + 40, cy + 20, steps=6)
        page.mouse.up()
        _settle(page, 250)
        assert page.locator("[data-shape-id]").count() == 1

        page.locator("[data-test=tac-text-input]").fill("大房转点")
        page.click("[data-draw-shape='text']")
        page.mouse.click(cx + 30, cy - 80)
        _settle(page, 250)
        assert page.locator("[data-text-id]").count() == 1
        overlay_probe = _wait_canvas(page, min_opaque_ratio=0.002, min_colors=2, selector="[data-test=tactical-overlay-canvas]")
        assert overlay_probe["w"] > 0
        page.click("[data-test=btn-tac-undo]")
        _settle(page, 200)
        assert page.locator("[data-text-id]").count() == 0
        assert page.locator("[data-shape-id]").count() == 1

        # 3. Multi-point polyline movement measurement (simulateMovement ETA + custom buff)
        page.click("[data-tool='measure']")
        page.wait_for_selector("[data-test=tool-panel-measure]")
        page.click("[data-test=btn-measure-chain]")
        page.mouse.click(cx - 130, cy + 10)
        _settle(page, 150)
        page.mouse.click(cx - 10, cy + 10)
        _settle(page, 150)
        page.mouse.click(cx - 10, cy + 110)
        _settle(page, 150)
        page.click("[data-test=btn-measure-finish]")
        page.wait_for_selector("[data-test=measure-sim-result]")
        sim_before = page.locator("[data-test=measure-sim-result]").inner_text()
        assert re.search(r"总长\s*\d+\.\d\s*m", sim_before) and re.search(r"耗时\s*\d+\.\d+\s*s", sim_before), sim_before
        page.locator("[data-test=custom-buff-pct]").fill("30")
        page.locator("[data-test=custom-buff-dur]").fill("5")
        page.click("[data-test=btn-add-custom-buff]")
        _settle(page, 200)
        sim_after = page.locator("[data-test=measure-sim-result]").inner_text()
        assert sim_after != sim_before

        # 4. Carry & Tide 5-band range overlays
        page.click("[data-tool='range']")
        page.wait_for_selector("[data-test=tool-panel-range]")
        page.click("[data-test=btn-range-mode-point]")
        page.mouse.click(cx, cy)
        page.wait_for_selector("[data-test=range-summary]")
        assert page.locator("[data-test=range-legend] [data-band]").count() == 5
        assert "狂欢之椅" in page.locator("[data-test=range-summary]").inner_text()
        assert page.locator("[data-test=range-chair-table] tbody tr").count() > 0
        page.click("[data-test=btn-range-tide]")
        _settle(page, 200)
        assert "20s" in page.locator("[data-test=range-summary]").inner_text()

        # 5. Waypoint animation & global timeline
        page.click("[data-tool='anim']")
        page.wait_for_selector("[data-test=tool-panel-anim]")
        page.wait_for_selector("[data-test=tac-anim-bar]")
        page.locator("[data-test=tool-panel-anim] .tac-chip-grid button").first.click()
        page.click("[data-test=btn-anim-arm]")
        page.mouse.click(cx + 50, cy - 60)
        _settle(page, 150)
        page.mouse.click(cx + 130, cy + 40)
        _settle(page, 200)
        assert page.locator("[data-test=anim-waypoint-list] .tac-list-row").count() == 3
        assert page.locator("[data-test=tac-anim-track]").count() >= 1
        page.click("[data-test=btn-anim-mode-time]")
        _settle(page, 150)
        max_anim = float(page.locator("[data-test=tac-anim-scrubber]").get_attribute("max"))
        assert max_anim > 0
        mid_anim = str(int(max_anim // 2)) if max_anim >= 2 else "0.1"
        page.locator("[data-test=tac-anim-scrubber]").fill(mid_anim)
        _settle(page, 200)
        assert not page.locator("[data-test=tac-anim-clock]").inner_text().startswith("0.0s /")

        page.screenshot(path=str(browser_session["shots"] / "02_sandbox_whiteboard.png"))

        # 6. localStorage persistence across reload, JSON export/import, and untainted PNG download
        assert page.evaluate("Boolean(localStorage.getItem('idv.pil.v2'))")
        page.click("[data-test=btn-tac-archive]")
        page.wait_for_selector("[data-test=archive-popover]")
        with page.expect_download(timeout=15000) as dl_json:
            page.click("[data-test=btn-export-json]")
        json_path = e2e_tmp / "whiteboard_export.json"
        dl_json.value.save_as(str(json_path))
        exported_raw = json_path.read_text(encoding="utf-8")
        exported_obj = json.loads(exported_raw)
        assert exported_obj["format"] == "idv-pil-board"
        assert len(exported_obj["board"]["tokens"]) == 2
        assert "已生成" in page.locator("[data-test=tac-archive-msg]").inner_text()

        # Reload standalone Stage 2 -> board auto-restores from localStorage
        page.reload(wait_until="networkidle")
        page.wait_for_selector("#steps button[data-step='2'].on")
        _wait_canvas(page)
        page.click("[data-tool='place']")
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() == 2

        # Untainted PNG export download (must produce valid PNG bytes > 5 KB)
        with page.expect_download(timeout=15000) as dl_png:
            page.click("[data-test=btn-tac-export]")
        png_path = e2e_tmp / "whiteboard_export.png"
        dl_png.value.save_as(str(png_path))
        png_bytes = png_path.read_bytes()
        assert png_bytes.startswith(PNG), "exported file missing PNG signature"
        assert len(png_bytes) > 5000, f"exported PNG unexpectedly small: {len(png_bytes)}"

        # Clear board -> verify cleared -> re-import JSON archive -> verify restored
        page.click("[data-test=btn-tac-clear]")
        _settle(page, 200)
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() == 0
        page.click("[data-test=btn-tac-archive]")
        page.set_input_files("[data-test=input-import-json]", str(json_path))
        page.wait_for_selector("[data-test=tac-archive-msg]")
        assert "已导入" in page.locator("[data-test=tac-archive-msg]").inner_text()
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() == 2

        # Leave whiteboard clean & return to inspect/status before Stage 4/5 & replay tests
        page.click("[data-test=btn-tac-archive]")
        page.click("[data-test=btn-tac-clear]")
        page.click("[data-tool='inspect']")
        page.click("[data-right-tab='status']")
        _settle(page, 200)

    def test_03_region_view_04_selection_lock_cipher_and_persistence(self, browser_session):
        page = browser_session["page"]
        page.click("#steps button[data-step='4']")
        page.wait_for_selector("#steps button[data-step='4'].on")
        page.wait_for_selector("[data-test=region-canvas]")
        assert page.locator("[data-test=region-map-select] option").count() == 9
        _wait_canvas(page, selector="[data-test=region-canvas]")

        # Verify 永眠镇 (6) has 10 zones & non-blank rotated canvas
        page.select_option("[data-test=region-map-select]", "6")
        _settle(page)
        assert page.locator("[data-zone-idx]").count() == 10
        _wait_canvas(page, selector="[data-test=region-canvas]")

        # Verify 军工厂 (0) survivor max 4, hunter max 1, mutual exclusion, lock cipher & table
        page.select_option("[data-test=region-map-select]", "0")
        _settle(page)
        assert page.locator("[data-zone-idx]").count() == 9
        page.locator("summary", has_text="区域列表").click()
        for z in (0, 1, 2, 3):
            page.click(f"[data-zone-idx='{z}']")
        page.click("[data-zone-idx='4']")  # 5th survivor zone blocked
        assert "最多选择 4 个区域" in page.locator("[data-test=region-msg]").inner_text()

        page.click("[data-test=region-side-hunter]")
        page.click("[data-zone-idx='0']")  # occupied by survivor
        assert "已被求生者选择" in page.locator("[data-test=region-msg]").inner_text()

        page.click("[data-zone-idx='4']")  # valid hunter zone
        _settle(page, 250)
        hunter_name = page.locator("[data-test=hunter-zone-name]").inner_text().strip()
        coord_txt = page.locator("[data-test=hunter-pixel-coord]").inner_text().strip()
        lock_name = page.locator("[data-test=lock-cipher-name]").inner_text().strip()
        lock_dist = page.locator("[data-test=lock-cipher-dist]").inner_text().strip()
        assert hunter_name and hunter_name != "--"
        assert re.match(r"^\d+,\s*\d+$", coord_txt), coord_txt
        assert lock_name and lock_name != "--"
        assert re.match(r"^\d+\.\d m$", lock_dist), lock_dist
        assert page.locator("[data-cipher-row]").count() == 7
        assert "封禁" in page.locator("[data-cipher-row].locked").inner_text()

        # Cycle cipher group & toggle display popover
        page.click("[data-test=region-cipher-next]")
        assert "第 2 /" in page.locator("[data-test=region-cipher-label]").inner_text()
        page.click("[data-test=region-display-btn]")
        assert page.locator("[data-test=region-display-popover]").is_visible()
        doors = page.locator("[data-test=region-show-doors]")
        initial = doors.is_checked()
        doors.set_checked(not initial)
        assert doors.is_checked() != initial
        doors.set_checked(initial)
        assert doors.is_checked() == initial
        page.click("[data-test=region-display-btn]")
        _settle(page, 250)
        page.screenshot(path=str(browser_session["shots"] / "04_region.png"))

        # Verify localStorage persistence across reload
        page.reload(wait_until="networkidle")
        page.wait_for_selector("#steps button[data-step='4'].on")
        _wait_canvas(page, selector="[data-test=region-canvas]")
        assert page.locator("[data-test=lock-cipher-name]").inner_text().strip() != "--"
        assert re.match(r"^\d+\.\d m$", page.locator("[data-test=lock-cipher-dist]").inner_text().strip())

        # Reset and switch to 唐人街 (7) to test cross-view map sync into 05 密码机推演
        page.click("[data-test=region-reset]")
        assert page.locator("[data-test=lock-cipher-name]").inner_text().strip() == "--"
        page.select_option("[data-test=region-map-select]", "7")
        _settle(page, 200)

    def test_04_deduce_view_05_marks_steps_contradiction_and_sync(self, browser_session):
        page = browser_session["page"]
        page.click("#steps button[data-step='5']")
        page.wait_for_selector("#steps button[data-step='5'].on")
        page.wait_for_selector("[data-test=deduce-map]")

        # Cross-view map sync: active map from 04 (唐人街 = 7) carries into 05
        assert page.locator("[data-test=deduce-map-select]").input_value() == "7"
        page.click("[data-cipher-name='花店']")
        page.click("[data-cipher-name='肉铺']")
        page.wait_for_selector("[data-test=deduce-steps] [data-step-idx]")
        chain_btn = page.locator("[data-step-idx]", has_text=re.compile("连线|裁缝铺内|醉芳庭")).first
        chain_btn.click()
        page.wait_for_selector("svg.ded-chain-svg polyline.chain-line")
        page.click("[data-test=deduce-reset]")

        # 永眠镇 (6): 90° calibrated grid image loads & rotates
        page.select_option("[data-test=deduce-map-select]", "6")
        page.wait_for_function(
            "(() => { const im = document.querySelector('.ded-map-img'); return im && im.complete && im.naturalWidth > 0; })()",
        )
        img = page.locator(".ded-map-img")
        assert img.get_attribute("data-rot-quadrants") == "1"
        assert "rotate(90deg)" in (img.get_attribute("style") or "")

        # 军工厂 (0): 必刷 lock, mark cycling, unique deduction + step highlight + layout preview
        page.select_option("[data-test=deduce-map-select]", "0")
        _settle(page, 250)
        locked = page.locator("[data-cipher-name='沙包']")
        assert locked.is_disabled()
        assert "必刷" in locked.inner_text()

        gate = page.locator("[data-cipher-name='正门']")
        assert "unknown" in gate.get_attribute("class").split()
        gate.click()
        assert "user-yes" in gate.get_attribute("class").split()
        gate.click()
        assert "user-no" in gate.get_attribute("class").split()
        gate.click()
        assert "unknown" in gate.get_attribute("class").split()

        for cname in ("伐木林", "四合院", "正门", "工厂外"):
            page.click(f"[data-cipher-name='{cname}']")
        assert page.locator("[data-test=deduce-conclusion]").inner_text().strip() == "第 1 组密码机"
        assert "7 / 7" in page.locator("[data-test=deduce-progress]").inner_text()
        assert page.locator("[data-test=deduce-steps] [data-step-idx]").count() > 0
        page.locator("[data-test=deduce-steps] [data-step-idx]").first.click()
        page.wait_for_selector("[data-test=deduce-map] .scope-ring")
        page.screenshot(path=str(browser_session["shots"] / "05_deduce.png"))

        # Candidate layout preview & return to live deduction
        page.click("[data-layout-idx='1']")
        assert page.locator("[data-test=deduce-conclusion]").inner_text().strip() == "第 2 组密码机"
        page.click("[data-test=deduce-layout-all]")
        assert page.locator("[data-test=deduce-conclusion]").inner_text().strip() == "第 1 组密码机"

        # Reset -> deliberate contradiction -> reload persistence -> reset
        page.click("[data-test=deduce-reset]")
        assert page.locator("[data-test=deduce-alert]").count() == 0
        page.click("[data-cipher-name='正门']")
        page.click("[data-cipher-name='正门废墟']")
        page.wait_for_selector("[data-test=deduce-alert]")
        assert "矛盾" in page.locator("[data-test=deduce-conclusion]").inner_text()

        page.reload(wait_until="networkidle")
        page.wait_for_selector("#steps button[data-step='5'].on")
        page.wait_for_selector("[data-test=deduce-alert]")
        page.click("[data-test=deduce-reset]")
        assert page.locator("[data-test=deduce-alert]").count() == 0

    def test_05_open_chinatown_replay_and_decluttered_stage2(self, browser_session):
        page = browser_session["page"]
        page.click("#steps button[data-step='1']")
        page.wait_for_selector("#steps button[data-step='1'].on")
        card = page.locator(f".mapcard[data-match='{CHINATOWN_MATCH}']")
        card.scroll_into_view_if_needed()
        assert "唐人街" in card.inner_text()
        card.click()
        page.wait_for_selector("#steps button[data-step='2'].on")
        page.wait_for_selector("[data-test=board-canvas]")
        page.wait_for_function("location.hash.includes('m=" + CHINATOWN_MATCH + "')")
        page.wait_for_function("""id => idvAppStore.replay?.match.match_id === id &&
            idvAppStore.analytics?.match_id === id""", arg=CHINATOWN_MATCH)
        assert "lock" not in (page.locator("#steps button[data-step='3']").get_attribute("class") or "").split()

        # Decluttered single-row #toolbar & closed popover
        tb_box = page.locator("#toolbar").bounding_box()
        assert tb_box and tb_box["height"] < 64, tb_box
        assert not page.locator("[data-test=view-settings-popover]").is_visible()

        probe = _wait_canvas(page)
        assert probe["cssW"] > 300 and probe["cssH"] > 300
        assert "唐人街" in page.locator("#ctx").inner_text()
        page.wait_for_function("document.querySelectorAll('#svRow .svtok').length === 4")
        assert page.locator("#svRow .svtok").count() == 4
        page.wait_for_function("(() => { const i = document.querySelector('#hSlot img'); return i && i.complete && i.naturalWidth > 0; })()")

        page.click("[data-test=btn-view-settings]")
        page.wait_for_selector("[data-test=btn-underlay]")
        assert "缺失" not in page.locator("[data-test=btn-underlay]").inner_text()
        page.click("[data-test=btn-view-close]")
        _settle(page, 250)
        page.screenshot(path=str(browser_session["shots"] / "02_sandbox_decluttered.png"))

        bookmark = page.locator(".bookmark span")
        assert bookmark.inner_text() == "唐人街"
        # Replay <-> Standalone whiteboard switch works cleanly
        if not page.locator("[data-test=btn-switch-whiteboard]").is_visible():
            page.click("#strip .hud-toggle")
        page.click("[data-test=btn-switch-whiteboard]")
        page.wait_for_selector("[data-test=sandbox-map-select]")
        page.locator("[data-test=sandbox-map-select]").select_option(label="军工厂")
        assert bookmark.inner_text() == "军工厂"
        page.click("[data-test=btn-switch-replay]")
        assert bookmark.inner_text() == "唐人街"
        page.wait_for_selector("#svRow .svtok")
        browser_session["probe_2d"] = probe

    def test_06_replay_switch_2d_3d_roaming_and_floor_filters(self, browser_session, cached_payloads):
        page = browser_session["page"]
        assert "on" in page.locator("[data-test=btn-2d]").get_attribute("class").split()
        assert page.locator("[data-test=btn-25d]").count() == 0, "Legacy 2.5D toggle must be removed"
        page.click("[data-test=btn-view-settings]")
        assert page.locator("[data-test=pitch]").count() == 0
        assert page.locator("[data-test=yscale]").count() == 0
        page.click("[data-test=btn-view-close]")
        p2d = _wait_canvas(page)
        assert p2d["hash"]

        # Switch to live offline 3D scene
        page.click("[data-test=btn-3d]")
        page.wait_for_function(
            "() => Boolean(window.__idv3dState && window.__idv3dState.ready === true && window.__idv3dState.sceneId === 'h55_chinatown')",
            timeout=30000,
        )
        page.wait_for_timeout(600)
        assert "on" in page.locator("[data-test=btn-3d]").get_attribute("class").split()
        s3d = page.evaluate("() => window.__idv3dState")
        assert s3d["playerCount"] == 5 and s3d["navTriangles"] > 0 and s3d["error"] is None, s3d
        page.screenshot(path=str(browser_session["shots"] / "02_sandbox_3d.png"))

        # Enter PIL-style 3D third-person roaming & verify WASD movement + telemetry + collision overlay
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
        page.locator("[data-test=roam-speed-preset]").select_option("hunter3")
        page.click("[data-test=btn-roam-collision]")
        page.wait_for_timeout(250)
        page.screenshot(path=str(browser_session["shots"] / "02_sandbox_3d_roam.png"))

        # Return to 2D via toolbar button
        page.click("[data-test=btn-2d]")
        page.locator("[data-test=board-canvas]").wait_for(state="visible", timeout=10000)
        _settle(page)
        assert "on" in page.locator("[data-test=btn-2d]").get_attribute("class").split()

        # Keyboard shortcuts 3 / 2 toggle 3D <-> 2D
        page.keyboard.press("3")
        page.wait_for_function(
            "() => Boolean(window.__idv3dState && window.__idv3dState.ready === true)",
            timeout=30000,
        )
        assert "on" in page.locator("[data-test=btn-3d]").get_attribute("class").split()
        page.keyboard.press("2")
        page.locator("[data-test=board-canvas]").wait_for(state="visible", timeout=10000)
        _settle(page, 250)
        assert "on" in page.locator("[data-test=btn-2d]").get_attribute("class").split()
        page.screenshot(path=str(browser_session["shots"] / "03_sandbox_2d.png"))

        # Floor filter B1 / 1F / 2F / ALL on 2D canvas
        floors = cached_payloads[CHINATOWN_MATCH]["replay"]["world"]["floors"]
        assert all(floors[f]["has_entities"] for f in ("B1", "1F", "2F"))
        base_hash = _wait_canvas(page)["hash"]
        hashes = {}
        for f in ("B1", "1F", "2F"):
            page.click(f"[data-floor='{f}']")
            _settle(page)
            assert "on" in page.locator(f"[data-floor='{f}']").get_attribute("class").split()
            hashes[f] = _wait_canvas(page, min_colors=4)["hash"]
        assert hashes["B1"] != hashes["1F"], hashes
        assert hashes["B1"] != base_hash, hashes
        page.click("[data-floor='ALL']")
        _settle(page)
        assert "on" in page.locator("[data-floor='ALL']").get_attribute("class").split()

    def test_07_replay_ruler_seek_3tab_rightcol_and_overlay(self, browser_session, cached_payloads, e2e_tmp):
        page = browser_session["page"]
        replay = cached_payloads[CHINATOWN_MATCH]["replay"]
        clock = page.locator("[data-test=clock]")

        # 2-point 45 u/s sprint ruler
        page.click("[data-test=btn-ruler]")
        assert page.locator("[data-test=btn-ruler]").inner_text().strip() == "测距中"
        box = page.locator("[data-test=board-canvas]").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.click(cx - 120, cy - 40)
        _settle(page, 200)
        page.mouse.click(cx + 140, cy + 60)
        page.wait_for_selector("[data-test=ruler-readout]", timeout=5000)
        txt = page.locator("[data-test=ruler-readout]").inner_text()
        assert re.search(r"\d+\.\du · \d+\.\ds", txt), txt
        assert "45 u/s" in txt
        page.click("[data-test=btn-ruler-clear]")
        page.click("[data-test=btn-ruler]")
        assert page.locator("[data-test=btn-ruler]").inner_text().strip() == "测距"
        page.wait_for_selector("[data-test=ruler-readout]", state="detached", timeout=5000)

        # Tab 1 (实时战况): dossier telemetry
        dossier = page.locator("#dossier")
        assert "战术档案" in dossier.inner_text()
        assert page.locator("#ciphers .cph").count() == 7

        # timeline marker seek + scrubber + +5s
        marker = replay["markers"][len(replay["markers"]) // 2]
        page.locator(f"#timeline .mk[data-marker='{marker['type']}']").first.click(force=True)
        _settle(page)
        target = min(m["t"] for m in replay["markers"] if m["type"] == marker["type"])
        assert abs(_clock_seconds(clock.inner_text()) - target) < 0.6, (clock.inner_text(), target)
        assert abs(_clock_seconds(page.locator("#vCell").inner_text()) - target) < 1.1

        page.locator("[data-test=scrubber]").fill("200")
        _settle(page)
        assert abs(_clock_seconds(clock.inner_text()) - 200.0) < 0.6
        page.click("[data-test=btn-fwd5]")
        _settle(page, 250)
        assert abs(_clock_seconds(clock.inner_text()) - 205.0) < 0.6

        # Switch #rightTabs -> 事件流 (events), click row -> seek + pulse
        page.click("[data-right-tab='events']")
        page.wait_for_selector("#feed li[data-event]")
        row = page.locator("#feed li[data-event] button").nth(3)
        row.scroll_into_view_if_needed()
        ev_t = _clock_seconds(row.locator(".t").inner_text())
        row.click()
        _settle(page)
        assert abs(_clock_seconds(clock.inner_text()) - ev_t) < 0.6
        page.wait_for_selector("[data-test=pulse]", timeout=5000)

        # Switch back to 实时战况 (status) -> inspector telemetry for a survivor
        page.click("[data-right-tab='status']")
        surv = [p for p in replay["players"] if p["camp"] == 2][0]
        page.click(f"#svRow .svtok[data-uid='{surv['uid']}']")
        _settle(page)
        insp = page.locator("[data-test=inspector]").inner_text()
        assert surv["player_name"] in insp
        talents = page.locator("[data-test=talents]").inner_text()
        assert any(t["name"] and t["name"] in talents for t in surv["talents"])
        page.click(f"#svRow .svtok[data-uid='{surv['uid']}']")  # release follow
        _wait_canvas(page)
        page.screenshot(path=str(browser_session["shots"] / "04_sandbox_dossier.png"))

        # Replay + PIL tactical overlay & untainted PNG export
        page.click("[data-tool='place']")
        page.click("[data-test=place-camp-survivor]")
        page.click("[data-test=role-btn-seer]")
        page.mouse.click(cx + 20, cy - 20)
        _settle(page, 200)
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() >= 1
        with page.expect_download(timeout=15000) as dl_png:
            page.click("[data-test=btn-tac-export]")
        replay_png = e2e_tmp / "replay_overlay.png"
        dl_png.value.save_as(str(replay_png))
        raw = replay_png.read_bytes()
        assert raw.startswith(PNG) and len(raw) > 5000
        page.click("[data-test=btn-tac-clear]")
        page.click("[data-tool='inspect']")
        page.click("[data-right-tab='status']")

    def test_08_analytics_phase_cards_and_survivors(self, browser_session, cached_payloads):
        page = browser_session["page"]
        an = cached_payloads[CHINATOWN_MATCH]["analytics"]
        page.click("#steps button[data-step='3']")
        page.wait_for_selector("#steps button[data-step='3'].on")
        page.wait_for_selector(".phase[data-phase]")
        phases = page.locator(".phase[data-phase]")
        assert phases.count() == len(an["phases"]) == 3
        text = " ".join(phases.all_inner_texts())
        for label in ("开局博弈", "中期运营", "开门战/残局"):
            assert label in text
        kpis = page.locator("[data-test=hunter-kpis]").inner_text()
        assert an["hunter_metrics"]["player_name"] in kpis
        rows = page.locator("[data-test=survivor-table] tbody tr")
        assert rows.count() == 4
        for s in an["survivor_metrics"]:
            row = page.locator(f"[data-test=survivor-table] tbody tr[data-uid='{s['uid']}']")
            t = row.inner_text()
            assert s["player_name"] in t
            shown = re.findall(r"(\d+\.\d)%", t)
            assert shown and abs(float(shown[0]) - s["cipher_contrib_pct"]) <= 0.051, (t, s["cipher_contrib_pct"])
            assert f"{s['ciphers_finished']}台" in t
            width = row.locator(".pbar i").evaluate("e => parseFloat(e.style.width)")
            assert abs(width - max(0.0, min(100.0, s["cipher_contrib_pct"]))) < 0.01
        assert page.locator("[data-test=distance-chart] svg path").count() >= 4
        page.screenshot(path=str(browser_session["shots"] / "05_analytics.png"), full_page=True)
        # phase card jumps back into the sandbox at start_t
        mid = an["phases"][1]
        page.click(".phase[data-phase='midgame']")
        page.wait_for_selector("#steps button[data-step='2'].on")
        assert abs(_clock_seconds(page.locator("[data-test=clock]").inner_text()) - mid["start_t"]) < 0.6
        _wait_canvas(page)

    def test_09_deep_links_and_ui_upload(self, browser_session, e2e_tmp):
        page, base = browser_session["page"], browser_session["base"]
        # Force a single document navigation. A same-document hash change followed by
        # reload can abort the previous page's in-flight portrait request.
        page.goto(f"{base}/?case=replay-link#m={CHINATOWN_MATCH}&s=2&t=120", wait_until="networkidle")
        page.wait_for_selector("#steps button[data-step='2'].on")
        _wait_canvas(page)
        assert abs(_clock_seconds(page.locator("[data-test=clock]").inner_text()) - 120.0) < 0.6

        # Standalone deep link (#s=4&map=6 -> 04 区域选点 · 永眠镇 10 zones)
        page.goto(f"{base}/?case=standalone-link#s=4&map=6", wait_until="networkidle")
        page.wait_for_selector("#steps button[data-step='4'].on")
        assert page.locator("[data-test=region-map-select]").input_value() == "6"
        assert page.locator("[data-zone-idx]").count() == 10

        # Real .zip upload through the UI drop-zone file input
        page.click("#steps button[data-step='1']")
        page.wait_for_selector("[data-test=file-input]", state="attached")
        zpath = e2e_tmp / "bot_replay.zip"
        zpath.write_bytes(build_replay_zip(BOT_MATCH))
        page.set_input_files("[data-test=file-input]", str(zpath))
        page.wait_for_selector("[data-test=upload-msg]", timeout=60000)
        assert page.locator("[data-test=upload-err]").count() == 0
        page.wait_for_selector("[data-test=open-uploaded]")
        page.click("[data-test=open-uploaded]")
        page.wait_for_selector("#steps button[data-step='2'].on")
        page.wait_for_function(f"location.hash.includes('m={BOT_MATCH}')")
        _wait_canvas(page)

    def test_sandbox_paused_legend_pan(self, browser_session, cached_payloads):
        page, shots = browser_session["page"], browser_session["shots"]
        page.set_viewport_size({"width": 1366, "height": 768})
        page.goto(browser_session["base"] + "/?case=pan#s=1&auto=0", wait_until="networkidle")
        page.locator(f".mapcard[data-match='{CHINATOWN_MATCH}'] [data-test=entry-replay]").click()
        page.wait_for_selector(".case-lineup")
        if page.evaluate("idvAppStore.playing"):
            page.click("[data-test=btn-play]")
        page.locator("[data-test=scrubber]").fill("120")
        toggle = page.locator("#stage2 .folio-toggle")
        if toggle.get_attribute("aria-expanded") == "false":
            toggle.click()
        _sandbox_fit(page)
        page.evaluate("document.fonts.ready")
        page.wait_for_selector(".map-key.right")
        world = cached_payloads[CHINATOWN_MATCH]["replay"]["world"]["map_underlay"]["world_rect"]
        world_width = world["max_x"] - world["min_x"]
        fit = _sandbox_geometry(page, world_width)
        fit_obstacles = {s: page.locator(s).bounding_box() for s in (".map-badges", ".bookmark", ".compass", ".scale")}
        assert all(b and b["width"] > 0 and b["height"] > 0 for b in fit_obstacles.values())
        # Positive side-docking clearance at fit: right legend clears projected map and all board HUD/instruments.
        assert fit["dock"] is not None
        assert _overlap(fit["dock"], fit["map"]) == 0
        assert all(_overlap(fit["dock"], obs) == 0 for obs in fit_obstacles.values())
        v = fit["viewport"]
        x, y = v["x"] + v["width"] / 2, v["y"] + v["height"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 325, y, steps=10)
        page.mouse.up()
        page.wait_for_function("""start => {
            const c = document.querySelector('[data-test=board-canvas]'), r = c.getBoundingClientRect();
            return Math.abs(r.x + idvFootprints.get(c)[0].x * r.width/c.width - start - 325) < 1;
        }""", arg=fit["quad"][0]["x"])
        pan = _sandbox_geometry(page, world_width)
        page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        assert _sandbox_geometry(page, world_width)["quad"] == pan["quad"]
        assert page.evaluate("!idvAppStore.playing && idvAppStore.t === 120")
        assert pan["dock"] is None and toggle.get_attribute("aria-expanded") == "true"
        assert page.locator(".map-badges span").inner_text() == "1/7 机"
        obstacles = {s: page.locator(s).bounding_box() for s in (".map-badges", ".bookmark", ".compass")}
        assert all(b and b["width"] > 0 and b["height"] > 0 for b in obstacles.values())
        right_dock = fit["dock"]
        right_inset = v["x"] + v["width"] - right_dock["x"] - right_dock["width"]
        left_dock = {**right_dock, "x": v["x"] + right_inset}
        assert _overlap(left_dock, pan["map"]) == 0
        assert _overlap(left_dock, obstacles[".map-badges"]) > 0
        name = "pan-1366-paused-open-325"
        page.screenshot(path=str(shots / (name + ".png")))
        keyboard = _check_folded_legend(page, shots, name, [pan["map"], *obstacles.values()])
        assert keyboard["button"]["y"] >= v["y"] + v["height"]
        (shots / (name + ".json")).write_text(json.dumps({
            "fit": fit, "pan": pan, "rejectedLeftDock": left_dock, "obstacles": obstacles,
            "badge": "1/7 机", **keyboard,
        }, ensure_ascii=False, indent=2), "utf8")

    def test_sandbox_paused_legend_zoom(self, browser_session, cached_payloads):
        page = browser_session["page"]
        world = cached_payloads[CHINATOWN_MATCH]["replay"]["world"]["map_underlay"]["world_rect"]
        page.goto(f"{browser_session['base']}/?case=legend#m={CHINATOWN_MATCH}&s=2&auto=0&t=120", wait_until="networkidle")
        page.wait_for_selector(".case-lineup")
        for width, height in [(1366,768),(1440,900),(1920,1080)]:
            page.set_viewport_size({"width":width,"height":height})
            for expanded in (True, False):
                toggle = page.locator("#stage2 .folio-toggle")
                if toggle.get_attribute("aria-expanded") != str(expanded).lower():
                    toggle.click()
                _sandbox_fit(page)
                assert page.evaluate("!idvAppStore.playing && idvAppStore.t === 120")
                _sandbox_zoom(page, browser_session["shots"], world["max_x"]-world["min_x"], "paused", -320, expanded)
                if not expanded:
                    _sandbox_fit(page)
                    _sandbox_zoom(page, browser_session["shots"], world["max_x"]-world["min_x"], "paused", -640, expanded)
        page.locator("#stage2 .folio-toggle").click()
        page.set_viewport_size({"width":1600,"height":1000})

    def test_10_director_phase3_dual_paths(self, browser_session, cached_payloads):
        page, base = browser_session["page"], browser_session["base"]
        page.goto(base, wait_until="networkidle")
        page.evaluate("""() => {
            for (const key of ['idv.pil.v2', 'idv.pil.v2.link', 'idv.flow.v1', 'idv.practice.v1']) localStorage.removeItem(key);
        }""")
        page.reload(wait_until="networkidle")
        page.click("[data-test=flow-settings]")
        page.click("[data-test=flow-toggle-auto]")
        page.click("[data-test=flow-settings]")
        sizes = [(1366, 768, 658), (1440, 900, 790), (1920, 1080, 970)]

        def director_bounds(mode):
            for width, height, _ in sizes:
                page.set_viewport_size({"width": width, "height": height})
                assert page.evaluate("idvFlowStore.mode === 'pro-opening' ? idvFlowStore.segment.mode : idvFlowStore.director") == mode
                bounds = page.evaluate("""() => {
                    const director = document.querySelector('[data-test=director-bar]').getBoundingClientRect();
                    const others = document.querySelectorAll('.scale, .board .hud, #transport, #boardPanel button:not(.director button)');
                    return [...others].filter(el => {
                        const r = el.getBoundingClientRect();
                        return r.width && r.height && r.left < director.right && r.right > director.left &&
                          r.top < director.bottom && r.bottom > director.top;
                    }).map(el => el.className || el.id);
                }""")
                assert page.locator(".board .hud").is_visible()
                assert page.locator("#transport").is_visible()
                assert page.locator(".scale").is_visible() and page.locator("[data-test=director-bar]").is_visible()
                assert bounds == [], (mode, width, bounds)
            page.set_viewport_size({"width": 1600, "height": 1000})

        def zoom_director(mode):
            world = cached_payloads[CHINATOWN_MATCH]["replay"]["world"]["map_underlay"]["world_rect"]
            for width, height, _ in sizes:
                page.set_viewport_size({"width":width,"height":height})
                for expanded in (True, False):
                    toggle = page.locator("#stage2 .folio-toggle")
                    if toggle.get_attribute("aria-expanded") != str(expanded).lower():
                        toggle.click()
                    _sandbox_fit(page)
                    if mode in ("running", "suspended"):
                        page.get_by_role("button", name="恢复", exact=True).click()
                        if mode == "suspended":
                            page.get_by_role("button", name="自由观看").click()
                    assert page.evaluate("idvFlowStore.mode === 'pro-opening' ? idvFlowStore.segment.mode : idvFlowStore.director") == mode
                    _sandbox_zoom(page, browser_session["shots"], world["max_x"]-world["min_x"], mode, -640, expanded)
            page.locator("#stage2 .folio-toggle").click()
            page.set_viewport_size({"width":1600,"height":1000})

        def sealed():
            assert page.evaluate("""() => {
                const s = idvAppStore, f = idvFlowStore;
                return f.mode === 'blind' && f.reveal === null && f.link === null &&
                  s.replay === null && s.analytics === null && s.analyticsById[s.selectedId] === undefined;
            }""")

        def map_bounds(step, mode):
            toggle = page.locator(f"#s{step} [data-test=folio-toggle]")
            for width, height, minimum in sizes:
                page.set_viewport_size({"width": width, "height": height})
                for expanded in ("true", "false"):
                    if toggle.get_attribute("aria-expanded") != expanded:
                        toggle.click()
                    stage = page.locator(f"#s{step} .pil-board-wrap").bounding_box()
                    if step == 4:
                        # D-025 §1: Stage 04 submode bar (56px open / 50px closed) + board height conserves height - 110
                        submode_total = page.evaluate("""() => {
                          const s = document.querySelector('#regionView > .region-submode-bar')?.getBoundingClientRect();
                          const m = document.querySelector('#regionView > .pil-main')?.getBoundingClientRect();
                          return s && m ? +(m.top - s.top).toFixed(2) : 0;
                        }""")
                        assert 48.0 <= submode_total <= 58.0, (mode, step, width, submode_total)
                        assert stage["height"] >= minimum - 56 - 0.5, (mode, step, width, expanded, stage, submode_total)
                        assert stage["height"] + submode_total >= minimum - 0.5, (mode, step, width, expanded, stage, submode_total)
                    else:
                        assert stage["height"] >= minimum, (mode, step, width, expanded, stage)
                    if mode == "blind":
                        sealed()
            toggle.click()
            page.set_viewport_size({"width": 1600, "height": 1000})

        page.evaluate("""() => {
            globalThis.pathClicks = 0;
            document.addEventListener('click', () => pathClicks++, true);
        }""")
        archive = build_replay_zip(CHINATOWN_MATCH)
        page.evaluate("""encoded => {
            const bytes = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], 'path1.zip', {type:'application/zip'}));
            window.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, cancelable: true}));
            window.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, cancelable: true}));
        }""", base64.b64encode(archive).decode("ascii"))
        page.wait_for_selector("#s2 #boardPanel", timeout=60000)
        page.wait_for_selector("[data-test=director-bar]")
        page.wait_for_selector("#s2 [data-test=flow-next]")
        chase = cached_payloads[CHINATOWN_MATCH]["analytics"]["hunter_metrics"]["first_chase_t"]
        if chase is not None:
            page.wait_for_function(r"""cue => {
                const clock = document.querySelector('[data-test=clock]')?.textContent || '';
                const time = clock.match(/(\d+):(\d+(?:\.\d+)?)/);
                return time && document.querySelector('[data-test=speed]')?.value === '1' && Number(time[1])*60 + Number(time[2]) >= cue;
            }""", arg=max(0, chase - 3))
        assert page.evaluate("pathClicks") == 0
        assert page.evaluate("idvFlowStore.director") == "running"
        director_bounds("running")
        page.screenshot(path=str(browser_session["shots"] / "path1-open.png"))
        page.click("#s2 [data-test=flow-next]")
        page.wait_for_selector("[data-test=region-link]")
        assert page.evaluate("pathClicks") == 1
        # Existing Phase 2 edits may have marked this map as manual. Preserve that check.
        if "已联动" not in page.locator("[data-test=region-link]").inner_text():
            pytest.fail("fresh replay should link without overwriting or requiring manual confirmation")
        assert page.locator("[data-cipher-row]").count() == 7
        page.click("#s4 [data-test=flow-next]")
        assert "7 / 7" in page.locator("[data-test=deduce-progress]").inner_text()
        assert page.evaluate("pathClicks") == 2  # Path 1 completes at 05.
        page.click("#s5 [data-test=flow-next]")
        page.wait_for_selector("#s2 #boardPanel")
        assert f"m={CHINATOWN_MATCH}" in page.url
        assert page.evaluate("pathClicks") == 3  # Optional return to the replay.
        assert page.evaluate("idvFlowStore.director") == "suspended"
        director_bounds("suspended")
        zoom_director("running")
        zoom_director("suspended")

        page.click("#steps button[data-step='1']")
        page.locator(f".mapcard[data-match='{CHINATOWN_MATCH}'] [data-test=entry-practice]").click()
        page.wait_for_selector("[data-test=practice-blind]")
        assert page.locator("[data-test=practice-spawn-diff], [data-test=practice-cipher-diff], #ciphers, #svRow, [data-test=practice-reveal]").count() == 0
        page.wait_for_function("idvFlowStore.truthReady")
        map_bounds(4, "blind")
        names = [player["player_name"] for player in cached_payloads[CHINATOWN_MATCH]["replay"]["players"]]
        assert page.locator("#steps button[data-step='3']").get_attribute("class") == "lock"
        assert page.locator("[data-test=region-canvas]").evaluate(
            "(el, names) => ![...idvCanvasText.get(el) || []].some(label => names.some(name => label.includes(name)))", names,
        )
        page.get_by_role("button", name="开局草稿 → 02").click()
        page.wait_for_selector("[data-test=practice-draft]")
        assert page.locator("#ciphers, #svRow, #timeline .mk").count() == 0
        assert page.locator("[data-test=btn-play]").is_disabled()
        sealed()
        assert page.locator(".bookmark span").inner_text() == "唐人街"
        draft_canvas = page.locator("[data-test=board-canvas]")
        draft = page.locator("#stage2")
        assert draft.locator(".hunter-entry, .roster-grid, .case-notes, .verdict, .wax-seal").count() == 0
        published = draft.evaluate("""el => [
            el.textContent, ...Array.from(el.querySelectorAll('[aria-label],[title],[alt]'),
              e => ['aria-label','title','alt'].map(key => e.getAttribute(key)).join(' ')),
            ...Array.from(el.querySelectorAll('canvas')).flatMap(c => [...idvCanvasText.get(c) || []])
        ].join(' ')""")
        assert all(name not in published for name in names)
        page.screenshot(path=str(browser_session["shots"] / "sandbox-blind-draft.png"))
        bounds = draft_canvas.bounding_box()
        page.click("[data-tool='draw']")
        x = bounds["x"] + bounds["width"] * .42
        y = bounds["y"] + bounds["height"] * .52
        page.mouse.move(x - 50, y + 35)
        page.mouse.down()
        page.mouse.move(x + 75, y - 40, steps=6)
        page.mouse.up()
        page.click("#s2 [data-test=flow-next]")
        page.wait_for_selector("[data-test=practice-blind]")
        page.locator("summary", has_text="区域列表").click()
        for zone in range(5):
            page.click(f"[data-zone-idx='{zone}']")
        assert "求生 4/4 · 监管 1/1" in page.locator("[data-test=practice-blind]").inner_text()
        page.locator("summary", has_text="区域列表").click()
        page.screenshot(path=str(browser_session["shots"] / "path2-blind.png"))
        page.click("#s4 [data-test=flow-next]")
        assert page.locator("[data-test=practice-cipher-diff], [data-test=practice-reveal]").count() == 0
        map_bounds(5, "blind")
        page.locator(".ded-marker:not([disabled])").first.click()
        page.click("#s5 [data-test=flow-next]")
        page.click("[data-test=practice-lock]")
        assert page.locator("[data-test=practice-spawn-point]").count() == 5
        assert re.search(r"盲练 \d+ 分", page.locator("[data-test=practice-score]").inner_text())
        history = page.evaluate("JSON.parse(localStorage.getItem('idv.practice.v1')).at(-1)")
        assert history["matchId"] == CHINATOWN_MATCH
        assert history["attempt"]["survivorZones"] == [0, 1, 2, 3]
        assert history["attempt"]["hunterZone"] == 4
        analysis_step = page.locator("#steps button[data-step='3']")
        assert "lock" in analysis_step.get_attribute("class").split()
        assert analysis_step.get_attribute("title") == "请先在档案库选择对局"
        analysis_step.click()
        assert page.evaluate("""idvAppStore.step === 4 && idvAppStore.replay === null &&
            idvAppStore.analytics === null && idvFlowStore.reveal.truth.matchId === idvAppStore.selectedId""")
        map_bounds(4, "revealed")
        page.click("#s4 [data-test=flow-next]")
        map_bounds(5, "revealed")
        page.click("#s5 [data-test=flow-next]")
        page.locator("[data-cipher-row]").first.click()
        rings = "el => idvRegionDashes.get(el)"
        region = page.locator("[data-test=region-canvas]")
        lock_name = page.locator("[data-test=lock-cipher-name]").inner_text().strip()
        assert lock_name and lock_name != "--"
        assert {"5,4", "3,2"}.issubset(region.evaluate(rings))
        assert region.evaluate("(el, name) => idvCanvasText.get(el)?.has('预测封禁 · ' + name) === true", lock_name)
        layer = page.get_by_label("出生点图层")
        layer.select_option("pro")
        assert {"5,4", "3,2"}.isdisjoint(region.evaluate(rings))
        assert not region.evaluate("el => [...(idvCanvasText.get(el) || [])].some(t => t.startsWith('预测封禁 · '))")
        assert page.locator("[data-test=practice-spawn-point]").count() == 5
        layer.select_option("both")
        page.screenshot(path=str(browser_session["shots"] / "path2-reveal.png"))
        page.click("[data-test=practice-opening]")
        page.wait_for_selector("[data-test=director-bar][data-mode=opening60]")
        assert page.evaluate("""id => idvAppStore.step === 2 && idvAppStore.playing && idvAppStore.speed === 1 &&
            idvFlowStore.segment.start === 0 && idvAppStore.replay.match.match_id === id &&
            idvAppStore.analytics.match_id === id""", CHINATOWN_MATCH)
        assert "lock" not in analysis_step.get_attribute("class").split()
        assert _clock_seconds(page.locator("[data-test=clock]").inner_text()) < 4
        director_bounds("opening60")
        zoom_director("opening60")
        assert page.locator("[data-test=practice-draft-ghost]").is_checked()
        page.screenshot(path=str(browser_session["shots"] / "path2-opening60.png"))
        analysis_step.click()
        assert page.evaluate("idvFlowStore.mode") == "revealed"
        match_b = PID102_MATCH  # A different map makes stale 04 map selection visible too.
        row = page.locator(f"[data-test=matrix] tr[data-match='{match_b}']")
        row.click()
        page.wait_for_function("""id => idvAppStore.selectedId === id && idvAppStore.replay?.match.match_id === id &&
            idvAppStore.analytics?.match_id === id""", arg=match_b)
        assert "cur" in row.get_attribute("class").split()
        assert cached_payloads[match_b]["analytics"]["hunter_metrics"]["player_name"] in page.locator("[data-test=hunter-kpis]").inner_text()
        page.click("#steps button[data-step='4']")
        map_select = page.locator("[data-test=region-map-select]")
        assert map_select.is_enabled()
        assert map_select.locator("option:checked").inner_text() == cached_payloads[match_b]["replay"]["match"]["map_name"]
        assert page.evaluate("""id => idvAppStore.step === 4 && idvAppStore.selectedId === id &&
            idvAppStore.replay.match.match_id === id && idvAppStore.analytics.match_id === id &&
            idvFlowStore.mode === 'idle' && idvFlowStore.reveal === null && !idvFlowStore.truthReady""", match_b)
        assert page.locator("[data-test=practice-reveal], [data-test=practice-score], [data-test=practice-opening]").count() == 0
        page.goto(f"{base}/?case=manual-link#m={CHINATOWN_MATCH}&s=2&t=12&auto=0", wait_until="networkidle")
        assert _clock_seconds(page.locator("[data-test=clock]").inner_text()) == 12
        assert "手动" in page.locator("[data-test=flow-settings]").inner_text()

    def test_11_phase3_layout_fonts_and_map_footprints(self, browser_session):
        from PIL import Image
        page, base = browser_session["page"], browser_session["base"]
        page.goto(f"{base}/?case=layout#m={CHINATOWN_MATCH}&s=2&t=0&auto=0", wait_until="networkidle")
        fonts = page.evaluate("""async () => {
            for (const [family, sample] of [['Noto Serif SC','庄园'], ['Cinzel','II']]) {
              const loaded = await document.fonts.load('400 16px "' + family + '"', sample);
              if (!loaded.length || !document.fonts.check('400 16px "' + family + '"', sample)) return false;
            }
            return true;
        }""")
        assert fonts
        # D-016 desktop geometry table & Attempt-2 Chinatown footprint denominators
        attempt2_chinatown_area = {1366: 597 * 574, 1440: 730 * 700, 1920: 910 * 872}
        for width, height in ((1366, 768), (1440, 900), (1920, 1080)):
            page.set_viewport_size({"width": width, "height": height})
            margin = 10 if width < 1440 else 12 if width < 1600 else 16
            desk = width * 0.05
            folio_expected_w = width * 0.32
            board_expected_x = margin + desk
            board_expected_w = width - 2 * margin - desk - 10 - folio_expected_w
            closed_expected_w = width - 2 * margin
            for step, panel, board_sel, folio_sel, artwork in (
                (2, "#boardPanel", "#s2 .board", "#rightCol", "[data-test=board-canvas]"),
                (4, "#s4 .pil-main", "#s4 .pil-board-wrap", "#s4 .folio-stack", "[data-test=region-canvas]"),
                (5, "#s5 .pil-main", "#s5 .pil-board-wrap", "#s5 .folio-stack", ".ded-map-img"),
            ):
                if not page.locator(f"#steps button[data-step='{step}'].on").count():
                    page.click(f"#steps button[data-step='{step}']")
                bar = page.locator("#bar").bounding_box()
                assert bar["height"] == 60 and bar["x"] == 0
                assert page.locator("#steps button[data-step]").count() == 5
                assert page.locator("#stage").bounding_box()["x"] == 0
                assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
                toggle = page.locator(".step.show [data-test=folio-toggle]")
                if toggle.get_attribute("aria-expanded") == "false":
                    toggle.click()
                page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                open_box = page.locator(panel).bounding_box()
                board_box = page.locator(board_sel).bounding_box()
                folio_box = page.locator(folio_sel).bounding_box()
                open_width = open_box["width"]
                if step == 4:
                    # D-025 §1: Stage 04 submode bar (56px) + board height conserves height - 110
                    submode_h = page.evaluate("""() => {
                      const s = document.querySelector('#regionView > .region-submode-bar')?.getBoundingClientRect();
                      const m = document.querySelector('#regionView > .pil-main')?.getBoundingClientRect();
                      return s && m ? +(m.top - s.top).toFixed(2) : 0;
                    }""")
                    assert 54.0 <= submode_h <= 58.0, (width, submode_h)
                    expected_h = height - 110 - submode_h
                else:
                    expected_h = height - (120 if step == 2 else 110)
                assert abs(open_box["x"] - board_expected_x) <= 0.25, (width, step, open_box, board_expected_x)
                assert abs(open_width - board_expected_w) <= 0.25, (width, step, open_width, board_expected_w)
                assert abs(folio_box["x"] - (open_box["x"] + open_width + 10)) <= 0.25, (width, step, folio_box, open_box)
                assert abs(folio_box["width"] - folio_expected_w) <= 0.25, (width, step, folio_box, folio_expected_w)
                assert abs(board_box["height"] - expected_h) <= 0.5, (width, step, board_box, expected_h)
                toggle.click()
                page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                collapsed_width = page.locator(panel).bounding_box()["width"]
                collapsed_h = page.locator(board_sel).bounding_box()["height"]
                if step == 4:
                    closed_submode_h = page.evaluate("""() => {
                      const s = document.querySelector('#regionView > .region-submode-bar')?.getBoundingClientRect();
                      const m = document.querySelector('#regionView > .pil-main')?.getBoundingClientRect();
                      return s && m ? +(m.top - s.top).toFixed(2) : 0;
                    }""")
                    assert 48.0 <= closed_submode_h <= 58.0, (width, closed_submode_h)
                    expected_closed_h = height - 110 - closed_submode_h
                else:
                    expected_closed_h = expected_h
                assert abs(collapsed_width - closed_expected_w) <= 0.25 and collapsed_width >= width * .98
                assert abs(collapsed_h - expected_closed_h) <= 0.5
                print(f"{width}×{height} 0{step}: topbar=60px rail=0px open={open_width:.1f}px folio={folio_box['width']:.1f}px collapsed={collapsed_width:.1f}px")
                toggle.click()
                page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                if step == 5:
                    page.wait_for_function("""() => {
                        const im = document.querySelector('.ded-map-img');
                        return im?.complete && im.naturalWidth && im.src.startsWith('data:');
                    }""")
                else:
                    page.wait_for_function("sel => idvFootprints.has(document.querySelector(sel))", arg=artwork)
                bounds = page.locator(artwork).evaluate("""el => {
                    const rect = el.getBoundingClientRect();
                    const corners = idvFootprints.get(el);
                    if (!corners) return [rect.left, rect.top, rect.right, rect.bottom];
                    const xs = corners.map(p => rect.left + p.x * rect.width / el.width);
                    const ys = corners.map(p => rect.top + p.y * rect.height / el.height);
                    return [Math.max(rect.left, Math.min(...xs)), Math.max(rect.top, Math.min(...ys)),
                        Math.min(rect.right, Math.max(...xs)), Math.min(rect.bottom, Math.max(...ys))];
                }""")
                fp_w = bounds[2] - bounds[0]
                fp_h = bounds[3] - bounds[1]
                assert fp_w / open_width >= 0.70, (width, step, fp_w, open_width)
                if step == 2:
                    assert (fp_w * fp_h) / attempt2_chinatown_area[width] >= 0.95, (width, fp_w * fp_h, attempt2_chinatown_area[width])
                png = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
                fp = png.crop((max(0, math.ceil(bounds[0])), max(math.ceil(bar["y"] + bar["height"]), math.ceil(bounds[1])),
                               min(width, math.floor(bounds[2])), min(height, math.floor(bounds[3]))))
                values = sorted(round(.2126*r + .7152*g + .0722*b) for r, g, b in fp.getdata())
                median, p95 = values[len(values)//2], values[int(.95 * (len(values)-1))]
                print(f"{width}×{height} 0{step} {fp.size}: median={median} p95={p95}")
                assert median >= 100 and p95 >= 190, (width, height, step, median, p95)
                small = page.evaluate("""() => [...document.querySelectorAll('#bar *, .step.show *')]
                    .filter(el => el instanceof HTMLElement && el.getClientRects().length &&
                        [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) &&
                        parseFloat(getComputedStyle(el).fontSize) < 12)
                    .map(el => [el.tagName, el.className, getComputedStyle(el).fontSize])""")
                assert small == []

    def test_11b_phase5_stage02_pil2d_sandbox_parity(self, browser_session, web):
        """D-024 §5.2 full-stack live-Edge E2E for Stage 02 PIL 2D tactical sandbox parity."""
        page, base = browser_session["page"], browser_session["base"]
        page.set_viewport_size({"width": 1600, "height": 1000})

        # 1. Verify all 9 offline nav-grid PNGs serve HTTP 200 with PNG signatures
        nav_files = [
            "ArmsFactory.png",
            "SacredHeartHospital.png",
            "TheRedChurch.png",
            "LakesideVillage.png",
            "MoonlitRiverPark.png",
            "LeosMemory.png",
            "EversleepingTown.png",
            "ChinaTown.png",
            "Darkwoods.png",
        ]
        for fname in nav_files:
            r = web.get(f"/assets/nav-grid/{fname}")
            assert r.status_code == 200 and r.content.startswith(PNG), fname

        # Open clean standalone whiteboard on 军工厂 (mapId=0)
        page.goto(base, wait_until="networkidle")
        page.evaluate("localStorage.clear(); sessionStorage.clear();")
        page.goto(f"{base}/?case=p5-pil2d#s=2&auto=0", wait_until="networkidle")
        page.locator("[data-test=board-canvas]").wait_for()
        page.wait_for_function("globalThis.idvFootprints?.has(document.querySelector('[data-test=board-canvas]'))")
        if page.locator("[data-test=sandbox-map-select]").count() == 0:
            page.locator("#transport .mode-pills button", has_text="白板").click()
        page.select_option("[data-test=sandbox-map-select]", "0")
        page.wait_for_load_state("networkidle")

        def map_pt(u: float, v: float):
            return page.evaluate("""([u, v]) => {
              const c = document.querySelector('[data-test=board-canvas]');
              const r = c.getBoundingClientRect();
              const q = globalThis.idvFootprints.get(c).map(p => [r.x + p.x * r.width / c.width, r.y + p.y * r.height / c.height]);
              const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
              const l = Math.min(...xs), t = Math.min(...ys), w = Math.max(...xs) - l, h = Math.max(...ys) - t;
              return [l + u * w, t + v * h];
            }""", [u, v])

        # 2. 密码机速查 card
        page.click("[data-right-tab='tools']")
        page.click("[data-panel-tool='inspect']")
        card = page.locator("[data-test=tac-cipher-card]")
        card.wait_for()
        assert card.locator("[data-cipher-card-row]").count() == 7
        before_grp = card.inner_text()
        page.click("[data-test=btn-cipher-card-next]")
        assert card.inner_text() != before_grp
        card.locator("[data-cipher-card-row]").first.click()
        assert "active" in (card.locator("[data-cipher-card-row]").first.get_attribute("class") or "").split()

        # 3. Live cursor coordinates tooltip (toggle-show-coords -> tac-coords-tip)
        page.click("[data-test=btn-view-settings]")
        chk = page.locator("[data-test=toggle-show-coords]")
        if not chk.is_checked():
            chk.click()
        page.click("[data-test=btn-view-close]")
        mx, my = map_pt(0.48, 0.44)
        page.mouse.move(mx, my)
        tip = page.locator("[data-test=tac-coords-tip]")
        tip.wait_for()
        assert "px (" in tip.inner_text() and "m)" in tip.inner_text()

        # 4. Measure '路径线·绕障' (route) across obstacle on 军工厂 + ETA + 允许翻窗/自动修正阻挡点 + A->B planner
        page.click("[data-panel-tool='measure']")
        page.click("[data-test=btn-measure-route]")
        assert page.locator("[data-test=toggle-measure-vault]").is_checked()
        assert page.locator("[data-test=toggle-measure-autofix]").is_checked()
        p1 = map_pt(0.24, 0.34)
        p2 = map_pt(0.76, 0.66)
        page.mouse.click(p1[0], p1[1])
        page.mouse.click(p2[0], p2[1])
        page.locator("[data-test=measure-sim-result] .tac-routed-pill").first.wait_for(timeout=15000)
        sim_txt = page.locator("[data-test=measure-sim-result]").inner_text()
        assert "总长" in sim_txt and "耗时" in sim_txt and "绕障" in sim_txt
        page.locator("[data-test=toggle-measure-vault]").click()
        page.locator("[data-test=toggle-measure-vault]").click()
        page.locator("[data-test=toggle-measure-autofix]").click()
        page.locator("[data-test=toggle-measure-autofix]").click()

        # A -> B route planner
        page.click("[data-test=btn-route-pick-a]")
        pa = map_pt(0.30, 0.70)
        page.mouse.click(pa[0], pa[1])
        page.click("[data-test=btn-route-pick-b]")
        pb = map_pt(0.72, 0.28)
        page.mouse.click(pb[0], pb[1])
        page.click("[data-test=btn-route-run]")
        page.locator("[data-test=route-fix-note]").wait_for(timeout=15000)
        assert "m" in page.locator("[data-test=route-fix-note]").inner_text()

        # 5. Nav-grid Carry & Tide 5-band contour + basement chair toggle + point-mode chair table
        page.click("[data-panel-tool='range']")
        page.click("[data-test=btn-range-carry]")
        page.click("[data-test=btn-range-mode-chair]")
        page.click("[data-test=toggle-range-basement]")
        page.wait_for_function("() => (document.querySelector('[data-test=range-summary]')?.textContent || '').includes('绕障导航')", timeout=15000)
        assert page.locator("[data-test=range-legend] [data-band]").count() == 5
        page.click("[data-test=btn-range-tide]")
        page.click("[data-test=btn-range-mode-point]")
        pr = map_pt(0.50, 0.50)
        page.mouse.click(pr[0], pr[1])
        page.locator("[data-test=range-chair-table] [data-chair-row]").first.wait_for(timeout=15000)
        assert page.locator("[data-test=range-chair-table] [data-chair-row]").count() >= 5

        # 6. Place token + ArrowRight nudge + Ctrl+Z undo + anim auto-pathing & timeline scrub
        page.click("[data-panel-tool='place']")
        page.click("[data-test=place-camp-survivor]")
        page.click("[data-test=role-btn-seer]")
        ptok = map_pt(0.30, 0.42)
        page.mouse.click(ptok[0], ptok[1])
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() >= 1

        def last_tok_x():
            return page.evaluate("() => JSON.parse(localStorage.getItem('idv.pil.v2') || '{}').boards?.['0']?.tokens?.at(-1)?.x")

        x0 = last_tok_x()
        page.evaluate("() => document.activeElement?.blur?.()")
        page.keyboard.press("ArrowRight")
        x1 = last_tok_x()
        assert x1 > x0 + 0.002, (x0, x1)
        page.keyboard.press("Control+z")
        x2 = last_tok_x()
        assert abs(x2 - x0) < 1e-4, (x0, x1, x2)

        page.click("[data-panel-tool='anim']")
        page.locator("[data-test=tool-panel-anim] .tac-chip-grid button").last.click()
        assert page.locator("[data-test=toggle-anim-autoroute]").is_checked()
        page.click("[data-test=btn-anim-arm]")
        pwp = map_pt(0.72, 0.56)
        page.mouse.click(pwp[0], pwp[1])
        page.locator("[data-test=anim-waypoint-list] .tac-routed-pill").first.wait_for(timeout=15000)
        page.locator("[data-test=tac-anim-scrubber]").wait_for()
        page.locator("[data-test=tac-anim-scrubber]").fill("2")
        assert float(page.locator("[data-test=tac-anim-clock]").inner_text().split("s")[0]) >= 1.5

        # 7. 90-degree board rotation
        page.click("[data-test=btn-view-settings]")
        page.click("[data-test=btn-board-rotate-90]")
        page.click("[data-test=btn-view-close]")
        assert "偏航 90°" in page.locator(".board .hud").inner_text()
        page.click("[data-test=btn-view-settings]")
        page.click("[data-test=btn-reset]")
        page.click("[data-test=btn-view-close]")
        page.wait_for_load_state("networkidle")

    def test_11c_phase5_stage04_spawn_predictor_and_linkage(self, browser_session):
        """D-024 §5.2 full-stack live-Edge E2E for Stage 04 Opening Spawn Predictor & cross-stage linkage."""
        page, base = browser_session["page"], browser_session["base"]
        page.set_viewport_size({"width": 1600, "height": 1000})
        page.goto(base, wait_until="networkidle")
        page.evaluate("localStorage.clear(); sessionStorage.clear();")
        page.goto(f"{base}/?case=p5-predict#s=4&auto=0", wait_until="networkidle")
        page.locator("[data-test=region-submode-tabs]").wait_for()

        # Switch to Mode A (开局选点预测)
        page.click("[data-test=btn-region-mode-predict]")
        page.locator("[data-test=spawn-predict-board]").wait_for()

        # Open 35-Hunter modal: verify 36/36 portraits load HTTP 200, search & select hunter
        page.click("[data-test=btn-predict-hunter]")
        modal = page.locator("[data-test=spawn-hunter-modal]")
        modal.wait_for()
        assert modal.locator("[data-hunter-idx]").count() == 36
        statuses = page.evaluate("""async () => {
          const imgs = [...document.querySelectorAll('[data-test=spawn-hunter-modal] img')];
          return Promise.all(imgs.map(async i => (await fetch(i.getAttribute('src') || '')).status));
        }""")
        assert len(statuses) == 36 and all(s == 200 for s in statuses), statuses
        page.fill("[data-test=spawn-hunter-search]", "歌剧")
        assert modal.locator("[data-hunter-idx]").count() >= 1
        modal.locator("[data-hunter-idx]").first.click()
        modal.wait_for(state="hidden")
        assert "歌剧" in page.locator("[data-test=btn-predict-hunter]").inner_text()
        # Reset to 不限监管
        page.click("[data-test=btn-predict-hunter]")
        modal.locator("[data-hunter-idx='-1']").click()
        modal.wait_for(state="hidden")

        # 军工厂 (mapId=0): pick 4 Survivor cells + 标备选 (我) + verify badge, heatmap, diff, Top-20 table
        page.select_option("[data-test=predict-map-select]", "0")
        for cid in ("11", "13", "31", "33"):
            page.click(f"[data-predict-cell='{cid}']")
        page.locator("[data-test=predict-best-badge]").wait_for()
        heat_stats = page.locator(".sp-cell-stat").all_inner_texts()
        assert len(heat_stats) >= 4 and all("% · " in t and "局" in t for t in heat_stats), heat_stats
        assert page.locator("[data-test=predict-records-table] tbody tr").count() >= 1
        page.click("[data-test=btn-predict-mark-alt]")
        page.click("[data-predict-cell='22']")
        assert page.locator("[data-test=predict-my-alt-marker]").is_visible()
        assert "我的预判对比" in page.locator("[data-test=predict-my-alt-diff]").inner_text()
        page.click("[data-test=btn-predict-mark-alt]")

        # Top-6 preset & 随机实局
        page.locator("[data-test=predict-top-layouts] button[data-layout-key]").first.click()
        page.locator("[data-test=predict-best-badge]").wait_for()
        page.click("[data-test=btn-predict-random]")
        page.locator("[data-test=predict-best-badge]").wait_for()

        # 永眠镇 (mapId=6): 10 cells including 14
        page.select_option("[data-test=predict-map-select]", "6")
        assert page.locator("[data-predict-cell]").count() == 10
        assert page.locator("[data-predict-cell='14']").is_visible()
        page.locator("[data-test=predict-top-layouts] button[data-layout-key]").first.click()
        page.locator("[data-test=predict-best-badge]").wait_for()

        # 湖景村 (mapId=3): 12 cells -> 带入封禁分析 (Mode B) -> return -> 发送到战术沙盘 (Step 02)
        page.select_option("[data-test=predict-map-select]", "3")
        assert page.locator("[data-predict-cell]").count() == 12
        page.locator("[data-test=predict-top-layouts] button[data-layout-key]").first.click()
        page.locator("[data-test=predict-best-badge]").wait_for()

        page.click("[data-test=btn-predict-to-lock]")
        page.locator("[data-test=region-canvas]").wait_for()
        assert page.locator("[data-test=region-map-select]").input_value() == "3"
        assert "4 / 4" in page.locator("[data-test=region-side-survivor]").inner_text()
        assert "1 / 1" in page.locator("[data-test=region-side-hunter]").inner_text()
        lock_name = page.locator("[data-test=lock-cipher-name]").inner_text().strip()
        lock_dist = page.locator("[data-test=lock-cipher-dist]").inner_text().strip()
        assert lock_name and lock_name != "--" and lock_dist and lock_dist != "--"

        page.click("[data-test=btn-region-mode-predict]")
        page.locator("[data-test=spawn-predict-board]").wait_for()
        page.wait_for_function("() => { const im = document.querySelector('.sp-map-img'); return Boolean(im && im.complete && im.naturalWidth > 0); }")
        page.wait_for_load_state("networkidle")
        page.locator("[data-test=predict-top-layouts] button[data-layout-key]").first.click()
        page.locator("[data-test=predict-best-badge]").wait_for()
        page.click("[data-test=btn-predict-to-sandbox]")
        page.locator("#s2.show [data-test=board-canvas]").wait_for()
        page.wait_for_function("globalThis.idvFootprints?.has(document.querySelector('[data-test=board-canvas]'))")
        assert page.locator("[data-test=sandbox-map-select]").input_value() == "3"
        page.click("[data-right-tab='tools']")
        page.click("[data-panel-tool='place']")
        assert page.locator("[data-test=placed-list] [data-placed-token]").count() == 5
        page.wait_for_load_state("networkidle")

    def test_11d_phase6_visual_craft_typography_controls_and_materials(self, browser_session, web, frontend_server):
        """D-026 §2–§5 & T-033 §1 full-stack E2E gate for Phase 6 typography, controls, plaques, and 11/11 SHA-256."""
        import hashlib
        import subprocess
        from conftest import REPO_ROOT

        page, base = browser_session["page"], browser_session["base"]
        page.set_viewport_size({"width": 1440, "height": 900})

        # 1. Verify bundled offline Cormorant Garamond 600/700 italic & Noto Serif SC 600/900 .woff2 serve HTTP 200
        dist_assets = Path(frontend_server["out_dir"]) / "assets"
        patterns = [
            ("cormorant-600-italic", "cormorant-garamond-latin-600-italic-"),
            ("cormorant-700-italic", "cormorant-garamond-latin-700-italic-"),
            ("noto-600", "-600-normal-"),
            ("noto-900", "-900-normal-"),
        ]
        for label, pat in patterns:
            files = sorted(
                p.name
                for p in dist_assets.glob("*.woff2")
                if pat in p.name and (not label.startswith("noto-") or p.name.startswith("noto-serif-sc-"))
            )
            assert files, (label, pat)
            r = web.get(f"/assets/{files[0]}")
            assert r.status_code == 200 and r.content.startswith(b"wOF2") and len(r.content) > 5000, (label, files[0])

        # 2. Check Stage 01, 02 (Replay + Whiteboard), 04 (Mode B + Mode A), and 05
        for step, url in [
            (1, f"{base}/?case=p6-s1#s=1&auto=0"),
            (2, f"{base}/?case=p6-s2#m={CHINATOWN_MATCH}&s=2&t=120&auto=0"),
            (4, f"{base}/?case=p6-s4#s=4&map=0&auto=0"),
            (5, f"{base}/?case=p6-s5#s=5&map=6&auto=0"),
        ]:
            page.goto(url, wait_until="networkidle")
            page.wait_for_selector(f"#steps button[data-step='{step}'].on")
            info = page.evaluate(
                """step => {
                  const inactive = [...document.querySelectorAll('#bar #steps button:not(.on)')].map(b => [
                    getComputedStyle(b).backgroundColor,
                    getComputedStyle(b).backgroundImage,
                  ]);
                  const active = getComputedStyle(document.querySelector('#bar #steps button.on'));
                  const vRgb = (getComputedStyle(document.querySelector('#bar .identity i')).color.match(/\\d+/g) || []).slice(0, 3).map(Number);
                  const sels = [...document.querySelectorAll('#bar select.sel, .step.show select.sel')]
                    .filter(s => s.checkVisibility())
                    .map(s => getComputedStyle(s).appearance);
                  const compassNorth = step === 5 ? document.querySelector('#s5 .compass g[transform]')?.getAttribute('transform') : null;
                  const hasDropLaurel = step === 1 ? Boolean(document.querySelector('#dropZone header .folio-laurel')) : null;
                  return {
                    inactive,
                    activeGradient: active.backgroundImage.includes('linear-gradient'),
                    vRgb,
                    sels,
                    compassNorth,
                    hasDropLaurel,
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
            assert len(info["inactive"]) == 4 and all(x == ["rgba(0, 0, 0, 0)", "none"] for x in info["inactive"]), (step, info)
            assert info["activeGradient"], (step, info)
            assert info["vRgb"][0] >= 220 and (info["vRgb"][0] - info["vRgb"][1]) >= 110, (step, info["vRgb"])
            assert len(info["sels"]) >= 1 and all(a == "none" for a in info["sels"]), (step, info["sels"])
            assert info["deskImgs"] == 0 and info["photoPins"] == 0 and info["leakedProps"] == 0 and info["clutterVisible"] == 0, (step, info)
            if step == 1:
                assert info["hasDropLaurel"] is True
            if step == 5:
                assert info["compassNorth"] == "rotate(90 36 36)", info

        # 3. Verify 11/11 dossier PNG SHA-256 unchanged
        dossier_dir = REPO_ROOT / "frontend/public/assets/dossier"
        rev = "3f0c35be19e9f02c54b1a2e0b453e356ff1d5e4a"
        count = 0
        for p in sorted(dossier_dir.rglob("*.png")):
            rel = p.relative_to(REPO_ROOT).as_posix()
            ref_bytes = subprocess.check_output(["git", "show", f"{rev}:{rel}"], cwd=REPO_ROOT)
            built_p = Path(frontend_server["out_dir"]) / p.relative_to(REPO_ROOT / "frontend/public")
            assert ref_bytes == p.read_bytes() == built_p.read_bytes(), rel
            assert len(hashlib.sha256(ref_bytes).hexdigest()) == 64
            count += 1
        assert count == 11
        page.wait_for_load_state("networkidle")

    def test_12_zero_console_page_http_and_external_requests(self, browser_session):
        errs = browser_session["errors"]
        assert errs["console"] == [], errs["console"]
        assert errs["page"] == [], errs["page"]
        assert errs["http"] == [], errs["http"]
        local_failed = [f for f in errs["failed"] if f.startswith(browser_session["base"])]
        assert local_failed == [], local_failed
        assert errs["external"] == [], f"unexpected external requests: {errs['external']}"
        print(f"Edge {browser_session['browser_version']}: console=0 page=0 HTTP=0 failed=0 external=0")


# =========================================================================== read-only guards
def test_zz_read_only_integrity(audit_fingerprint_before, repo_cache_fingerprint_before):
    """Runs last: the audited source and the tracked repo cache are byte-for-byte unchanged."""
    assert tree_fingerprint(AUDIT_DIR) == audit_fingerprint_before
    assert tree_fingerprint(REPO_CACHE_DIR) == repo_cache_fingerprint_before
