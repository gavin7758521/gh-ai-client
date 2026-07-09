import { readConfig, readJson, writeJson } from "./storage.js";
import { createPiCredentialStore } from "./pi-auth.js";
import { applyProxyConfig, proxyEnvFromConfig } from "./proxy.js";

export const MODEL_PRESETS = [
  { provider: "mock", model: "local-rules", note: "No external model; groups by language/topics." },
  { provider: "pi", model: "openai/gpt-4o-mini", note: "Uses @earendil-works/pi-ai built-in providers." },
  { provider: "codex", model: "auto", note: "Alias for the recommended OpenAI Codex model through pi." },
  { provider: "openai-compatible", model: "env", note: "Uses OPENAI_COMPATIBLE_* environment variables." }
];

export async function suggestCollections({ provider, model, limit = 200 } = {}) {
  const config = await readConfig();
  await applyProxyConfig(config);
  const selectedProvider = provider || config.ai?.provider || "";
  const selectedModel = model || (provider && provider !== config.ai?.provider ? defaultModelForProvider(provider) : config.ai?.model) || defaultModelForProvider(selectedProvider);
  const ai = {
    provider: selectedProvider,
    model: selectedModel
  };
  if (!ai.provider) throw new Error("No AI model configured. Run: ghac codex login, then ghac model use codex");
  const stars = await readJson("stars", { stars: [] });
  const collections = await readJson("collections", { collections: [] });
  const sample = stars.stars.slice(0, limit);
  const suggestions =
    ai.provider === "mock"
      ? mockSuggest(sample)
      : await modelSuggest(ai, sample, collections, config);
  const payload = {
    provider: ai.provider,
    model: ai.model,
    created_at: new Date().toISOString(),
    source_count: sample.length,
    ...suggestions
  };
  await writeJson("suggestions", payload);
  return payload;
}

export async function planGitHubActions({ prompt, limit = 120 } = {}) {
  const message = String(prompt || "").trim();
  if (!message) throw new Error("Prompt is required.");
  const config = await readConfig();
  await applyProxyConfig(config);
  const ai = {
    provider: config.ai?.provider || "",
    model: config.ai?.model || ""
  };
  if (!ai.provider || ai.provider === "mock") {
    throw new Error("No external AI model configured. Run: ghac codex login, then ghac model use codex");
  }
  const stars = await readJson("stars", { stars: [] });
  const lists = await readJson("lists", { lists: [] });
  const text = await completeText(ai, buildActionPlanMessages(message, stars.stars || [], lists.lists || [], limit), config, {
    systemPrompt: "You help manage GitHub starred repositories and GitHub Star Lists. Return only strict JSON."
  });
  const parsed = parseActionPlan(text);
  return {
    provider: ai.provider,
    model: ai.model,
    created_at: new Date().toISOString(),
    prompt: message,
    ...parsed
  };
}

function defaultModelForProvider(provider) {
  if (provider === "pi") return "openai/gpt-4o-mini";
  if (provider === "openai-compatible") return "env";
  return "local-rules";
}

