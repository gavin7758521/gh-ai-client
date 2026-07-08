const PROXY_PROTOCOLS = new Set(["http:", "https:"]);

let appliedGlobalProxyUrl = "";

export function normalizeProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withProtocol = raw.includes("://") ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch (error) {
    throw new Error(`Invalid proxy URL: ${error.message}`);
  }
  if (!PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Unsupported proxy protocol "${url.protocol}". Use an HTTP or HTTPS proxy URL.`);
  }
  return url.toString();
}

export function normalizeProxyConfig(proxy = {}) {
  const next = {};
  if (proxy.http) next.http = normalizeProxyUrl(proxy.http);
  if (proxy.https) next.https = normalizeProxyUrl(proxy.https);
  if (proxy.all) next.all = normalizeProxyUrl(proxy.all);
  if (proxy.noProxy || proxy.no_proxy) {
    next.noProxy = String(proxy.noProxy || proxy.no_proxy).trim();
  }
  return next;
}

export function proxyEnvFromConfig(config = {}) {
  const proxy = normalizeProxyConfig(config.proxy || {});
  const env = {};
  if (proxy.http) {
    env.HTTP_PROXY = proxy.http;
    env.http_proxy = proxy.http;
  }
  if (proxy.https) {
    env.HTTPS_PROXY = proxy.https;
    env.https_proxy = proxy.https;
  }
  if (proxy.all) {
    env.ALL_PROXY = proxy.all;
    env.all_proxy = proxy.all;
  }
  if (proxy.noProxy) {
    env.NO_PROXY = proxy.noProxy;
    env.no_proxy = proxy.noProxy;
  }
  return env;
}

export async function applyProxyConfig(config = {}) {
  const env = proxyEnvFromConfig(config);
  if (Object.keys(env).length === 0) return env;
  Object.assign(process.env, env);
  const proxyUrl = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || "";
  if (proxyUrl && proxyUrl !== appliedGlobalProxyUrl) {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    appliedGlobalProxyUrl = proxyUrl;
  }
  return env;
}

export function redactProxyUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(normalizeProxyUrl(value));
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<invalid proxy URL>";
  }
}

export function proxyStatusLines(config = {}) {
  const proxy = normalizeProxyConfig(config.proxy || {});
  if (!Object.keys(proxy).length) return ["Proxy: not configured"];
  const lines = ["Proxy: configured"];
  if (proxy.http) lines.push(`HTTP_PROXY=${redactProxyUrl(proxy.http)}`);
  if (proxy.https) lines.push(`HTTPS_PROXY=${redactProxyUrl(proxy.https)}`);
  if (proxy.all) lines.push(`ALL_PROXY=${redactProxyUrl(proxy.all)}`);
  if (proxy.noProxy) lines.push(`NO_PROXY=${proxy.noProxy}`);
  return lines;
}
