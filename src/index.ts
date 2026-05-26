/**
 * Multi-Registry Docker Proxy Worker
 *
 * Registry routing via subdirectory prefix:
 *   /docker.io/<name>/...      → registry-1.docker.io  (default, backward compat)
 *   /ghcr.io/<name>/...        → ghcr.io
 *   /quay.io/<name>/...        → quay.io
 *   /gcr.io/<name>/...         → gcr.io
 *   /registry.k8s.io/<name>/...→ registry.k8s.io
 *   /mcr.microsoft.com/<name>/ → mcr.microsoft.com
 *   /docker.elastic.co/<name>/ → docker.elastic.co
 *   /nvcr.io/<name>/...        → nvcr.io
 *
 * API endpoints:
 *   /<prefix>/token            → upstream auth token endpoint
 *   /token                     → Docker Hub auth (backward compat)
 *   /v2/<prefix>/<name>/...    → upstream registry API
 *   /v2/<name>/...             → Docker Hub registry API (backward compat)
 *
 * Key behaviours:
 *   - WWW-Authenticate realm is rewritten to point to this proxy's token endpoint
 *   - Registry prefix is stripped from token scope before forwarding to upstream auth
 *   - Location headers from blob upload redirects are rewritten to stay on-proxy
 *   - Hop-by-hop headers are stripped to avoid HTTP/2 protocol errors
 */

interface RegistryConfig {
  registry: string;
  auth: string;
  authPath: string;
}

const REGISTRY_CONFIG: Record<string, RegistryConfig> = {
  "docker.io": {
    registry: "https://registry-1.docker.io",
    auth: "https://auth.docker.io",
    authPath: "/token",
  },
  "ghcr.io": {
    registry: "https://ghcr.io",
    auth: "https://ghcr.io",
    authPath: "/token",
  },
  "quay.io": {
    registry: "https://quay.io",
    auth: "https://quay.io",
    authPath: "/v2/auth",
  },
  "gcr.io": {
    registry: "https://gcr.io",
    auth: "https://gcr.io",
    authPath: "/v2/token",
  },
  "registry.k8s.io": {
    registry: "https://registry.k8s.io",
    auth: "https://registry.k8s.io",
    authPath: "/v2/token",
  },
  "mcr.microsoft.com": {
    registry: "https://mcr.microsoft.com",
    auth: "https://mcr.microsoft.com",
    authPath: "/v2/token",
  },
  "docker.elastic.co": {
    registry: "https://docker.elastic.co",
    auth: "https://docker.elastic.co",
    authPath: "/v2/token",
  },
  "nvcr.io": {
    registry: "https://nvcr.io",
    auth: "https://authn.nvidia.com",
    authPath: "/token",
  },
};

const DEFAULT_REGISTRY = "docker.io";

/**
 * Extract a known registry prefix from the beginning of an image path.
 * Returns [prefix, remainingPath] or [DEFAULT_REGISTRY, originalPath] if no prefix found.
 */
function extractRegistryPrefix(imagePath: string): [string, string] {
  for (const prefix of Object.keys(REGISTRY_CONFIG)) {
    if (imagePath === prefix || imagePath.startsWith(prefix + "/")) {
      const remaining = imagePath.slice(prefix.length).replace(/^\//, "");
      return [prefix, remaining];
    }
  }
  return [DEFAULT_REGISTRY, imagePath];
}

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
 * client fetches tokens from our proxy instead of the upstream auth server.
 *
 * Original: Bearer realm="https://auth.docker.io/token",service="registry.docker.io"
 * Rewritten: Bearer realm="https://dh.lihongjie.cn/docker.io/token",service="registry.docker.io"
 */
function rewriteWWWAuthenticate(header: string, proxyOrigin: string, registryPrefix: string): string {
  return header.replace(
    /realm="https?:\/\/[^"]+"/,
    `realm="${proxyOrigin}/${registryPrefix}/token"`,
  );
}

/**
 * Rewrite Location headers produced by blob upload redirects.
 * Replaces any upstream registry/auth origin with the proxy origin.
 */
function rewriteLocation(location: string, proxyOrigin: string, cfg: RegistryConfig): string {
  for (const base of [cfg.registry, cfg.auth]) {
    if (location.startsWith(base + "/") || location === base) {
      return proxyOrigin + location.slice(base.length);
    }
  }
  return location;
}

/**
 * Strip the registry prefix from a token scope parameter.
 * e.g. scope=repository:ghcr.io/astral-sh/uv:pull → scope=repository:astral-sh/uv:pull
 */
function stripScopePrefix(scope: string, registryPrefix: string): string {
  const escaped = registryPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scope.replace(
    new RegExp(`(repository:)${escaped}\\/`, "g"),
    "$1",
  );
}

