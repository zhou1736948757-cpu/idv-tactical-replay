#!/usr/bin/env python3
"""
Render isometric WebGL verification screenshots for one or more Tier-2 optimized .glb files
using local Three.js + MeshoptDecoder + Headless Edge (100% offline, zero CDN requests).

Usage:
  python scripts/render_3d_preview.py <glbPath1> [<glbPath2> ...] --out-dir <dir>
"""
import argparse
import http.server
import json
import os
import socketserver
import sys
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

TOOLS_NM = Path(r"J:\codex-tmp\gltf-tools\node_modules")

VIEWER_HTML = r"""<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#141923}</style>
<script type="importmap">
{
  "imports": {
    "three": "/nm/three/build/three.module.js",
    "three/addons/": "/nm/three/examples/jsm/",
    "meshopt": "/nm/three/examples/jsm/libs/meshopt_decoder.module.js"
  }
}
</script>
</head>
<body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshopt';

window.__renderGlb = async (url) => {
  await MeshoptDecoder.ready;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(960, 640);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  document.body.innerHTML = '';
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x161c27);
  scene.add(new THREE.HemisphereLight(0xfff1d6, 0x3b4558, 1.35));
  const dir = new THREE.DirectionalLight(0xffe7c2, 1.45);
  dir.position.set(120, 220, 140);
  scene.add(dir);

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  scene.add(gltf.scene);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z, 1);

  const camera = new THREE.PerspectiveCamera(42, 960 / 640, maxDim * 0.002, maxDim * 12);
  camera.position.set(center.x + maxDim * 0.58, center.y + maxDim * 0.55, center.z + maxDim * 0.58);
  camera.lookAt(center);

  renderer.render(scene, camera);
  const info = {
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    size: [ +size.x.toFixed(1), +size.y.toFixed(1), +size.z.toFixed(1) ],
  };
  return info;
};
</script>
</body>
</html>
"""


class DualRootHandler(http.server.SimpleHTTPRequestHandler):
    glb_map = {}

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == "/viewer.html":
            body = VIEWER_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/nm/"):
            rel = self.path[4:].split("?")[0]
            fp = TOOLS_NM / rel
            if fp.is_file():
                body = fp.read_bytes()
                ctype = "application/javascript" if fp.suffix in (".js", ".mjs") else "application/wasm" if fp.suffix == ".wasm" else "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        if self.path.startswith("/glb/"):
            key = self.path[5:].split("?")[0]
            fp = self.glb_map.get(key)
            if fp and fp.is_file():
                body = fp.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "model/gltf-binary")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        self.send_error(404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glbs", nargs="+")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    glb_map = {}
    for g in args.glbs:
        p = Path(g).resolve()
        glb_map[p.name] = p
    DualRootHandler.glb_map = glb_map

    httpd = socketserver.TCPServer(("127.0.0.1", 0), DualRootHandler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    results = {}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                channel="msedge",
                headless=True,
                args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"],
            )
            page = browser.new_page(viewport={"width": 960, "height": 640})
            errors = []
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"http://127.0.0.1:{port}/viewer.html", wait_until="load")
            page.wait_for_function("typeof window.__renderGlb === 'function'", timeout=15000)
            for name, fp in glb_map.items():
                errors.clear()
                info = page.evaluate(f"window.__renderGlb('/glb/{name}')")
                png_path = out_dir / (fp.stem + "-3d-preview.png")
                page.screenshot(path=str(png_path))
                info["errors"] = list(errors)
                info["previewPng"] = str(png_path)
                results[fp.stem] = info
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
