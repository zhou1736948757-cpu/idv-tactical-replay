#!/usr/bin/env node
/**
 * Tier-2 Mobile Lightening Pipeline for PIL 3D Map Runtime Bundles
 * Extracts glTF 2.0 `model-data` + `nav-data` + `map-info` from a PIL runtime HTML,
 * strips dead metadata (`node.extras`) & unused `TEXCOORD_1`, performs selective
 * Meshopt quadric simplification (aggressive on foliage/clutter, medium on props,
 * gentle on tactical walls/floors/pallets), deduplicates textures/materials into WebP,
 * collapses draw calls via GPU instancing (`EXT_mesh_gpu_instancing`) + static material
 * merging (`join`), and applies `KHR_mesh_quantization` + `EXT_meshopt_compression`.
 *
 * Usage:
 *   NODE_PATH=J:\codex-tmp\gltf-tools\node_modules node scripts/optimize_3d_map.mjs <input.html> <outputDir> [--max-tex=512] [--webp-q=76] [--foliage-ratio=0.30] [--prop-ratio=0.48] [--arch-ratio=0.78]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const toolModules = process.env.GLTF_TOOLS_MODULES || 'J:\\codex-tmp\\gltf-tools\\node_modules';
const req = createRequire(path.join(toolModules, 'package.json'));

const { NodeIO } = req('@gltf-transform/core');
const {
  EXTMeshGPUInstancing,
  EXTMeshoptCompression,
  EXTTextureWebP,
  KHRMeshQuantization,
  KHRTextureTransform,
} = req('@gltf-transform/extensions');
const {
  dedup,
  flatten,
  instance,
  join,
  meshopt,
  prune,
  quantize,
  simplify,
  weld,
} = req('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptSimplifier } = req('meshoptimizer');
const sharp = req('sharp');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
if (positional.length < 2) {
  console.error('Usage: node optimize_3d_map.mjs <input.html> <outputDir> [options]');
  process.exit(1);
}
const inputHtml = positional[0];
const outDir = positional[1];

function optNum(flag, fallback) {
  const m = args.find((a) => a.startsWith(`--${flag}=`));
  if (!m) return fallback;
  const v = Number(m.split('=')[1]);
  return Number.isFinite(v) ? v : fallback;
}

const MAX_TEX = optNum('max-tex', 384);
const WEBP_Q = optNum('webp-q', 72);
const FOLIAGE_RATIO = optNum('foliage-ratio', 0.22);
const PROP_RATIO = optNum('prop-ratio', 0.36);
const ARCH_RATIO = optNum('arch-ratio', 0.50);
const ARCH_ERR = optNum('arch-err', 0.016);

const CORE_ARCH_RE = /(wall|ground|terrain|floor|road|bridge|stair|step|house|building|room|factory|church|hospital|shack|gate|door|window|pallet|plank|roof|dome|tower|ship|hull|deck|cabin|school|theater|opera|pavilion|qiang|dimian|diban|lou|fang|men|chuang|qiao)/i;
const FOLIAGE_RE = /(plant|tree|grass|bush|leaf|leaves|weed|flower|vine|ivy|fern|reed|moss|branch|shrub|mutong|barrel|rubble|debris|stone|rock|pebble|grassland|pine|sakura|bamboo|corn|wheat|snow_pile|shu|cao|hua|ye|shuzhi|shitou|caocong|shumu|zhu)/i;
const PROP_RE = /(gallows|sender|chair|cipher|chest|locker|box|crate|statue|cart|car|wagon|lamp|lantern|fence|railing|sign|table|bed|desk|bench|tomb|grave|cross|pot|vase|bottle|bucket|sack|bag|tent|umbrella|banner|flag|rope|chain|wheel|pipe|junk|prop|ornament|decor|balloon|carousel|coaster|windmill|silo|tank|wire|pole|deng|xiang|tong|che|lan|gui|zhuo|yi|chuang_prop)/i;

function classifyMesh(name) {
  const n = name || '';
  if (FOLIAGE_RE.test(n)) return 'foliage';
  if (PROP_RE.test(n)) return 'prop';
  if (CORE_ARCH_RE.test(n)) return 'arch';
  return 'prop';
}

function countSceneStats(doc) {
  const root = doc.getRoot();
  const nodes = root.listNodes();
  const meshes = root.listMeshes();
  const mats = root.listMaterials();
  const texs = root.listTextures();

  let uniqueVerts = 0;
  let uniqueTris = 0;
  const meshTris = new Map();
  const meshPrims = new Map();

  for (const mesh of meshes) {
    let mt = 0;
    const prims = mesh.listPrimitives();
    for (const p of prims) {
      const pos = p.getAttribute('POSITION');
      const idx = p.getIndices();
      if (pos) uniqueVerts += pos.getCount();
      const tc = idx ? Math.floor(idx.getCount() / 3) : pos ? Math.floor(pos.getCount() / 3) : 0;
      uniqueTris += tc;
      mt += tc;
    }
    meshTris.set(mesh, mt);
    meshPrims.set(mesh, prims.length);
  }

  let drawCalls = 0;
  let renderedTris = 0;
  let instancedNodes = 0;
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const batch = node.getExtension('EXT_mesh_gpu_instancing');
    let instCount = 1;
    if (batch) {
      instancedNodes++;
      const tAttr = batch.getAttribute('TRANSLATION') || batch.getAttribute('ROTATION') || batch.getAttribute('SCALE');
      if (tAttr) instCount = tAttr.getCount();
    }
    drawCalls += meshPrims.get(mesh) || 0;
    renderedTris += (meshTris.get(mesh) || 0) * instCount;
  }

  return {
    nodes: nodes.length,
    meshes: meshes.length,
    materials: mats.length,
    textures: texs.length,
    uniqueVerts,
    uniqueTris,
    drawCalls,
    renderedTris,
    instancedNodes,
  };
}

function compactPrimitiveVertices(prim) {
  const idx = prim.getIndices();
  if (!idx) return;
  const oldIdx = idx.getArray();
  const pos = prim.getAttribute('POSITION');
  if (!pos) return;
  const oldVertCount = pos.getCount();
  const remap = new Int32Array(oldVertCount).fill(-1);
  let newCount = 0;
  for (let i = 0; i < oldIdx.length; i++) {
    const v = oldIdx[i];
    if (remap[v] === -1) remap[v] = newCount++;
  }
  if (newCount === oldVertCount) return;

  const newIdx = newCount < 65535 ? new Uint16Array(oldIdx.length) : new Uint32Array(oldIdx.length);
  for (let i = 0; i < oldIdx.length; i++) newIdx[i] = remap[oldIdx[i]];
  idx.setArray(newIdx);

  for (const sem of prim.listSemantics()) {
    const attr = prim.getAttribute(sem);
    if (!attr) continue;
    const elemSize = attr.getElementSize();
    const src = attr.getArray();
    const Ctor = src.constructor;
    const dst = new Ctor(newCount * elemSize);
    for (let oldV = 0; oldV < oldVertCount; oldV++) {
      const nv = remap[oldV];
      if (nv === -1) continue;
      const so = oldV * elemSize;
      const doff = nv * elemSize;
      for (let k = 0; k < elemSize; k++) dst[doff + k] = src[so + k];
    }
    attr.setArray(dst);
  }
}

function normalizePositions(posArr) {
  const n = posArr.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < posArr.length; i += 3) {
    const x = posArr[i], y = posArr[i + 1], z = posArr[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const out = new Float32Array(posArr.length);
  for (let i = 0; i < posArr.length; i += 3) {
    out[i] = (posArr[i] - minX) / extent;
    out[i + 1] = (posArr[i + 1] - minY) / extent;
    out[i + 2] = (posArr[i + 2] - minZ) / extent;
  }
  return out;
}

function simplifyPrimitiveInPlace(prim, ratio, error, lockBorder) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  if (!pos || !idx) return;
  const srcIndices = new Uint32Array(idx.getArray());
  const triCount = Math.floor(srcIndices.length / 3);
  if (triCount < 18) return;

  const targetCount = Math.max(12, Math.floor(triCount * ratio) * 3);
  if (targetCount >= srcIndices.length) return;

  const normPos = normalizePositions(new Float32Array(pos.getArray()));
  const flags = lockBorder ? ['LockBorder'] : [];
  try {
    let [dstIndices] = MeshoptSimplifier.simplify(
      srcIndices,
      normPos,
      3,
      targetCount,
      error,
      flags,
    );
    // On open-seam foliage & decorative props where UV splits block normal collapse, use simplifySloppy
    if (!lockBorder && (!dstIndices || dstIndices.length > srcIndices.length * Math.min(0.82, ratio + 0.18))) {
      if (typeof MeshoptSimplifier.simplifySloppy === 'function') {
        const [sloppy] = MeshoptSimplifier.simplifySloppy(
          srcIndices,
          normPos,
          3,
          targetCount,
          Math.min(0.18, error * 2.5),
        );
        if (sloppy && sloppy.length >= 12 && (!dstIndices || sloppy.length < dstIndices.length)) {
          dstIndices = sloppy;
        }
      }
    }
    if (dstIndices && dstIndices.length >= 9 && dstIndices.length < srcIndices.length) {
      const useU16 = pos.getCount() < 65535;
      idx.setArray(useU16 ? new Uint16Array(dstIndices) : dstIndices);
      compactPrimitiveVertices(prim);
    }
  } catch {
    // Keep original primitive if simplifier declines degenerate topology
  }
}

async function run() {
  const t0 = Date.now();
  fs.mkdirSync(outDir, { recursive: true });

  const html = fs.readFileSync(inputHtml, 'utf8');
  const infoMatch = html.match(/<script id="map-info"[^>]*>([\s\S]*?)<\/script>/);
  const modelMatch = html.match(/<script id="model-data"[^>]*>([\s\S]*?)<\/script>/);
  const navMatch = html.match(/<script id="nav-data"[^>]*>([\s\S]*?)<\/script>/);

  if (!modelMatch) throw new Error(`No #model-data found in ${inputHtml}`);
  const mapInfo = infoMatch ? JSON.parse(infoMatch[1].trim()) : {};
  const mapId = mapInfo.mapId || path.basename(inputHtml).split('.')[0];
  const nameZh = mapInfo.nameZh || mapId;

  const rawHtmlBytes = fs.statSync(inputHtml).size;
  const rawGlbBuf = Buffer.from(modelMatch[1].trim(), 'base64');
  const rawGlbGzip = zlib.gzipSync(rawGlbBuf, { level: 6 }).length;

  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;

  const io = new NodeIO()
    .registerExtensions([
      EXTMeshGPUInstancing,
      EXTMeshoptCompression,
      EXTTextureWebP,
      KHRMeshQuantization,
      KHRTextureTransform,
    ])
    .registerDependencies({
      'meshopt.encoder': MeshoptEncoder,
    });

  const doc = await io.readBinary(new Uint8Array(rawGlbBuf));
  const before = countSceneStats(doc);
  const root = doc.getRoot();

  // 1. Strip bloated debug extras from all nodes & meshes (saves ~3 MB JSON per map)
  for (const node of root.listNodes()) {
    node.setExtras({});
    node.setName('');
  }
  for (const mat of root.listMaterials()) {
    mat.setExtras({});
    mat.setName('');
  }
  for (const tex of root.listTextures()) {
    tex.setExtras({});
    tex.setName('');
  }

  // 2. Check if any material actually references TEXCOORD_1; strip dead TEXCOORD_1 if unused
  let usesTexCoord1 = false;
  for (const mat of root.listMaterials()) {
    for (const info of [
      mat.getBaseColorTextureInfo(),
      mat.getMetallicRoughnessTextureInfo(),
      mat.getNormalTextureInfo(),
      mat.getOcclusionTextureInfo(),
      mat.getEmissiveTextureInfo(),
    ]) {
      if (info && info.getTexCoord() === 1) usesTexCoord1 = true;
    }
  }
  if (!usesTexCoord1) {
    for (const mesh of root.listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        if (prim.getAttribute('TEXCOORD_1')) prim.setAttribute('TEXCOORD_1', null);
      }
    }
  }

  // 3. Deduplicate & compress textures to WebP (sharp, <= MAX_TEX)
  const webpExt = doc.createExtension(EXTTextureWebP);
  webpExt.setRequired(false);
  let texBeforeBytes = 0;
  let texAfterBytes = 0;
  const seenTex = new Map();
  for (const tex of root.listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    texBeforeBytes += img.byteLength;
    const h = crypto.createHash('sha256').update(img).digest('hex');
    if (seenTex.has(h)) {
      const { buf, mime } = seenTex.get(h);
      tex.setImage(buf);
      tex.setMimeType(mime);
      continue;
    }
    const pipeline = sharp(Buffer.from(img));
    const meta = await pipeline.metadata();
    let work = pipeline;
    if ((meta.width && meta.width > MAX_TEX) || (meta.height && meta.height > MAX_TEX)) {
      work = work.resize({ width: MAX_TEX, height: MAX_TEX, fit: 'inside', withoutEnlargement: true });
    }
    const outBuf = await work.webp({ quality: WEBP_Q, effort: 5, alphaQuality: 85 }).toBuffer();
    const u8 = new Uint8Array(outBuf);
    seenTex.set(h, { buf: u8, mime: 'image/webp' });
    tex.setImage(u8);
    tex.setMimeType('image/webp');
    texAfterBytes += u8.byteLength;
  }

  // 4. Weld vertices & deduplicate identical materials/textures/meshes/accessors
  await doc.transform(
    dedup(),
    weld({ tolerance: 0.0002 }),
  );

  // 5. Selective Tier-2 Mesh Decimation (foliage aggressive, props/unknown medium, core architecture gentle with LockBorder)
  const tierCounts = { foliage: 0, prop: 0, arch: 0 };
  for (const mesh of root.listMeshes()) {
    const tier = classifyMesh(mesh.getName());
    tierCounts[tier]++;
    const ratio = tier === 'foliage' ? FOLIAGE_RATIO : tier === 'prop' ? PROP_RATIO : ARCH_RATIO;
    const err = tier === 'foliage' ? 0.07 : tier === 'prop' ? 0.032 : ARCH_ERR;
    const lockBorder = tier === 'arch';
    for (const prim of mesh.listPrimitives()) {
      simplifyPrimitiveInPlace(prim, ratio, err, lockBorder);
    }
    mesh.setExtras({});
    mesh.setName('');
  }

  // 6. Collapse draw calls: GPU-instance repeated meshes (>=2 instances) to keep file tiny, flatten & join unique static meshes by material
  await doc.transform(
    prune(),
    dedup(),
    flatten(),
    instance({ min: 2 }),
    join({ keepNamed: false, keepMeshes: false }),
    prune(),
    dedup(),
    quantize({
      quantizePosition: 14,
      quantizeNormal: 8,
      quantizeTexcoord: 12,
      quantizeColor: 8,
      quantizeGeneric: 12,
    }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );

  const after = countSceneStats(doc);
  const outGlbPath = path.join(outDir, `${mapId}.glb`);
  const outBytes = await io.writeBinary(doc);
  fs.writeFileSync(outGlbPath, outBytes);
  const outGzipBytes = zlib.gzipSync(Buffer.from(outBytes), { level: 6 }).length;

  // Also save lightweight nav-data GLB alongside (~100-200 KB) if present
  let navBytes = 0;
  if (navMatch) {
    const navBuf = Buffer.from(navMatch[1].trim(), 'base64');
    navBytes = navBuf.length;
    fs.writeFileSync(path.join(outDir, `${mapId}.nav.glb`), navBuf);
  }

  const report = {
    mapId,
    nameZh,
    sourceFile: path.basename(inputHtml),
    sourceHtmlBytes: rawHtmlBytes,
    rawGlbBytes: rawGlbBuf.length,
    rawGlbGzipBytes: rawGlbGzip,
    optimizedGlbBytes: outBytes.byteLength,
    optimizedGlbGzipBytes: outGzipBytes,
    navGlbBytes: navBytes,
    sizeReductionVsHtmlPct: +((1 - outBytes.byteLength / rawHtmlBytes) * 100).toFixed(1),
    sizeReductionVsGlbPct: +((1 - outBytes.byteLength / rawGlbBuf.length) * 100).toFixed(1),
    gzipReductionVsGlbPct: +((1 - outGzipBytes / rawGlbGzip) * 100).toFixed(1),
    texBeforeBytes,
    texAfterBytes,
    usesTexCoord1,
    tierCounts,
    before,
    after,
    drawCallReductionPct: +((1 - after.drawCalls / Math.max(1, before.drawCalls)) * 100).toFixed(1),
    triReductionPct: +((1 - after.renderedTris / Math.max(1, before.renderedTris)) * 100).toFixed(1),
    elapsedMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(outDir, `${mapId}.report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
