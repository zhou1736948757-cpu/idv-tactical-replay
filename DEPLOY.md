# 庄园战术复盘档案 · 生产部署与运维指南 (`DEPLOY.md`)

本文档面向云服务器 / 内网服务器管理员，说明如何使用 Docker Compose 一键部署 **庄园战术复盘档案**（前端 Nginx + 后端多进程 FastAPI），以及域名 HTTPS、环境变量与日常备份运维流程。

---

## 1. 部署架构概览

- **`frontend` 容器（`nginx:1.27-alpine`）**：
  - 构建期通过 Node 20 编译 `packages/replay-renderer` 与 `frontend` 静态产物；
  - 启用 HTTP/2 与 Gzip（含 `model/gltf-binary` 3D 地图 `.glb` 与 `application/json`）；
  - 分级缓存策略：带哈希静态资源 `1y immutable`、3D `.glb` 场景 `7d + SWR`（支持 `Accept-Ranges: bytes`）、常规静态素材 `1d`、`/index.html` 禁用缓存；
  - 对 `POST /api/replays/upload` 实施单 IP `3r/m`（突发 `burst=3`）限流与 `256m` 流式无缓冲转发。
- **`backend` 容器（`python:3.11-slim`，非 root `appuser`）**：
  - 默认以 `uvicorn app.main:app --workers 2` 启动双进程；
  - 上传以 `64 KiB` 分块流式落盘至 `/data/tmp`，严禁大文件驻留内存；
  - 预置 7 场标准对局只读保护（禁止覆盖，冲突返回 `409`），多进程采用 `PID + 随机 Nonce` 原子替换写入与 `(match_id, mtime_ns)` 内存索引缓存，并按 `IDV_MAX_UPLOADED_MATCHES` 自动 LRU 淘汰旧上传录像。

---

## 2. Docker Compose 一键部署

### 前置要求
- Linux 服务器（推荐 2 vCPU / 4 GB RAM 及以上），已安装 Docker Engine `24+` 与 Docker Compose Plugin `v2+`。

### 启动步骤

```bash
# 1. 复制并按需修改生产环境变量
cp .env.example .env

# 2. 构建镜像并后台启动服务
docker compose up -d --build

# 3. 查看容器健康状态与日志
docker compose ps
curl -fsS http://127.0.0.1:${HTTP_PORT:-80}/api/health
```

健康检查返回 `{"status":"ok","preloaded_matches":7}`（生产模式下自动隐藏服务器内部 `cache_dir` 路径）即代表前后端均已就绪。

---

## 3. HTTPS 与域名配置

### 方案 A：宿主机 Caddy / 宝塔 / 云负载均衡反代（推荐）
1. 在 `.env` 中将端口绑定改为仅本机回环或指定端口（如 `HTTP_PORT=8080`）；
2. 使用 Caddy 自动签发 Let's Encrypt 证书并反代至容器：

```caddyfile
replay.example.com {
    encode zstd gzip
    request_body {
        max_size 256MB
    }
    reverse_proxy 127.0.0.1:8080
}
```

### 方案 B：直接在 `deploy/nginx.conf` 中挂载证书启用 TLS + HTTP/2
1. 在 `docker-compose.yml` 的 `frontend` 服务挂载证书目录（例如 `./certs:/etc/nginx/certs:ro`）并映射 `443:443`；
2. 在 `deploy/nginx.conf` 的 `server` 块中添加：

```nginx
listen 443 ssl;
listen [::]:443 ssl;
http2 on;
ssl_certificate     /etc/nginx/certs/fullchain.pem;
ssl_certificate_key /etc/nginx/certs/privkey.pem;
ssl_protocols       TLSv1.2 TLSv1.3;
```

3. 新增 80 端口跳转块 `return 301 https://$host$request_uri;`，执行 `docker compose up -d --force-recreate frontend` 生效。

---

## 4. 环境变量说明

所有参数均可在根目录 `.env` 中配置：

| 变量名 | 生产推荐值 | 说明 |
|---|---|---|
| `HTTP_PORT` | `80` | 宿主机暴露的 HTTP 端口 |
| `IDV_ENV` | `production` | `production` 隐藏 `/api/health` 路径信息、默认关闭 OpenAPI 文档并保护预置对局 |
| `IDV_PUBLIC_UPLOADS` | `0` | `0` 表示公开列表 `/api/matches` 仅展示预置对局，用户上传录像仅凭专属链接 `#m=<id>` 访问；设为 `1` 则在档案库公开列出所有上传对局 |
| `IDV_REDACT_UID` | `1` | `1` 自动对新上传录像中的玩家 `unique_id` 进行脱敏掩码（`***xx`） |
| `IDV_DISABLE_DOCS` | `1` | `1` 禁用 `/docs`、`/redoc`、`/openapi.json` |
| `IDV_CORS_ORIGINS` | 空（同源反代） | 若前后端分离跨域部署，填写逗号分隔白名单如 `https://replay.example.com` |
| `IDV_MAX_UPLOAD_BYTES` | `268435456` | 单次 ZIP 流式上传上限（默认 `256 MiB`），超限立即中断并返回 `413` |
| `IDV_MAX_MATCHES_PER_UPLOAD` | `5` | 单个 ZIP 允许包含的最大录像局数，超限返回 `400` |
| `IDV_MAX_CONCURRENT_EXTRACTS` | `2` | 单个 Worker 进程内最大并发解包数（Semaphore 限流防 CPU 打满） |
| `IDV_MAX_UPLOADED_MATCHES` | `500` | 磁盘保留的最大用户上传局数，超出后按最近访问时间（LRU）自动清理（永不淘汰预置对局） |
| `VITE_API_BASE` | `/api` | 前端构建期 API 基础路径（默认走同源 Nginx `/api` 反代） |

---

## 5. 日常运维、升级与数据备份

### 查看日志与重启
```bash
# 实时查看后端解包耗时与异常告警日志
docker compose logs -f backend

# 代码更新后平滑重新构建上线（保留已上传缓存数据卷）
git pull
docker compose up -d --build
```

### 备份与恢复录像缓存卷（`idv_cache`）
所有解析后的录像 JSON 均持久化在命名数据卷 `idv_cache`（容器内 `/data/cache`），临时解包目录位于 `idv_tmp`（容器内 `/data/tmp`，无需备份）。

```bash
# 备份 /data/cache 到当前目录 tar.gz
docker compose run --rm --entrypoint sh backend \
  -c 'tar -czf - -C /data/cache .' > idv_cache_backup_$(date +%F).tar.gz

# 从备份包恢复到数据卷
cat idv_cache_backup_YYYY-MM-DD.tar.gz | docker compose run --rm -T --entrypoint sh backend \
  -c 'tar -xzf - -C /data/cache'
```
