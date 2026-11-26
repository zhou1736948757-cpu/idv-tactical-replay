# Project Memory

<!-- chef-worker-reviewer-workflow:memory:start -->
## Durable project memory

- Workflow version: `1.4` (v1.4.1 repair)
- Project: `idv-tactical-replay`
- Initialized at: `2026-11-24T01:22:25+09:00`
- Artifact root: `Workflow/`
- Source contract: `AGENTS.md`
- Runtime state: `Workflow/STATE.json`
- Runtime events: `Workflow/events.jsonl`
- Watchdog settings: `Workflow/watchdog.json`
- Role heartbeats: `Workflow/heartbeats.json`
- Watchdog alerts: `Workflow/watchdog-alerts.jsonl`

### Runtime configuration summary
<!-- chef-worker-reviewer-workflow:runtime-config:start -->

- Main/Orchestrator model declaration: `current-main-conversation` (current main conversation; routing may be unverified)
- Chief model: `codex:gpt-6.2-astra`
- Worker model: `codex:gpt-6.2-astra`
- Reviewer model: `codex:gpt-6.2-sol`
- Worker maximum concurrency: `3`
- Main thinking depth: `high`
- Chief thinking depth: `high`
- Worker thinking depth: `medium`
- Reviewer thinking depth: `high`
- Configuration file: `Workflow/config.json`
- Watchdog interval: 600 seconds by default; suspected stalls are reported to Main for a decision

<!-- chef-worker-reviewer-workflow:runtime-config:end -->

### Project facts

- Audited read-only replay source lives at `i:\geminiiii\idv_demo_audit_20261124_002337\work_copy\input_0_media_1795446603161_b0c41fc3\323292579` (7 distinct matches across maps `6` 军工厂, `11` 红教堂, `18` 圣心医院, `39` 永眠镇, `40` 唐人街, `75` 不归林).
- Reference Manor Dossier UI (`template.html` with `GEO` map aspect ratios) and real image assets (`assets/bg.jpg`, `assets/seal.jpg`, 9 `assets/maps/*_grid.jpg`, 36 `assets/hunters/*.png`) come from public GitHub repo `zhou1736948757-cpu/notes`.

### Confirmed decisions

