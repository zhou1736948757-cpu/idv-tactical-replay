# 庄园战术复盘档案 · 长期维护指南（MAINTENANCE.md）

本文档面向后续赛季与版本迭代，说明如何在不破坏现有桌面/移动端布局契约、数据诚实原则及安全沙箱的前提下，新增战术地图、更新角色数值/肖像/PID，以及适配《第五人格》客户端录像协议变更。

---

## 一、新增战术地图（Map #10+）

当前系统已解除 `0..8` 单数字正则限制（`resolvePilMapId` 自动按 `MAPS_DATA.length` 边界校验），并通过 `hasScene3D(mapId)` 支持“先上线 2D 战术图、后补齐 3D 实景 GLB”的渐进式上线流程。

### 1.1 准备静态资源与统一元数据
1. **2D 俯视网格底图**：放入 `frontend/public/assets/maps/<地图中文名>_grid.jpg`。
2. **2D 绕障导航网格**：生成 1px/cell 通行掩码 PNG，放入 `frontend/public/assets/nav-grid/<MapKey>.png`。
3. **登记共享元数据**：在 `shared/game-data/maps-meta.json` 的 `tacticalMaps` 与 `replaySceneIdMap` 中新增条目（记录 `mapId`、`replaySceneIds`、`aspectRatio`、`mapSize`、`widthM`、`gridPlacement` 等）。

### 1.2 后端录像解析接入
1. 在 `backend/app/field_metadata.py` 的 `REF_MAP_NAMES` 中登记客户端新地图 `scene_id -> "<地图中文名>"`（注意匹配/排位/联合狩猎可能拥有不同 `scene_id`，可多对一指向同一标准中文名）。
2. 在 `backend/app/extractor.py` 的 `MAP_ASPECT_RATIOS` 中补充 `"<地图中文名>": <aspectRatio>`，保证回放包输出的 `world_rect` 长宽比与前端底图一致。

### 1.3 前端 2D 战术数据接入（Stage 02 / 04 / 05）
1. **类型扩展**：在 `frontend/src/tactical/types.ts` 将新 `mapId` 加入 `PilMapId` 联合类型（如 `| 9`）。
2. **中英文词条**：在 `frontend/src/tactical/locales-zh.ts` 补充地图名、9 宫格区域名、密码机点位简称与推演规则文案。
3. **战术点位表**：在 `frontend/src/tactical/maps.ts`：
   - 向 `MAPS_DATA` 追加新地图的 `gridPlacement`、`zonesInfo`、密码机组合 `cipherCombinations`、狂欢之椅 `rocketChairs`、地窖 `dungeons`、地下室 `basements`、出生点组 `spawnPoints` 与推演规则 `makeDeduction(...)`；
   - 更新 `PIL_MAP_COUNT = MAPS_DATA.length`，并在 `MAP_ALIASES` 追加中英文别名正则；
   - 在 `SandboxView.vue` 的 `MAP_ENGLISH` 补充英文副标题。
4. **2D 导航网格清单**：在 `frontend/src/tactical/nav-grid-manifest.ts` 的 `RAW_NAV_GRID_MANIFEST` 中登记新 `mapId` 的 `metersPerCell`、窗户翻越点 `windows` 与地下室楼梯出口 `basements`。

### 1.4 3D 实景与模拟跑图接入（可选，未配置时自动降级为纯 2D）
- 若暂未制作 3D 模型：`hasScene3D(mapId)` 会自动返回 `false`，沙盘 `3D` 按钮自动禁用并安全保持在 `2D` 模式，不会触发 404 或崩溃。
- 若需上线 3D 实景：
  1. 使用 `node scripts/optimize_3d_map.mjs` 压缩生成 `<scene_id>.glb`（WebP 贴图 + Meshopt/Instancing）与 `<scene_id>.nav.glb`，放入 `frontend/public/assets/maps-3d/`（注意构建插件会自动剔除 `dist/` 中的 `*.report.json`）。
  2. 通过至少 4 组非共线地标（大门、地窖、固定密码机）最小二乘拟合 `normalizedToWorld` 与 `worldToPixel` 六参数仿射矩阵，写入 `frontend/src/tactical/scene3d/calibration3d.ts` 的 `MAP_3D_CALIBRATION`、`PrimaryScene3DId` 与 `SCENE_3D_LABELS_ZH`。

---

## 二、更新角色移速、技能范围、肖像与 PID 映射

### 2.1 角色移速、手持物与范围圈（白板沙盘）
1. **求生者/监管者角色表**：编辑 `frontend/src/tactical/roles-roster.ts`（`RAW_SURVIVOR_ROLES` / `RAW_HUNTER_ROLES`）：
   - `speed` / `speeds`：调整基础移速或多形态移速（单位 `m/s`；换算关系固定为 `45 世界单位/s === 3.80 m/s`）；
   - `traits`：更新角色外在特质加速/减速倍率（`mult`）与持续秒数（`duration`）；
   - `ranges`：更新技能/特质范围半径 `size_m`；
   - `fearRadius`：更新监管者恐惧半径倍率。
