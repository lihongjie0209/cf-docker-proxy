/**
 * Docker Hub Proxy Worker
 *
 * Supported scenarios:
 *   /token           → auth.docker.io/token   (OAuth 2 token endpoint)
 *   /v2/             → registry-1.docker.io/v2/  (API version check → 401 + WWW-Authenticate)
 *   /v2/<name>/manifests/<ref>   → pull/push image manifest
 *   /v2/<name>/blobs/<digest>    → pull blob (layer)
 *   /v2/<name>/blobs/uploads/    → initiate blob push
 *   /v2/<name>/tags/list         → list tags
 *   ... all other /v2/* Registry API paths
 *
 * Key behaviours:
 *   - WWW-Authenticate realm is rewritten to point to this proxy's /token endpoint
 *   - Location headers from blob upload redirects are rewritten to stay on-proxy
 *   - Hop-by-hop headers are stripped to avoid HTTP/2 protocol errors
 */

const REGISTRY = "https://registry-1.docker.io";
const AUTH     = "https://auth.docker.io";

const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
  "proxy-connection",
]);

function buildRequestHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of incoming) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

function buildResponseHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of incoming) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  }
  // Unlike the GitHub proxy, Docker Registry v2 requires Content-Length for
  // blob and manifest responses — the Docker daemon validates sizes against it.
  // We intentionally keep content-length here.
  return out;
}

/**
 * Rewrite the realm inside a WWW-Authenticate Bearer challenge so the Docker
 * client fetches tokens from our proxy instead of auth.docker.io directly.
 *
 * Original: Bearer realm="https://auth.docker.io/token",service="registry.docker.io"
 * Rewritten: Bearer realm="https://dh.lihongjie.cn/token",service="registry.docker.io"
 */
function rewriteWWWAuthenticate(header: string, proxyOrigin: string): string {
  return header.replace(
    /realm="https:\/\/auth\.docker\.io(\/[^"]*)"/,
    `realm="${proxyOrigin}/token"`,
  );
}

/**
 * Rewrite Location headers produced by blob upload redirects.
 * Docker issues PATCH/PUT to a UUID URL that may live on registry-1.docker.io.
 */
function rewriteLocation(location: string, proxyOrigin: string): string {
  if (location.startsWith(`${REGISTRY}/`)) {
    return proxyOrigin + location.slice(REGISTRY.length);
  }
  if (location.startsWith(`${AUTH}/`)) {
    return proxyOrigin + location.slice(AUTH.length);
  }
  return location;
}

async function proxyRequest(
  request: Request,
  targetUrl: string,
  proxyOrigin: string,
  followRedirects = true,
): Promise<Response> {
  const reqHeaders = buildRequestHeaders(request.headers);

  const upstreamReq = new Request(targetUrl, {
    method: request.method,
    headers: reqHeaders,
    // Pass body for PUT/PATCH/POST (blob uploads, manifest pushes)
    body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
    // @ts-ignore — Workers-specific duplex hint for streaming bodies
    duplex: "half",
    // For blob GETs we pass redirects through to the Docker client so it
    // fetches directly from the CDN. This avoids CF stripping Content-Length
    // when re-encoding chunked responses from the CDN.
    redirect: followRedirects ? "follow" : "manual",
  });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamReq);
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err}`, { status: 502 });
  }

  const respHeaders = buildResponseHeaders(upstream.headers);

  const wwwAuth = upstream.headers.get("www-authenticate");
  if (wwwAuth) {
    respHeaders.set("www-authenticate", rewriteWWWAuthenticate(wwwAuth, proxyOrigin));
  }

  const location = upstream.headers.get("location");
  if (location) {
    respHeaders.set("location", rewriteLocation(location, proxyOrigin));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

function landingPage(origin: string): Response {
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Docker Hub 镜像代理</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;padding:0 20px;color:#222}
  h1{font-size:1.8rem;margin-bottom:.3em}
  .badge{display:inline-block;background:#0db7ed;color:#fff;font-size:.75rem;padding:2px 8px;border-radius:4px;margin-left:8px;vertical-align:middle}
  code,pre{background:#f4f4f4;border-radius:4px;font-size:.9em}
  code{padding:1px 5px}
  pre{padding:12px 16px;overflow-x:auto}
  .card{border:1px solid #e0e0e0;border-radius:8px;padding:20px;margin:16px 0}
  .note{color:#666;font-size:.9em}
</style>
</head>
<body>
<h1>Docker Hub 镜像代理 <span class="badge">Cloudflare Workers</span></h1>
<p class="note">加速访问 Docker Hub，支持 pull / push / 认证 / API</p>

<div class="card">
  <h3>🚀 快速使用</h3>
  <pre># 拉取镜像（替换默认 registry）
docker pull ${origin.replace(/^https?:\/\//, '')}/library/nginx:latest
docker pull ${origin.replace(/^https?:\/\//, '')}/library/ubuntu:22.04

# 带用户名的镜像
docker pull ${origin.replace(/^https?:\/\//, '')}/username/image:tag</pre>
</div>

<div class="card">
  <h3>⚙️ 配置为默认镜像源</h3>
  <p>编辑 <code>/etc/docker/daemon.json</code>：</p>
  <pre>{
  "registry-mirrors": ["${origin}"]
}</pre>
  <p>然后重启 Docker：<code>sudo systemctl restart docker</code></p>
  <p>之后直接使用标准命令，无需修改镜像名：</p>
  <pre>docker pull nginx:latest
docker pull ubuntu:22.04</pre>
</div>

<div class="card">
  <h3>🔐 推送镜像</h3>
  <pre># 登录到代理（使用 Docker Hub 账号）
docker login ${origin.replace(/^https?:\/\//, '')}

# 打 tag 并推送
docker tag myimage:latest ${origin.replace(/^https?:\/\//, '')}/username/myimage:latest
docker push ${origin.replace(/^https?:\/\//, '')}/username/myimage:latest</pre>
</div>

<div class="card">
  <h3>📡 代理端点</h3>
  <table style="width:100%;border-collapse:collapse;font-size:.9em">
    <tr><th style="text-align:left;padding:6px 0;border-bottom:1px solid #eee">路径</th><th style="text-align:left;padding:6px 0;border-bottom:1px solid #eee">目标</th></tr>
    <tr><td><code>/token</code></td><td>auth.docker.io/token（认证）</td></tr>
    <tr><td><code>/v2/*</code></td><td>registry-1.docker.io/v2/*（Registry API）</td></tr>
  </table>
</div>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const proxyOrigin = `${url.protocol}//${url.host}`;
    const { pathname, search } = url;

    // Landing page
    if (pathname === "/" || pathname === "") {
      return landingPage(proxyOrigin);
    }

    // Docker token auth endpoint
    // Docker sends: GET /token?service=registry.docker.io&scope=repository:...
    if (pathname === "/token") {
      return proxyRequest(request, `${AUTH}/token${search}`, proxyOrigin);
    }

    // Registry API — all /v2/* paths
    if (pathname.startsWith("/v2/") || pathname === "/v2") {
      // Blob GET/HEAD: pass 307 redirects directly to the Docker client so it
      // fetches from the CDN itself. This prevents CF from stripping
      // Content-Length when it re-encodes the CDN's chunked response.
      const isBlobFetch =
        request.method === "GET" &&
        /\/v2\/.+\/blobs\/sha256:[0-9a-f]+$/.test(pathname);
      return proxyRequest(
        request,
        `${REGISTRY}${pathname}${search}`,
        proxyOrigin,
        !isBlobFetch,
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