- Canonical shared schema (`Replay2DPayload` v1.0, `MatchSummary`, `MatchAnalyticsPayload`, 9-tuple 10Hz trajectories `[t, x, y, z, dx, dz, speed, cam_yaw, fear_state]`) and zero-DOM `@idv/replay-renderer` interface are locked in `Workflow/PLAN.md` (`D1`–`D3`).
- Standardized elevation bands: `B1` (`y < -20.0`, `y_plane = -85.0`), `1F` (`-20.0 <= y < 25.0`, `y_plane = 0.0`), `2F` (`y >= 25.0`, `y_plane = 60.0` or match `2F` median); survivor sprint ETA ruler uses `45.0 u/s` with `+90u` cross-floor stair penalty.
- Worker model reconfigured per user request to `gemini-4-hydrogen-xhigh` (`xhigh`) for all subsequent Worker tasks and repairs ([D-001.md](Workflow/decisions/D-001.md)).
- Role models reconfigured per user request (`D-002`): Chief `gemini-4-neon-high` (`high`), Worker `gemini-4-hydrogen-xhigh` (`xhigh`), Reviewer `codex:gpt-6.2-sol` (`medium` via `codex exec`) ([D-002.md](Workflow/decisions/D-002.md)).
- Phase 2 PIL Tactical Friend parity & Stage 2 declutter (`D4`–`D5` in `Workflow/PLAN.md`): physical scale locked at `WORLD_UNITS_PER_METER = 45.0 / 3.8` (`3.8 m/s === 45.0 u/s`); Stage 2 (`02 战术沙盘`) supports both loaded `.zip` replays and standalone 9-map tactical whiteboard (`buildStandaloneMapPayload`) inside a single-row `#toolbar` + collapsible `ViewSettingsPopover` + 3-tab `#rightCol` (`实时战况` | `战术工具` | `事件流`); `04 区域选点` and `05 密码机推演` integrate cleanly via 5-step `#steps` rail.
- Phase 3 overhaul (`D-003`, approved `PLAN.md` + `I:\geminiiii\ui-concepts\`): Worker reconfigured to `codex:gpt-6.2-sol` (`low`), Reviewer remains independent `codex:gpt-6.2-sol` (`medium`), Chief remains `gemini-4-neon-high` (`high`). Unified `50px` horizontal `#bar` eliminates left sidebar (`0px`), adopting Dark Manor Slate left/map stage + Warm Aged Parchment right dossier/archive cards (`#ebe0c8`/`#e1d2b3`, `--ink: #241b13`), self-hosted SIL OFL fonts (`Noto Serif SC`, `Cinzel`, `Cormorant Garamond`, `LXGW WenKai Screen`), Codex-generated `frontend/public/assets/dossier/` art/textures (`manor-header-crest.png`, `parchment-etching-gate.png`, `analytics-header-sketch.png`, `parchment-tile.png`, `desk-fountain-pen.png`, `desk-pocket-watch.png`, `desk-vintage-postcard.png`) + inline SVG binder clips/wax seals, `clarity` LUT map enhancement, and Dual Entry Paths (Auto Replay + Blind Pro Practice).

### Important discoveries

- Unpickled `snap_shot` `UnitManager` keys (`uid`) and `components` keys (`17`) are Python `int`s (only stringified in JSON dumps); extractors must check both `int` and `str` keys for 100% 3D `pos`+`dir` on doors (`ut=6`), windows (`ut=7`), and pallets (`ut=8`).
- Hunter `pid=102` (`6b04364084b889718108247f`) requires merging `et=1110` (`target_pos`) alongside joystick/authority movement events.
- NeoX yaw (`angle` and `et=304` `ang_tuple[2]`) maps to world XZ direction via `dx = sin(yaw_rad), dz = cos(yaw_rad)`.

### Known pitfalls

- Non-gameplay props may carry sentinel `y = -65536.0` and must be excluded (`abs(y) > 500`) from world bounds.
- `REF_SURVIVOR_GENIUS_NAMES` applies strictly to Survivors (`camp == 2`), never Hunters (`camp == 1`).
- Custom AI bots (`6b0014eb54fd12fd2b16667d`) have `unique_id=None` in `all_player_result` and require fallback join on `(player_name, pid, utype)`.
- On Windows PowerShell, never redirect `gh api` binary image output with `>` (corrupts bytes to UTF-16LE); write raw bytes in Python and verify JPEG/PNG magic headers.
- `@idv/replay-renderer` `dist/` is gitignored and consumed via `file:` symlink, so fresh checkouts/scripts must run `npm --prefix packages/replay-renderer run build` before `frontend` build/test.
- `TacticalReplayRenderer.setPayload()` preserves prior `underlay.worldRect` once set; `T-003` must pass `worldRect: payload.world.map_underlay.world_rect` explicitly in `setUnderlay()` whenever switching matches.
- `TacticalReplayRenderer` viewport/screen coordinates are CSS pixels (DPR is applied internally); browser `CanvasRenderingContext2D` is directly assignable to `Canvas2DContextLike` with zero casts.
- `backend/pytest.ini` sets `-p no:asyncio` to avoid a machine-wide `pytest-asyncio` startup incompatibility with `pytest 7.4.4`.
- Frontend integration contract: always call `renderer.setChaseSegments(analytics.chase_segments)` for chase rings (backend `chase_state.meta` emits `{"flag": bool}`), and null-guard `analytics.hunter_metrics.reported_pursuit_s` (can be `null` in custom/bot matches like `6b0014eb54fd12fd2b16667d`).
- Local git repo sets `core.quotepath false` so UTF-8 Chinese asset filenames do not trigger octal-quoting false positives in `build_review_bundle.py`.
- Frontend supports hash deep links `#m=<24-hex>&s=<1|2|3>&t=<sec>` (applies `t` on mount and normalizes to `#m=<id>&s=<step>`), useful for E2E automation and direct sharing.
- `frontend/vitest.config.ts` enables `css: { include: [/manor\.css/] }` because Vitest returns `""` for `?raw` CSS imports unless matched.
- Playwright bundled Chromium is not pre-installed on this Windows host; `tests/conftest.py` falls back to local `channel="msedge"` (Edge 154 headless) and isolates live E2E state via a temp `IDV_CACHE_DIR` copy and temp Vite `--outDir` with `taskkill /F /T` cleanup.
- Chromium automatically requests `/favicon.ico`; `frontend/index.html` includes `<link rel="icon" type="image/jpeg" href="/assets/seal.jpg">` (`T-003R`) so live browser sessions stay strictly zero-console-error.
- `永眠镇_grid.jpg` is rotated 90° CCW relative to PIL `maps.js` coordinates: apply `rotationQuadrants: 1` (canvas 90° CW transform in `RegionView`, `rotate(90deg)` CSS placement in `DeduceView`, and `setUnderlay({ rotationQuadrants: 1 })` in standalone Stage 2) so all 10 zones and ciphers align sub-pixel accurately.
- Local-first zero-external-request policy: zero external `patchwiki`/`hdslb`/`fonts.googleapis.com`/`fonts.gstatic.com` URLs anywhere in `frontend/` (`T-008R`); `manor.css` uses local serif/kai font stacks (`Source Han Serif SC`, `STSong`, `SimSun`, `STKaiti`, `KaiTi`), and composited PNG export stays completely untainted.
- Non-interactive Codex CLI Reviewer (`codex exec`) on Windows requires piping the prompt via stdin (`$prompt | codex exec ... -`) and using `-s danger-full-access` (paired with strict prompt no-edit rule + `git diff` verification) so Node `esbuild`/`vitest`/`vite`/Playwright can spawn child processes without `spawn EPERM`.
- Direct temp/build output onto `J:\codex-tmp` (`$env:TEMP`/`$env:TMP`) when spawning Codex/Vite/Vitest in parallel because `C:` headroom is tight (~0.2 GB) while `J:` has >60 GB free.
- `lxgw-wenkai-webfont` in `frontend/package.json` aliases `lxgw-wenkai-screen-webfont@1.7.0` (`lxgw-wenkai-webfont/lxgwwenkaiscreen.css`, family `'LXGW WenKai Screen'`); combined with `@fontsource/noto-serif-sc`, `@fontsource/cinzel`, and `@fontsource/cormorant-garamond`, Vite emits 307 local `.woff2` files (+32.9 MB built `dist/`).
- `--dim` (`#8a7d66`) on `--surface-1` (`#181512`) clears WCAG AA at `4.508:1`; never apply `< 1` opacity to `--dim` text (`D-004`).
- External-URL offline verification allows baseline Vue 3 runtime XML/error-reference constants and byte-identical PNG C2PA `caBX` provenance metadata while requiring `0` matches in built HTML/CSS, `0` new JS URLs, and `0` outbound HTTP/HTTPS requests at runtime (`D-004`).
- Chief/Worker/Reviewer roles reconfigured via `D-009` (`D-005` superseded): `worker=codex:gpt-6.2-astra` (`medium`, fast mode `--enable fast_mode -c service_tier="fast"`), `reviewer=codex:gpt-6.2-sol` (`high`), `chief=codex:gpt-6.2-astra` (`high`); in-flight `T-012` Worker completes cleanly and submits to `gpt-6.2-sol (high)` Reviewer.
- `T-012` Dual Entry Paths & Blind Practice invariants (`D-010`, `T-012-r3` PASS):
  - `replay-link.ts`, `practice.ts`, `director.ts`, and `link-state.ts` stay strictly zero-DOM (`ES2022`); 7/7 cached replays register exact `cipherCombinations` groups at `0.938–0.976` confidence.
  - Blind pro practice seals replay/analytics in a module-private non-reactive closure (session-token guarded across async loads) keeping `store.replay`, `store.analytics`, `store.analyticsById[id]`, `flow.link`, and `flow.reveal` strictly null/empty until reveal (`查看对照`) or `watchOpening()`, gates `03 对比分析` until public payloads match `selectedId`, and clears stale practice comparisons cleanly on public match selection.
  - Layout invariants: `DirectorBar` sits centered above `#transport` (zero intersection with `.board .hud`), `PracticeHud` docks inside `.pil-right.paper-folio` (`04/05` keep `658/790/970px` stage heights open/collapsed & blind/revealed), `RegionView` `showPrediction` guards both predicted lock/`封禁` and selected-cipher ring Canvas branches, and E2E waits `networkidle` before reload to avoid aborting `/assets/seal.jpg`.
- `T-013` Phase 4 Shell, Targets & Ornaments (`D-011`, `D-012`, `T-013-r2` PASS):
  - Shared `60px` gilded bronze-bevel topbar (`#bar`), reclaiming `10px` from map outer padding so `02` keeps `648/780/960px` and `04/05` keep `658/790/970px` across `1366/1440/1920`; `#notice` sits above `#bar` and `.settings-pop` (`z-index`), and `.settings-pop` anchors below `60px` (`y=66px`, `0px` overlap with tab `05`).
  - `SandboxView.vue` emits `@displayed-map-change` (using public map name only so whiteboard switches update the left hanging bookmark immediately without leaking sealed blind state).
  - Four transparent copperplate etchings (`carriage-vignette.png`, `phase-opening.png`, `phase-midgame.png`, `phase-endgame.png`) live in `frontend/public/assets/dossier/phase4/` with `IHDR/IDAT/IEND` chunks only (`0` URL chunks), while all 7 original `D-004` PNGs stay byte-identical.
  - Shared `ManorMapFrame.vue` (`pxPerMeter`, `northAngle`, `safeInset`) + expanded `ManorOrnaments.vue` (`win`/`lose`/`neutral`/`rivet`/`ribbon`/`laurel`/`typewriter`/`corner`/`clip`, unique SVG `<defs>` IDs via `useId()`); note `03` SVG axis text must clear `>= 12 CSS px` under `getScreenCTM()` in `T-014`.
- `T-013R` Shared Fixes (`D-013`, `T-013R-r1` PASS): `ManorMapFrame` keeps `64×64 CSS px` outer compass while keeping `N/E/S/W` effective `fontSize * hypot(c, d) >= 12 CSS px` across rotated `02/04/05`; `ManorOrnaments` adds optional `labelPair?: { zh: string; en: string }` two-line bilingual seal rendering (`45px` inner face, recommended `76×92 CSS px` wrapper box, `>= 5.89:1` contrast) without altering default instances.
- `T-013R2` Shared Desk Breakpoint (`D-014`, `T-013R2-r1` PASS): `dossier-views.css` hides `.desk-still img` (`desk-photo`, `desk-watch`, `desk-nib`) on `02/04/05` below `1680 CSS px` and renders all three unclipped with `0 px²` control overlap at `>=1680px` (`1920×1080` open/collapsed) while preserving `75%/98%` widths and `D-008` luminance.
- `T-014..T-016` Phase 4 Page Parity (`D-013`, `D-014`, all `r3` PASS):
  - `AnalyticsView` (`03`) scales SVG axis coordinates against plot CSS dimensions so all 36 `getScreenCTM()` axis/legend labels measure `>= 12 CSS px` (`13 CSS px`), pairs raw personal decoding contribution (`>100%` allowed) with team-share normalized bar widths, and tightens `@media (max-height: 820px)` / `1366×768` row spacing so all 4 contribution bars clear the gold frame.
  - `SandboxView` / `TacticalBoardCanvas` (`02`) keeps `.scale` cleared above `[data-test="director-bar"]` via `safeInset` across all wheel zooms, checks `.map-badge` / `.bookmark` / `.compass` + projected map bounds before side-docking `.map-key` (folding cleanly to bottom focusable `'图例'` toggle on zoom/right-pan), and mounts 4 fixed folio corner filigree on outer shell without top-padding anchor shift (`<= 5px` delta at `1440×900`).
  - `RegionView` / `DeduceView` (`04/05`) uses padlock + warm sightline + bilinear revealed `命中 Hit` / `偏差 Miss` seals on `04`, reserves right-side title padding against `.folio-laurel` at `1366×768` (`0px` overlap), uses compact visible `'未知'` badges (`0 px²` dense cluster overlap across all 9 maps) with transparent center ring and gray (`inf-no`) / gold (`inf-yes`) dashed borders, and applies aligned warm patina/roof chroma overlays (`05` `.ded-map-img` stays `opacity: 1; filter: none`) clearing `D-008` (`>= 114 / >= 193`).
- `T-013R3 / T-015R / T-016R` Micro-Repairs (`D-015`, all `r1` PASS): `#bar .identity i` uses `#f76f68` (`>= 5.31:1` across 15 renders); `02` `.scale` fit box holds `241.203px` (`+0.203px` vs frozen target); `04/05` `.pil-camp-count`, `[data-test=deduce-layouts] > summary`, and `.ded-layout-badge` (`#5b3d1e` / `#fff3da`) clear `>= 4.5:1` unclipped across `1366/1440/1920`. Also verified across all 9 real maps that `chainThree` (e.g. Chinatown) emits a 4-vertex open polyline (`0` closed 3-vertex triangle rules exist in real data).
- `@idv/replay-renderer` Phase 3 (`T-009`): `VISUAL_PRESETS` adds `'clarity'` (`MANOR_CLARITY_PALETTE`), `'original'`, and backward-compatible `'dossier'` (`MANOR_DOSSIER_PALETTE` preserved identically); `RendererOptions` accepts `visualPreset`, `glyphScale`, and `topSafeInset`; pass `underlay.tone = null` when host pre-bakes `mapTone` images to avoid double toning while keeping preset `backing` and `opacity`. `pickEntityAtScreen` scales hit areas cleanly for enlarged glyphs, shares finite segment picking (`[a, b]`) for upright/dropped pallets & windows, preserves explicit `pickRadiusPx`, and always returns `{ x, y }` exact keys in `PickResult.screen` (`D-004`, `D-006`, `D-007`).
- `T-011` Phase 3 layout & luminance invariants (`D-008`): `#bar #steps button[data-step="1..5"]` sits in a single `50px` top row (`0px` left rail), `02`/`04`/`05` hold `>= 75%` open / `>= 98%` collapsed map widths at `1366x768`, `1440x900`, `1920x1080`, `.step.show` stays stationary at `opacity: 1` (no slide/fade animation causing transient overflow or faded `--dim`), `05` `'clarity'` images render with `opacity: 1` and `filter: none`, and `AC-2` map brightness (`median >= 100`, `p95 >= 190` Rec.709 `0-255`) is measured on the rendered map image footprint across `02`/`04`/`05`.
- `build_review_bundle.py` `path_within_scope()` matches directory prefixes ending in `/`, not `/**` globs — write allowed-subtree entries in task packets as `dir/` instead of `dir/**`.
- Phase 4 `D-016..D-023` ~90% Visual Overhaul & Canvas Nameplates (`T-018..T-023`, `T-023R`, `T-017` Attempt 3 all independently `PASSED`):
  - **Desktop Proportions & Framing (`T-018`, `T-020`, `D-021`)**: `02/04/05` expanded uses `32vw` right folio + `5vw` left desk strip + `10px` gap (`1366: 830.58/437.12`, `1440: 873.20/460.80`, `1920: 1167.60/614.40`; collapsed `1346/1416/1888 >= 98vw`; `02` height `648/780/960`, `04/05` `658/790/970`); `.desk-still > img == 3` direct `<img>` props (incl. `desk-nib`) visible expanded across `1366/1440/1920`, collapsed `<1680` hidden, `>=1680` safe with dynamic retreat on zoom/pan/popovers; `64×64` dark brass compass (`D-022:compass-64`) and `04/05` scale clearing `.pil-action-bar` (`0 <= gap <= 14px`, `D-022`/`D-023`).
  - **2-Pass Pure-TS Canvas Nameplate Layout (`T-019`, `T-022`)**: `@idv/replay-renderer` `render(tSeconds, reservedRects?)` separates player labels into a deterministic 2-pass layout with candidate rings, nearest-free-slot scan, and leader lines (zero DOM refs, `0 px²` overlap & `<= 0.01 px` token drift across `57/57` crowded live Edge frames, `131/131` Vitest); `TacticalBoardCanvas` caches CSS obstacle rects and refreshes on layout/zoom/popover/DPR changes.
  - **Single-Pass `mapTone.ts` Baking & D-017 Fit (`T-023`, `T-023R`, `D-017`, `D-020`, `D-023`)**: `'factory'`, `'hospital'`, and `'survey'` branches remove Rec.709 luminance offset from chroma delta with proportional gamut scaling (`04/05` whole-map spread `40–52`, `04-blue` roof `72` in D-020 `[62,95]` with `0` `R=0` clip, `05` `opacity: 1; filter: none`, all 7 survey maps + 9-cell Chinatown `>= 100 / >= 190`); `04` uses general occupied-bounds uniform fit (`D-017`, `1440` width ratio `0.9475`, area `100.24%`).
  - **Windows Worktree Vitest & Final Baseline**: Run Vitest in junctioned Windows worktrees with `NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'`; closed baseline is `131/131` renderer, `129/129` frontend, `58/58` backend, `114/114` full Edge E2E (Playwright `1.65.2`), `26/26` host visual (`1.41.0`), `0` external URLs, `11/11` PNG SHA-256 unchanged.
- Phase 5 `D-024` / `D-025` UI Declutter, Full PIL 2D Sandbox & Opening Spawn Predictor (`T-024..T-028` all Attempt 1 `PASSED`, 36/36 tasks closed):
  - **UI Declutter (`T-025`)**: Removed all 3 desktop props (`desk-photo`, `.photo-pin`, `desk-watch`, `desk-nib`) and `DossierPanel` `.manor-photo` from live DOM (while keeping all `11/11` `frontend/public/assets/dossier/**/*.png` byte-identical on disk for `D-004`), keeping only `.desk-still > .bookmark` + `ManorMapFrame`; removed `.folio-corner`/flourish/rotated multi-sheet clutter and reclaimed `--folio-foot: 0px` with restrained 2-layer shadows & `>= 16px` padding.
  - **PIL 2D Sandbox & Nav-Grid (`T-024`, `T-026`)**: Synced 9 offline PIL nav-grid PNGs (`frontend/public/assets/nav-grid/*.png`, `147 KB`) and pure-TS `nav-grid.ts` (A* + smoothing + `vault`/`autoFix` + basement `exit`/`slopeExtraM` + Dijkstra Carry/Tide 5-band obstacle contours + `evaluateChairsOnNavGrid`); Stage `02` integrates obstacle-routed `measure ('route')` + A→B planner, nav-grid Carry/Tide contours, animation `anim.paths` auto-pathing, full 9-map landmarks (`spawnPoints`/`rocketChairs`/`basements`/`chests`/`lockers`/`phoneBooths`/`fixedSpawns`), `密码机速查`, granular snaps, coords tooltip, 90° rotation, crop/rot PNG export, shortcuts, and `SandboxBoardHandoff`.
  - **Opening Spawn Predictor in Step `04` (`T-024`, `T-027`, `D-025`)**: Pre-compiled `zhou1736948757-cpu/notes` (`1,353` `ok` records × `9` maps × `35` hunters) into offline `spawn-predictions.json` + pure-TS `spawn-predict.ts` (universal `cellIdToPilZone` bijection incl. `永眠镇 14 <-> 9` & `湖景村`/`月亮河公园 14..34 <-> 9..11`); Step `04` keeps the 5-step `#bar` and mounts `.region-submode-bar` (`56px`, `#s4` heights `602/734/914`) toggling `开局选点预测` ↔ `封禁与距离分析` (defaulting to `'lock'` on initial/blind/reveal entry with strict `sealedTruth` sealing) plus `带入封禁分析` & `发送到战术沙盘`. Closed Phase 5 baseline: `131` renderer + `154` frontend + `58` backend + `118` isolated PW `1.65.2` + `28` host PW `1.41.0` = `489/489` PASS.
- Phase 6 `D-026` Carbon High Visual Parity Audit & Stage-Level Polish (`T-029..T-033` all Attempt 1 `PASSED`, 41/41 tasks closed):
  - **Typography, Archival Controls & Shell (`T-029`)**: Added offline Fontsource true-italic `Cormorant Garamond` (`500i`/`600i`/`700`/`700i`) and `Noto Serif SC` (`600`/`900`) `.woff2` (`font-synthesis-style: none`, `0` external URLs, `manor.css` untouched); replaced all OS controls (`appearance: none` + base64 SVG chevrons/thumbs/checkmarks across `.sel`, inputs, sliders, checkboxes); restored `7px`-inset antique-gold double-hairline parchment framing + toasted-sepia vignette + stepped shadow (`clutterVisible == 0`, `folioStackPseudos == ["none","none"]`, `0` desk props, `11/11` disk PNG SHA-256 unchanged); restored `#bar` transparent slate inactive `#steps` + sculpted cream-brass `.on` + vivid crimson `V` (`#ff665e`, `5.80:1`), chamfered luggage-tag `.bookmark`, circular laurel `Stage 04 (IV)` / `05 / Stage` crests, and astrolabe `ManorMapFrame` (note: rotated needle uses `.compass g[transform]`).
  - **Stage-by-Stage Restoration (`T-030`, `T-031`, `T-032`)**: Stage `01` upright double-bordered map plates + brass rivets + labeled dark-brass filters + `#dropZone` restored gold `V` laurel + folded `.zip` SVG + `— 或 —` + bilingual folder CTA; Stage `02` ebony-brass rails + embossed `V` laurel + sculpted `#rightTabs` + full Manor Tactician's Workbook across all 6 PIL 2D whiteboard tools (`toolbarOverflowPx == 0`, `42/42` crowded-frame nameplates `0.0 px²` overlap); Stage `03` `Chinatown` calligraphic watermark + 3 double-brass phase medallions + bronze-ringed KPIs + parchment ledger tables (`0` `.dark`); Stage `04` glowing sapphire/crimson role medallions + typewriter/padlock locked cipher + gilded locked row + sculpted Mode A Spawn Predictor plaques; Stage `05` `18px` brushed-brass `7/7` progress slot + chamfered bronze step lozenges + 4-column `#dfc89e` matrix header + parchment status legend (`0 px²` 9-map `detail.dense` overlap, `6/6` `D-008`/`D-020` photometry green).
  - **Closed Phase 6 Baseline (`T-033`, `499/499` PASS, `5/5 VALID_TEST_EVIDENCE`)**: `131` renderer + `161` frontend + `58` backend + `120` isolated PW `1.65.2` + `29` host PW `1.41.0` (`0` fail/error/skip, min rendered WCAG AA contrast `5.7443:1`, `minFont = 12.0px`, `0px` overflow, `0` external URLs, `0` `sealedTruth` leaks).

### User constraints

- Never call unrestricted `pickle.load`/`pickle.loads`; always run static `pickletools.genops` + `SafeUnpickler`.
- Never fabricate placeholder images; sync real assets from `zhou1736948757-cpu/notes`. If any new image generation is ever needed, invoke `codex` CLI (`如需生图，调用codex cli`).
- `packages/replay-renderer/` must stay 100% free of DOM/Vue/React dependencies (`"lib": ["ES2022"]`) for direct WeChat Mini Program `<canvas type="2d">` portability.
- Never modify `i:\geminiiii\idv_demo_audit_20261124_002337\` or the original uploaded ZIP.

### Durable risks

Record unresolved risks with an owner and next check.

### Memory candidates

Worker and Reviewer may propose additions here in their Result/Review artifacts. Main is the Memory Gatekeeper and decides whether a candidate has durable value before merging it into this file.

### Retention boundary

Do not record Worker/Reviewer started or finished events, routine PASS/FAIL trace, shell exits, retries, interruptions, continuations, timeouts, waiting, status sync, concurrency checks, or ordinary tool logs here. Those belong in `Workflow/events.jsonl`, `Workflow/STATE.json`, task artifacts, results, reviews, or decisions.

### Update rules

- Keep this file concise, high-density, and append-oriented.
- Do not delete old history during v1.3 → v1.4 compatibility migration.
- Record a Memory Delta when a Chief decision adds, supersedes, or removes durable knowledge.
- Never store secrets or sensitive personal data.
<!-- chef-worker-reviewer-workflow:memory:end -->