async function proxyRequest(
  request: Request,
  targetUrl: string,
  proxyOrigin: string,
  registryPrefix: string,
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

  const cfg = REGISTRY_CONFIG[registryPrefix]!;
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
    respHeaders.set("www-authenticate", rewriteWWWAuthenticate(wwwAuth, proxyOrigin, registryPrefix));
  }

  const location = upstream.headers.get("location");
  if (location) {
    respHeaders.set("location", rewriteLocation(location, proxyOrigin, cfg));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

function landingPage(origin: string): Response {
  const host = origin.replace(/^https?:\/\//, '');
  const registryRows = [
    ["Docker Hub 官方镜像", `${host}/docker.io/library/nginx:latest`],
    ["Docker Hub 用户镜像", `${host}/docker.io/username/image:tag`],
    ["GHCR", `${host}/ghcr.io/astral-sh/uv:latest`],
    ["Quay", `${host}/quay.io/prometheus/node-exporter:latest`],
    ["GCR", `${host}/gcr.io/distroless/static-debian13`],
    ["Kubernetes Registry", `${host}/registry.k8s.io/pause:latest`],
    ["MCR", `${host}/mcr.microsoft.com/playwright/mcp:latest`],
    ["Elastic", `${host}/docker.elastic.co/elasticsearch/elasticsearch:9.4.1`],
    ["NVIDIA", `${host}/nvcr.io/nvidia/k8s/dcgm-exporter:4.5.3-4.8.2-distroless`],
  ].map(([src, ref]) => `<tr><td>${src}</td><td><code>${ref}</code></td></tr>`).join("\n        ");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Docker 镜像代理</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --card: #21262d; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #e3b341; --radius: 8px;
  }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; padding: 2rem 1rem; }
  .container { max-width: 860px; margin: 0 auto; }
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

  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: .5rem .75rem; border-bottom: 1px solid var(--border); }
  td { padding: .55rem .75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  code { background: rgba(110,118,129,.15); border-radius: 4px; padding: .15em .45em; font-family: "SFMono-Regular", Consolas, monospace; font-size: .85em; word-break: break-all; }

  footer { text-align: center; color: var(--muted); font-size: .8rem; padding: 2rem 0 1rem; }
  footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🐋 Docker 镜像代理</h1>
    <p>基于 Cloudflare Workers &nbsp;·&nbsp; 支持多仓库 · pull / push · 认证 · Registry API</p>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap;justify-content:center;margin-top:.75rem;font-size:.85rem;">
      <span style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:.3rem .75rem;">🌐 国际线路：<code>dh.lihongjie.cn</code></span>
      <span style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:.3rem .75rem;">🇨🇳 国内优选：<code>dh.cn.lihongjie.cn</code></span>
    </div>
  </header>

  <!-- Supported Registries -->
  <div class="card">
    <h2>📦 支持的镜像仓库</h2>
    <table>
      <thead><tr><th>来源</th><th>镜像引用示例</th></tr></thead>
      <tbody>
        ${registryRows}
      </tbody>
    </table>
  </div>

  <!-- Quick Pull -->
  <div class="card">
    <h2>🚀 快速拉取</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <p>在镜像名前加上代理域名和仓库前缀（默认 docker.io）：</p>
          <div class="code-block">
            <pre>docker pull ${host}/docker.io/library/nginx:latest
docker pull ${host}/ghcr.io/astral-sh/uv:latest
docker pull ${host}/quay.io/prometheus/node-exporter:latest
docker pull ${host}/registry.k8s.io/pause:latest</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- daemon.json (Docker Hub only) -->
  <div class="card">
    <h2>⚙️ 配置为 Docker Hub 默认镜像源</h2>
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
    <h2>🔐 推送镜像（Docker Hub）</h2>
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
            <pre>docker tag myimage:latest ${host}/docker.io/username/myimage:latest
docker push ${host}/docker.io/username/myimage:latest</pre>
            <button class="btn sm ghost" onclick="copyBlock(this)">复制</button>
          </div>
        </div>
      </div>
    </div>
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

    // /<prefix>/token — registry-specific auth token proxy
    // e.g. /docker.io/token, /ghcr.io/token, /registry.k8s.io/token
    for (const prefix of Object.keys(REGISTRY_CONFIG)) {
      const tokenPath = `/${prefix}/token`;
      if (pathname === tokenPath) {
        const cfg = REGISTRY_CONFIG[prefix]!;
        // Strip the registry prefix from scope params so the upstream auth
        // server receives scopes in its own namespace.
        // e.g. scope=repository:ghcr.io/astral-sh/uv:pull → scope=repository:astral-sh/uv:pull
        const params = new URLSearchParams(search.slice(1));
        const rawScope = params.get("scope");
        if (rawScope) {
          params.set("scope", stripScopePrefix(rawScope, prefix));
        }
        const tokenSearch = params.toString() ? "?" + params.toString() : "";
        return proxyRequest(request, `${cfg.auth}${cfg.authPath}${tokenSearch}`, proxyOrigin, prefix);
      }
    }

    // /token — Docker Hub auth backward compat
    if (pathname === "/token") {
      const cfg = REGISTRY_CONFIG[DEFAULT_REGISTRY]!;
      return proxyRequest(request, `${cfg.auth}${cfg.authPath}${search}`, proxyOrigin, DEFAULT_REGISTRY);
    }

    // Registry API — /v2/* paths
    if (pathname.startsWith("/v2/") || pathname === "/v2") {
      const afterV2 = pathname.slice(4); // strip leading /v2/

      // Bare /v2/ version check: return 200 directly.
      // Proxying to a specific upstream would cause Docker to obtain an upstream-
      // specific token preemptively for this host. That token would then be sent
      // (wrongly) when Docker pulls images from a different registry via the same
      // proxy, resulting in "invalid token" errors from the actual upstream.
      if (!afterV2) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Extract potential registry prefix from the path segment after /v2/
      // e.g. /v2/ghcr.io/astral-sh/uv/manifests/latest → prefix=ghcr.io, rest=astral-sh/uv/manifests/latest
      const [registryPrefix, remainingPath] = extractRegistryPrefix(afterV2);
      const cfg = REGISTRY_CONFIG[registryPrefix]!;
      const upstreamPath = remainingPath ? `/v2/${remainingPath}` : "/v2";
      return proxyRequest(request, `${cfg.registry}${upstreamPath}${search}`, proxyOrigin, registryPrefix);
    }

    return new Response("Not Found", { status: 404 });
  },
};
