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
): Promise<Response> {
  const reqHeaders = buildRequestHeaders(request.headers);

  const upstreamReq = new Request(targetUrl, {
    method: request.method,
    headers: reqHeaders,
    // Pass body for PUT/PATCH/POST (blob uploads, manifest pushes)
    body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
    // @ts-ignore — Workers-specific duplex hint for streaming bodies
    duplex: "half",
  });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamReq);
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err}`, { status: 502 });
  }

  const respHeaders = buildResponseHeaders(upstream.headers);

  // Docker daemon requires Content-Length for blob downloads. CF Workers may
  // omit it when fetching over HTTP/2 from CDN (where framing replaces it).
  // If missing, recover it via a HEAD request to the final resolved URL.
  if (!respHeaders.has("content-length") && upstream.body) {
    const headResp = await fetch(upstream.url, { method: "HEAD" });
    const cl = headResp.headers.get("content-length");
    if (cl) respHeaders.set("content-length", cl);
  }

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
  const host = origin.replace(/^https?:\/\//, '');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Docker Hub 镜像代理</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --card: #21262d; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #e3b341; --radius: 8px;
  }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; padding: 2rem 1rem; }
  .container { max-width: 800px; margin: 0 auto; }
  header { text-align: center; padding: 2rem 0 2.5rem; }
  header h1 { font-size: 2rem; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: .6rem; }
  header p { color: var(--muted); margin-top: .6rem; font-size: .95rem; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: var(--accent); }

  .btn {
    background: var(--accent); color: #000; border: none; border-radius: 6px;
    padding: .6rem 1.1rem; font-size: .875rem; font-weight: 600; cursor: pointer;
    transition: opacity .15s; white-space: nowrap;
  }
  .btn:hover { opacity: .85; }
  .btn.sm { padding: .35rem .75rem; font-size: .8rem; }
  .btn.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  .btn.ghost:hover { color: var(--accent); border-color: var(--accent); opacity: 1; }

  /* Steps */
  .steps { display: flex; flex-direction: column; gap: .75rem; }
  .step { display: flex; gap: .75rem; }
  .step-num {
    width: 22px; height: 22px; border-radius: 50%; background: rgba(88,166,255,.2);
    color: var(--accent); font-size: .75rem; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px;
  }
  .step-body { flex: 1; }
  .step-body p { font-size: .875rem; color: var(--muted); margin-bottom: .4rem; }
  .code-block {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: .65rem .9rem; font-family: "SFMono-Regular", Consolas, monospace;
    font-size: .82rem; color: var(--text); display: flex; gap: .5rem; align-items: flex-start;
  }
  .code-block pre { flex: 1; margin: 0; white-space: pre-wrap; word-break: break-all; color: var(--green); }
  .note { font-size: .78rem; color: var(--muted); margin-top: .4rem; }
  .copied-flash { font-size: .75rem; color: var(--green); opacity: 0; transition: opacity .3s; white-space: nowrap; }
  .copied-flash.show { opacity: 1; }

  /* Route table */
  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: .5rem .75rem; border-bottom: 1px solid var(--border); }
  td { padding: .55rem .75rem; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  code { background: rgba(110,118,129,.15); border-radius: 4px; padding: .15em .45em; font-family: "SFMono-Regular", Consolas, monospace; font-size: .85em; }

  footer { text-align: center; color: var(--muted); font-size: .8rem; padding: 2rem 0 1rem; }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🐋 Docker Hub 镜像代理</h1>
    <p>基于 Cloudflare Workers &nbsp;·&nbsp; 支持 pull / push · 认证 · Registry API</p>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap;justify-content:center;margin-top:.75rem;font-size:.85rem;">
      <span style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:.3rem .75rem;">🌐 国际线路：<code>dh.lihongjie.cn</code></span>
      <span style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:.3rem .75rem;">🇨🇳 国内优选：<code>dh.cn.lihongjie.cn</code></span>
    </div>
  </header>

  <!-- Quick Pull -->
  <div class="card">
    <h2>🚀 快速拉取</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>直接在镜像名前加上代理域名：</p>
          <div class="code-block">
            <pre>docker pull ${host}/library/nginx:latest
docker pull ${host}/library/ubuntu:22.04
docker pull ${host}/username/image:tag</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- daemon.json -->
  <div class="card">
    <h2>⚙️ 配置为默认镜像源</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>编辑 <code>/etc/docker/daemon.json</code>，添加镜像源：</p>
          <div class="code-block">
            <pre>{
  "registry-mirrors": ["${origin}"]
}</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <p>重启 Docker 使配置生效：</p>
          <div class="code-block">
            <pre>sudo systemctl restart docker</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <p>之后直接使用标准命令，无需修改镜像名：</p>
          <div class="code-block">
            <pre>docker pull nginx:latest
docker pull ubuntu:22.04</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Push -->
  <div class="card">
    <h2>🔐 推送镜像</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>使用 Docker Hub 账号登录代理：</p>
          <div class="code-block">
            <pre>docker login ${host}</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <p>打 tag 并推送：</p>
          <div class="code-block">
            <pre>docker tag myimage:latest ${host}/username/myimage:latest
docker push ${host}/username/myimage:latest</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Route table -->
  <div class="card">
    <h2>📡 代理端点</h2>
    <table>
      <thead><tr><th>路径</th><th>目标</th><th>用途</th></tr></thead>
      <tbody>
        <tr><td><code>/token</code></td><td><code>auth.docker.io/token</code></td><td>OAuth 2 认证</td></tr>
        <tr><td><code>/v2/*</code></td><td><code>registry-1.docker.io/v2/*</code></td><td>Registry API（pull / push / tags）</td></tr>
      </tbody>
    </table>
  </div>

  <footer>Powered by <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Workers</a></footer>
</div>

<script>
function copyBlock(btn) {
  const pre = btn.closest('.code-block').querySelector('pre');
  navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
    const orig = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}
</script>
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
      return proxyRequest(request, `${REGISTRY}${pathname}${search}`, proxyOrigin);
    }

    return new Response("Not Found", { status: 404 });
  },
};