function mockSuggest(stars) {
  const groups = new Map();
  for (const repo of stars) {
    const name = classifyRepo(repo);
    if (!groups.has(name)) {
      groups.set(name, {
        name,
        description: `Repositories related to ${name}.`,
        repos: []
      });
    }
    groups.get(name).repos.push(repo.full_name);
  }
  return {
    collections: [...groups.values()]
      .map((item) => ({ ...item, repos: item.repos.slice(0, 50).sort() }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

function classifyRepo(repo) {
  const text = [
    repo.full_name,
    repo.description,
    repo.language,
    ...(repo.topics || [])
  ].join(" ").toLowerCase();
  if (/\b(ai|llm|agent|openai|gpt|prompt|rag|embedding|model)\b/.test(text)) return "AI";
  if (/\b(react|vue|svelte|frontend|css|tailwind|ui)\b/.test(text)) return "Frontend";
  if (/\b(cli|terminal|shell|zsh|command)\b/.test(text)) return "CLI";
  if (/\b(database|postgres|sqlite|mysql|redis|sql)\b/.test(text)) return "Data";
  if (/\b(devops|kubernetes|docker|terraform|ci|actions)\b/.test(text)) return "DevOps";
  if (repo.language) return repo.language;
  return "Unsorted";
}

async function modelSuggest(ai, stars, collections, config) {
  if (ai.provider === "openai-compatible") {
    return openAiCompatibleSuggest(stars, collections);
  }
  if (ai.provider === "pi") {
    return piSuggest(ai, stars, collections, config);
  }
  throw new Error(`Unsupported AI provider "${ai.provider}". Run: ghac model list`);
}

async function openAiCompatibleSuggest(stars, collections) {
  const text = await openAiCompatibleComplete(buildMessages(stars, collections));
  return parseJsonContent(text);
}

async function openAiCompatibleComplete(messages) {
  const baseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL;
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const model = process.env.OPENAI_COMPATIBLE_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Set OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY, and OPENAI_COMPATIBLE_MODEL.");
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: buildMessages(stars, collections)
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "AI request failed.");
  return payload?.choices?.[0]?.message?.content || "";
}

async function piSuggest(ai, stars, collections, config) {
  const text = await piComplete(ai, buildMessages(stars, collections), config, {
    systemPrompt: "You organize GitHub starred repositories. Return only strict JSON with collections."
  });
  return parseJsonContent(text);
}

async function completeText(ai, messages, config, { systemPrompt = "You are a concise GitHub management assistant." } = {}) {
  if (ai.provider === "openai-compatible") return openAiCompatibleComplete(messages);
  if (ai.provider === "pi") return piComplete(ai, messages, config, { systemPrompt });
  throw new Error(`Unsupported AI provider "${ai.provider}". Run: ghac model list`);
}

async function piComplete(ai, messages, config, { systemPrompt }) {
  let pi;
  try {
    pi = await import("@earendil-works/pi-ai/providers/all");
  } catch {
    throw new Error("pi provider is not installed. Run npm install in the gh-ai-client project.");
  }
  const modelRef = process.env.GH_AI_CLIENT_PI_MODEL || ai.model || "openai/gpt-4o-mini";
  const [provider, ...modelParts] = modelRef.split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId) {
    throw new Error("pi model must be provider/model, for example: ghac model use pi:openai/gpt-4o-mini");
  }
  const models = pi.builtinModels({ credentials: createPiCredentialStore() });
  const model = models.getModel(provider, modelId);
  if (!model) {
    const examples = models.getModels(provider).slice(0, 8).map((item) => `${provider}/${item.id}`).join(", ");
    throw new Error(`pi model ${provider}/${modelId} was not found.${examples ? ` Examples: ${examples}` : ""}`);
  }
  const auth = await models.getAuth(model);
  if (!auth) {
    throw new Error(`pi model ${provider}/${modelId} is not configured. ${piAuthHint(provider)}`);
  }
  const proxyEnv = proxyEnvFromConfig(config);
  const options = {
    reasoning: "low",
    ...(Object.keys(proxyEnv).length ? { env: proxyEnv } : {})
  };
  const response = await models.completeSimple(model, {
    systemPrompt,
    messages: [{
      role: "user",
      content: messages.map((message) => message.content).join("\n\n"),
      timestamp: Date.now()
    }]
  }, options);
  const text = extractText(response);
  if (!text) {
    throw new Error(`pi model ${provider}/${modelId} returned no text. Try a different model or check provider credentials.`);
  }
  return text;
}

export async function listPiModels(provider = "") {
  const pi = await import("@earendil-works/pi-ai/providers/all");
  const models = pi.builtinModels();
  const providers = provider ? [provider] : models.getProviders().map((item) => item.id);
  return providers.flatMap((providerId) =>
    models.getModels(providerId).map((model) => ({
      provider: providerId,
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: Boolean(model.reasoning)
    }))
  );
}

export async function listCodexModels() {
  const subscriptionRows = await listPiModels("openai-codex");
  const apiRows = await listPiModels("openai");
  const openAiCodexRows = apiRows
    .filter((model) => model.id.toLowerCase().includes("codex"))
    .sort((left, right) => codexModelScore(right.id) - codexModelScore(left.id));
  return [...subscriptionRows, ...openAiCodexRows];
}

export async function recommendedCodexModel() {
  const models = await listCodexModels();
  const subscriptionCodex = models.find((model) => model.provider === "openai-codex" && model.id.toLowerCase().includes("codex"));
  const subscription = models.find((model) => model.provider === "openai-codex");
  const exactCodex = models.find((model) => model.provider === "openai" && /^gpt-\d+(?:\.\d+)?-codex$/i.test(model.id));
  const selected = subscriptionCodex || subscription || exactCodex || models[0];
  if (!selected) throw new Error("No Codex model was found in pi's OpenAI model list.");
  return selected;
}

function extractText(message) {
  return (message.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function codexModelScore(id) {
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?-codex(?:-(.+))?$/i);
  if (!match) return 0;
  const major = Number(match[1] || 0);
  const minor = Number(match[2] || 0);
  const suffix = match[3] || "";
  const variantScore = suffix === "" ? 100 : suffix === "max" ? 80 : suffix === "spark" ? 70 : suffix === "mini" ? 50 : 10;
  return major * 10000 + minor * 100 + variantScore;
}

function piAuthHint(provider) {
  if (provider === "openai-codex") return "Run: ghac codex login.";
  if (provider === "openai") return "Set OPENAI_API_KEY in this shell.";
  if (provider === "anthropic") return "Set ANTHROPIC_API_KEY in this shell.";
  if (provider === "google") return "Set GEMINI_API_KEY or GOOGLE_API_KEY in this shell.";
  return "Set the provider API key environment variable.";
}

function buildMessages(stars, collections) {
  return [
    {
      role: "system",
      content: "You organize GitHub starred repositories. Return only strict JSON with {\"collections\":[{\"name\":\"...\",\"description\":\"...\",\"repos\":[\"owner/repo\"]}]}. Do not include repositories not present in input."
    },
    {
      role: "user",
      content: JSON.stringify({ stars, existingCollections: collections.collections }, null, 2)
    }
  ];
}

function buildActionPlanMessages(prompt, stars, lists, limit) {
  const repoSample = stars.slice(0, limit).map((repo) => ({
    full_name: repo.full_name,
    description: repo.description,
    language: repo.language,
    topics: repo.topics,
    stargazers_count: repo.stargazers_count,
    archived: repo.archived,
    fork: repo.fork,
    starred_at: repo.starred_at
  }));
  const listSample = lists.map((list) => ({
    name: list.name,
    slug: list.slug,
    description: list.description,
    private: list.private,
    repos: (list.repos || []).map((repo) => repo.full_name)
  }));
  return [
    {
      role: "system",
      content: [
        "Return only strict JSON with this shape:",
        "{\"reply\":\"short Chinese response\",\"actions\":[{\"type\":\"sync_stars\"},{\"type\":\"sync_lists\"},{\"type\":\"create_list\",\"name\":\"...\",\"description\":\"...\",\"private\":false},{\"type\":\"add_repo_to_list\",\"repo\":\"owner/repo\",\"list\":\"...\",\"create\":true},{\"type\":\"remove_repo_from_list\",\"repo\":\"owner/repo\",\"list\":\"...\"}]}",
        "Use actions only when the user is asking to organize or change GitHub Star Lists.",
        "Do not invent repository names. Use repos from context unless the user explicitly writes an owner/repo.",
        "For unclear requests, return no actions and ask a concise clarification in reply."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({ request: prompt, stars: repoSample, lists: listSample }, null, 2)
    }
  ];
}

function parseJsonContent(content) {
  const clean = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed.collections)) throw new Error("AI JSON must include collections array.");
  return parsed;
}

function parseActionPlan(content) {
  const clean = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(clean);
  const actions = Array.isArray(parsed.actions) ? parsed.actions.map(normalizeAction).filter(Boolean) : [];
  return {
    reply: String(parsed.reply || "").trim(),
    actions
  };
}

function normalizeAction(action) {
  const type = String(action?.type || "").trim();
  if (type === "sync_stars" || type === "sync_lists") return { type };
  if (type === "create_list") {
    const name = String(action.name || "").trim();
    if (!name) return null;
    return {
      type,
      name,
      description: String(action.description || ""),
      private: Boolean(action.private)
    };
  }
  if (type === "add_repo_to_list" || type === "remove_repo_from_list") {
    const repo = String(action.repo || "").trim();
    const list = String(action.list || "").trim();
    if (!repo || !list) return null;
    return {
      type,
      repo,
      list,
      create: Boolean(action.create)
    };
  }
  return null;
}
