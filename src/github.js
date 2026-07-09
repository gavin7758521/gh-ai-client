const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

export function tokenFromConfig(config) {
  return process.env.GITHUB_TOKEN || config.github?.token || "";
}

export async function validateToken(token) {
  const user = await githubRequest("/user", { token });
  return {
    login: user.login,
    id: user.id,
    html_url: user.html_url
  };
}

export async function listStarredRepos(token, { maxPages = 100 } = {}) {
  const repos = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const items = await githubRequest(`/user/starred?per_page=100&page=${page}&sort=created&direction=desc`, {
      token,
      accept: "application/vnd.github.star+json"
    });
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      const repo = item.repo || item;
      repos.push(normalizeRepo(repo, item.starred_at));
    }
    if (items.length < 100) break;
  }
  return repos;
}

export async function starRepo(token, fullName) {
  const { owner, repo } = splitRepo(fullName);
  await githubRequest(`/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token,
    method: "PUT",
    expectEmpty: true
  });
}

export async function unstarRepo(token, fullName) {
  const { owner, repo } = splitRepo(fullName);
  await githubRequest(`/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token,
    method: "DELETE",
    expectEmpty: true
  });
}

export function normalizeRepo(repo, starredAt) {
  return {
    id: repo.id,
    full_name: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login || repo.full_name?.split("/")[0] || "",
    description: repo.description || "",
    html_url: repo.html_url,
    language: repo.language || "",
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    stargazers_count: repo.stargazers_count || 0,
    forks_count: repo.forks_count || 0,
    archived: Boolean(repo.archived),
    fork: Boolean(repo.fork),
    private: Boolean(repo.private),
    pushed_at: repo.pushed_at || null,
    updated_at: repo.updated_at || null,
    starred_at: starredAt || null
  };
}

export function splitRepo(fullName) {
  const [owner, repo] = String(fullName).split("/");
  if (!owner || !repo) throw new Error(`Expected owner/repo, got "${fullName}".`);
  return { owner, repo };
}

export async function githubGraphql(token, query, variables = {}) {
  if (!token) throw new Error("GitHub token is required. Run: ghac auth set-token");
  const response = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-ai-client"
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok || payload?.errors?.length) {
    const detail = payload?.errors?.map((error) => error.message).join("; ") || payload?.message || text || response.statusText;
    throw new Error(`GitHub GraphQL failed (${response.status}): ${detail}`);
  }
  return payload.data;
}

export async function githubRequest(path, { token, method = "GET", accept = "application/vnd.github+json", expectEmpty = false } = {}) {
  if (!token) throw new Error("GitHub token is required. Run: ghac auth set-token");
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-ai-client"
    }
  });
  if (response.status === 204 && expectEmpty) return null;
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) {
    const detail = payload?.message || text || response.statusText;
    throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