2. **手持物/实体道具**：在 `frontend/src/tactical/items.ts` 新增或调整创生物图标、范围圈及与本体的联动距离。
3. **天赋数值补丁**：
   - 白板测算/扛刀/搏命模型：更新 `frontend/src/tactical/talents.ts`、`carry-model.ts`、`tide-model.ts`；
   - 回放求生者天赋名称：更新 `backend/app/field_metadata.py` 的 `REF_SURVIVOR_GENIUS_NAMES`（严禁将该表套用到 `camp == 1` 监管者天赋 ID）。
4. **3D 漫游移速预设**：如需在 3D 跑图中加入新移速档位，编辑 `frontend/src/tactical/scene3d/calibration3d.ts` 的 `ROAM_SPEED_PRESETS`。

### 2.2 新增监管者肖像
1. 将透明或方形头像保存为 `frontend/public/assets/hunters/<角色中文名>.png`。
2. 在以下两处白名单同步追加 `<角色中文名>`：
   - `frontend/src/lib/format.ts` 的 `HUNTER_PORTRAITS`
   - `frontend/src/tactical/roles-roster.ts` 的 `SHIPPED_HUNTER_PORTRAITS`
   - 同步记录至 `shared/game-data/character-pids.json` 的 `shippedHunterPortraits`。

### 2.3 验证并登记角色 PID（严格遵循数据诚实原则）
1. 使用已知单角色开启自定义单人录像，导出 `.zip` 并通过后端解析查看 `replay_2d.json` 中 `players[].pid` 与 `camp`。
2. 在 `shared/game-data/character-pids.json` 中将对应条目的 `"roleKey"`、`"nameZh"` 填好并将 `"verified"` 设为 `true`，备注验证录像编号。
3. **红线约束**：任何未经实局核验的 `pid` 必须保持 `verified: false`，前端 `pidLabel()` 继续诚实展示 `PID #N`，绝不猜测角色名。

---

## 三、客户端版本更新与录像解析器（Replay Parser）维护

当网易客户端大版本更新导致上传 `.zip` 报错或事件缺失时，按以下顺序排查：

### 3.1 安全反序列化白名单检查（`backend/app/safe_pickle.py`）
- **禁止破坏的安全红线**：严禁引入原生 `pickle.load` / `pickle.loads`（`backend/tests/test_security.py` 通过 AST 静态扫描强制拦截）。
- **协议升级适配**：当前客户端快照使用 Python Pickle Protocol 2。若未来客户端升级至 Protocol 4+（引入 `FRAME`、`MEMOIZE`、字面量 `STACK_GLOBAL` 等操作码）：
  1. 在隔离环境中用 `pickletools.genops` 检查新快照的 opcode 与 `GLOBAL` 引用；
  2. 仅在确认无任意代码执行风险后，于 `ALLOWED_GLOBALS` 中为纯数据构造器编写无副作用替身类（参考 `SafeObjectId`），切勿放开 `INST` / `OBJ` / `EXT*` 或非字面量 `STACK_GLOBAL`。

### 3.2 快照结构与帧事件码（`et`）核对（`backend/app/extractor.py`）
1. **核心入口文件校验**：确认录像目录仍包含 `game_info.txt`、`total_info.txt` 及分片 `battle_frames_snapshot_*.txt`。
2. **位移与特殊监管者同步**：
   - 常规实体通过移动事件与 `et=32` 更新坐标，注意过滤 `abs(y) > 500` 的哨兵坐标（如 `-65536`）；
   - 若新监管者像 `pid=102` 一样采用专属事件码（如 `et=1110` 的 `target_pos`）同步瞬移/附身位置，在 `extractor.py` 的帧事件循环中补充对应 `et` 分支。
3. **RPC 通道与交互事件**：
   - `et=10999`（`channel=13`）通过 `UnitManager` 组件树中的 `shadow_instance_id` 反查所属实体 `uid`；若新版本新增交互方法名（如新型板窗/机关/救援状态码），在 `extractor.py` 对应 RPC 分发表与 `field_metadata.py` 的 `ET_METADATA` / `UNIT_TYPE_MEANINGS` 中登记。
4. **预置缓存刷新**：修改解析逻辑后运行 `python backend/scripts/preload_cache.py` 重新生成 `backend/data/cache/` 并执行全套测试。

---

## 四、发布前必跑回归校验清单

每次提交维护改动前，请依次执行以下命令确认零回归：

```powershell
# 1. 前端类型检查、单元测试与生产构建（自动剔除 dist 冗余 .woff / desk-*.png / *.report.json）
$env:TEMP='J:\codex-tmp\win-tmp'; $env:TMP='J:\codex-tmp\win-tmp'
npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build

# 2. 后端安全与提取器回归测试
pytest backend/tests
```

**不变量核查**：
- `frontend/public/assets/dossier/**/*.png` 源素材保持 `11/11` 完整未改动；
- 所有 CSS 字号 `>= 12px`，零外部 `http(s)://` 运行时依赖；
- 桌面端（`>= 1100px`）与移动端（`390×844` 竖屏、`844×390` 横屏）零横向溢出、零控件遮挡。
