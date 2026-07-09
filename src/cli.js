import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { applySuggestions, readCollections, writeCollections, addRepoToCollection, removeRepoFromCollection, ensureCollection } from "./collections.js";
import { listStarredRepos, starRepo, tokenFromConfig, unstarRepo, validateToken } from "./github.js";
import { MODEL_PRESETS, listCodexModels, listPiModels, planGitHubActions, recommendedCodexModel, suggestCollections } from "./ai.js";
import { CODEX_PROVIDER_ID, createPiCredentialStore, readPiCredential } from "./pi-auth.js";
import { applyProxyConfig, normalizeProxyConfig, proxyStatusLines } from "./proxy.js";
import { addRepoToGitHubList, createGitHubList, removeRepoFromGitHubList, syncGitHubLists } from "./star-lists.js";
import { DATA_DIR, appendHistory, dataPath, readConfig, readJson, removeData, writeConfig, writeJson } from "./storage.js";

export async function main(argv) {
  const args = argv.slice(2);
  const [group, command, ...rest] = args;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    printHelp(command);
    return;
  }
  if (group === "auth") return authCommand(command, rest);
  if (group === "proxy") return proxyCommand(command, rest);
  if (group === "model") return modelCommand(command, rest);
  if (group === "codex") return codexCommand(command, rest);
  if (group === "stars") return starsCommand(command, rest);
  if (group === "lists") return listsCommand(command, rest);
  if (group === "collections") return collectionsCommand(command, rest);
  if (group === "ai") return aiCommand(command, rest);
  if (group === "data") return dataCommand(command, rest);
  throw new Error(`Unknown command "${group}". Run: ghac help`);
}

function printHelp(topic = "") {
  const sections = {
    auth: "auth set-token | auth status | auth clear-token",
    proxy: "proxy set <url> | proxy set --http <url> [--https <url>] [--all <url>] [--no-proxy list] | proxy status | proxy clear",
    codex: "codex login | codex status | codex logout",
    model: "model list [pi [provider]|codex|local|--all] | model use <provider[:model]|codex> | model current | model test",
    stars: "stars sync [--max-pages N] | stars list [--limit N] | stars search <keyword> | stars star <owner/repo> | stars unstar <owner/repo>",
    lists: "lists sync | lists list | lists show <name> | lists create <name> [--description text] [--private] | lists add <name> <owner/repo> [--create] | lists remove <name> <owner/repo>",
    collections: "collections list | collections show <name> | collections create <name> | collections add <name> <owner/repo> | collections remove <name> <owner/repo> | collections export [file] | collections import <file> [--replace]",
    ai: "ai | ai plan <prompt> | ai apply-plan | ai suggest [--provider pi|openai-compatible] [--model name] [--limit N] | ai status | ai step [--apply] | ai skip | ai review | ai apply | ai clear",
    data: "data path | data doctor"
  };
  if (topic && sections[topic]) {
    console.log(`Usage: ghac ${sections[topic]}`);
    return;
  }
  console.log(`ghac

Usage:
  ghac help [auth|proxy|codex|model|stars|lists|collections|ai|data]
  ghac auth set-token
  ghac proxy set http://127.0.0.1:7890
  ghac codex login
  ghac model use <provider[:model]|codex>
  ghac stars sync
  ghac lists sync
  ghac ai

Commands:
  ${sections.auth}
  ${sections.proxy}
  ${sections.codex}
  ${sections.model}
  ${sections.stars}
  ${sections.lists}
  ${sections.collections}
  ${sections.ai}
  ${sections.data}

Data:
  ${DATA_DIR}`);
}

async function authCommand(command, args) {
  const config = await readConfig();
  await applyProxyConfig(config);
  if (command === "set-token") {
    const token = args[0] || await promptSecret("GitHub token: ");
    const user = await validateToken(token);
    config.github = { token, user };
    await writeConfig(config);
    console.log(`Saved GitHub token for @${user.login}.`);
    return;
  }
  if (command === "status") {
    const token = tokenFromConfig(config);
    if (!token) {
      console.log("No GitHub token configured.");
      return;
    }
    const user = await validateToken(token);
    console.log(`GitHub token works for @${user.login}.`);
    return;
  }
  if (command === "clear-token") {
    config.github = {};
    await writeConfig(config);
    console.log("Cleared GitHub token from config.");
    return;
  }
  printHelp("auth");
}

async function proxyCommand(command, args) {
  const config = await readConfig();
  if (command === "set") {
    config.proxy = parseProxyArgs(args);
    await writeConfig(config);
    console.log("Saved proxy configuration.");
    for (const line of proxyStatusLines(config).slice(1)) console.log(line);
    return;
  }
  if (command === "status") {
    for (const line of proxyStatusLines(config)) console.log(line);
    return;
  }
  if (command === "clear") {
    delete config.proxy;
    await writeConfig(config);
    console.log("Cleared proxy configuration.");
    return;
  }
  printHelp("proxy");
}

async function codexCommand(command) {
  const config = await readConfig();
  await applyProxyConfig(config);
  if (command === "login") {
    const store = createPiCredentialStore();
    const models = await createPiModelsWithStore(store);
    const provider = models.getProvider(CODEX_PROVIDER_ID);
    if (!provider?.auth?.oauth) throw new Error("pi provider openai-codex does not support OAuth login.");
    const rl = createInterface({ input, output });
    try {
      const credential = await provider.auth.oauth.login({
        prompt: (prompt) => authLoginPrompt(rl, prompt),
        notify: notifyAuthEvent
      });
      await store.modify(CODEX_PROVIDER_ID, async () => credential);
      const model = await recommendedCodexModel();
      config.ai = { provider: "pi", model: `${model.provider}/${model.id}` };
      await writeConfig(config);
      console.log(`Saved Codex login and selected ${config.ai.model}.`);
    } finally {
      rl.close();
    }
    return;
  }
  if (command === "status") {
    const credential = await readPiCredential(CODEX_PROVIDER_ID);
    if (!credential) {
      console.log("Codex login is not configured. Run: ghac codex login");
      console.log(`Current model: ${modelLabel(config)}`);
      return;
    }
    const models = await createPiModelsWithStore(createPiCredentialStore());
    const selected = await recommendedCodexModel();
    const model = models.getModel(selected.provider, selected.id);
    const auth = model ? await models.getAuth(model) : null;
    console.log(`Codex login: ${auth ? `configured via ${auth.source || "OAuth"}` : "stored but not usable"}`);
    console.log(`Current model: ${modelLabel(config)}`);
    return;
  }
  if (command === "logout") {
    await createPiCredentialStore().delete(CODEX_PROVIDER_ID);
    console.log("Cleared Codex login.");
    return;
  }
  printHelp("codex");
}

async function modelCommand(command, args) {
  const config = await readConfig();
  if (command === "list") {
    if (args[0] === "local") {
      for (const item of MODEL_PRESETS.filter((preset) => preset.provider === "mock")) {
        console.log(`${item.provider}:${item.model} - ${item.note}`);
      }
      return;
    }
    if (args[0] === "codex") {
      const rows = await listCodexModels();
      for (const row of rows.slice(0, Number(readOption(args, "--limit") || 30))) {
        console.log(`pi:${row.provider}/${row.id} - ${row.name || row.id}${row.reasoning ? " / reasoning" : ""}`);
      }
      if (rows.length === 0) console.log("No Codex models found in pi.");
      return;
    }
    if (args[0] === "pi") {
      const rows = await listPiModels(args[1] || "");
      for (const row of rows.slice(0, Number(readOption(args, "--limit") || 80))) {
        console.log(`pi:${row.provider}/${row.id} - ${row.name || row.id}${row.reasoning ? " / reasoning" : ""}`);
      }
      if (rows.length === 0) console.log("No pi models found.");
      return;
    }
    const rows = args.includes("--all") ? MODEL_PRESETS : MODEL_PRESETS.filter((preset) => preset.provider !== "mock");
    for (const item of rows) {
      console.log(`${item.provider}:${item.model} - ${item.note}`);
    }
    return;
  }
  if (command === "use") {
    const value = args[0];
    if (!value) throw new Error("Usage: ghac model use <provider[:model]|codex>");
    if (isCodexAlias(value)) {
      const model = await recommendedCodexModel();
      config.ai = { provider: "pi", model: `${model.provider}/${model.id}` };
      await writeConfig(config);
      console.log(`Using Codex model through pi: ${config.ai.model}.`);
      if (model.provider === CODEX_PROVIDER_ID && !await readPiCredential(CODEX_PROVIDER_ID)) {
        console.log("Codex login is not configured. Run: ghac codex login");
      } else if (model.provider === "openai" && !process.env.OPENAI_API_KEY) {
        console.log("OpenAI auth is not configured in this shell. Set OPENAI_API_KEY before running: ghac ai suggest");
      }
      return;
    }
    const [provider, model = defaultModelForProvider(provider)] = value.split(":");
    config.ai = { provider, model };
    await writeConfig(config);
    console.log(`Using model provider ${provider}:${model}.`);
    return;
  }
  if (command === "current") {
    console.log(modelLabel(config));
    return;
  }
  if (command === "test") {
    const result = await suggestCollections({ limit: 5 });
    console.log(`AI provider returned ${result.collections?.length || 0} collection suggestions.`);
    return;
  }
  printHelp("model");
}

async function starsCommand(command, args) {
  const config = await readConfig();
  await applyProxyConfig(config);
  const token = tokenFromConfig(config);
  if (command === "sync") {
    const maxPages = Number(readOption(args, "--max-pages") || 100);
    const stars = await listStarredRepos(token, { maxPages });
    await writeJson("stars", { synced_at: new Date().toISOString(), stars });
    console.log(`Synced ${stars.length} starred repositories.`);
    return;
  }
  if (command === "list") {
    const limit = Number(readOption(args, "--limit") || 50);
    const state = await readJson("stars", { stars: [] });
    printRepos(state.stars.slice(0, limit));
    return;
  }
  if (command === "search") {
    const keyword = args.join(" ").trim().toLowerCase();
    if (!keyword) throw new Error("Usage: ghac stars search <keyword>");
    const state = await readJson("stars", { stars: [] });
    printRepos(state.stars.filter((repo) => repoMatches(repo, keyword)).slice(0, 100));
    return;
  }
  if (command === "star") {
    await starRepo(token, args[0]);
    console.log(`Starred ${args[0]}.`);
    return;
  }
  if (command === "unstar") {
    await unstarRepo(token, args[0]);
    console.log(`Unstarred ${args[0]}.`);
    return;
  }
  printHelp("stars");
}

async function listsCommand(command, args) {
  const config = await readConfig();
  await applyProxyConfig(config);
  const token = tokenFromConfig(config);
  if (command === "sync") {
    const state = await syncGitHubLists(token);
    await writeJson("lists", state);
    console.log(`Synced ${state.lists.length} GitHub Star Lists.`);
    return;
  }
  if (command === "list") {
    const state = args.includes("--local") ? await readJson("lists", { lists: [] }) : await syncAndCacheLists(token);
    if (!state.lists.length) {
      console.log("No GitHub Star Lists.");
      return;
    }
    for (const list of state.lists) {
      const visibility = list.private ? "private" : "public";
      console.log(`${list.name} (${list.repos?.length || 0}, ${visibility})${list.description ? ` - ${list.description}` : ""}`);
    }
    return;
  }
  if (command === "show") {
    const name = positionalArgs(args).join(" ");
    const state = await syncAndCacheLists(token);
    const list = findLocalList(state, name);
    console.log(`${list.name}: ${list.description || ""}`);
    for (const repo of list.repos || []) {
      console.log(`  ${repo.full_name}${repo.language ? ` - ${repo.language}` : ""}`);
      if (repo.description) console.log(`    ${repo.description}`);
    }
    return;
  }
  if (command === "create") {
    const name = positionalArgs(args, ["--description"], ["--private"]).join(" ");
    const description = readOption(args, "--description");
    const list = await createGitHubList(token, {
      name,
      description,
      isPrivate: args.includes("--private")
    });
    await syncAndCacheLists(token);
    console.log(`Created GitHub Star List ${list.name}.`);
    return;
  }
  if (command === "add") {
    const { name, repo } = listRepoArgs(args, ["--create", "--no-star"]);
    const result = await addRepoToGitHubList(token, name, repo, {
      create: args.includes("--create"),
      star: !args.includes("--no-star")
    });
    await syncAndCacheLists(token);
    console.log(`${result.changed ? "Added" : "Already in list"}: ${result.repo} -> ${result.list.name}.`);
    return;
  }
  if (command === "remove") {
    const { name, repo } = listRepoArgs(args);
    const result = await removeRepoFromGitHubList(token, name, repo);
    await syncAndCacheLists(token);
    console.log(`${result.changed ? "Removed" : "Not in list"}: ${result.repo} -> ${result.list.name}.`);
    return;
  }
  printHelp("lists");
}

async function collectionsCommand(command, args) {
  const state = await readCollections();
  if (command === "list") {
    if (state.collections.length === 0) {
      console.log("No local collections yet.");
      return;
    }
    for (const collection of state.collections) {
      console.log(`${collection.name} (${collection.repos.length}) ${collection.description || ""}`);
    }
    return;
  }
  if (command === "show") {
    const name = args.join(" ");
    const collection = findCollection(state, name);
    console.log(`${collection.name}: ${collection.description || ""}`);
    for (const repo of collection.repos) console.log(`  ${repo}`);
    return;
  }
  if (command === "create") {
    const name = args.join(" ");
    ensureCollection(state, name);
    await writeCollections(state);
    console.log(`Created collection ${name}.`);
    return;
  }
  if (command === "add") {
    const { name, repo } = collectionRepoArgs(args);
    addRepoToCollection(state, name, repo);
    await writeCollections(state);
    console.log(`Added ${repo} to ${name}.`);
    return;
  }
  if (command === "remove") {
    const { name, repo } = collectionRepoArgs(args);
    removeRepoFromCollection(state, name, repo);
    await writeCollections(state);
    console.log(`Removed ${repo} from ${name}.`);
    return;
  }
  if (command === "export") {
    const payload = JSON.stringify(state, null, 2);
    const file = args[0];
    if (!file) {
      console.log(payload);
      return;
    }
    await writeFile(file, `${payload}\n`, "utf8");
    console.log(`Exported ${state.collections.length} collections to ${file}.`);
    return;
  }
  if (command === "import") {
    const file = args[0];
    if (!file) throw new Error("Usage: ghac collections import <file> [--replace]");
    const incoming = normalizeCollectionState(JSON.parse(await readFile(file, "utf8")));
    const next = args.includes("--replace") ? incoming : mergeCollectionStates(state, incoming);
    await writeCollections(next);
    await appendHistory({ action: "collections.import", file, mode: args.includes("--replace") ? "replace" : "merge" });
    console.log(`Imported ${incoming.collections.length} collections from ${file}.`);
    return;
  }
  printHelp("collections");
}

async function aiCommand(command, args) {
  if (!command) {
    await startAiRepl();
    return;
  }
  if (command === "plan") {
    const prompt = args.join(" ").trim();
    if (!prompt) throw new Error("Usage: ghac ai plan <prompt>");
    const plan = await createAndStorePlan(prompt);
    printPlan(plan);
    return;
  }
  if (command === "apply-plan") {
    const plan = await readJson("plan", { actions: [] });
    const applied = await applyGitHubPlan(plan);
    await removeData("plan");
    console.log(`Applied ${applied.length} plan actions.`);
    return;
  }
  if (command === "suggest") {
    const provider = readOption(args, "--provider");
    const model = readOption(args, "--model");
    const limit = Number(readOption(args, "--limit") || 200);
    const result = await suggestCollections({ provider, model, limit });
    console.log(`Wrote ${result.collections?.length || 0} collection suggestions to suggestions.json.`);
    for (const collection of result.collections || []) {
      console.log(`${collection.name} (${collection.repos.length})`);
    }
    return;
  }
  if (command === "status") {
    const suggestions = await readJson("suggestions", { collections: [] });
    const state = await readCollections();
    const total = countSuggestedAssignments(suggestions);
    const remaining = countUnappliedSuggestions(suggestions, state);
    console.log(`${remaining}/${total} suggested repo assignments remaining.`);
    return;
  }
  if (command === "apply") {
    const suggestions = await readJson("suggestions", { collections: [] });
    const state = await readCollections();
    const applied = applySuggestions(state, suggestions);
    await writeCollections(state);
    await writeJson("suggestions", { ...suggestions, collections: [] });
    await appendHistory({ action: "ai.apply", count: applied.length });
    console.log(`Applied ${applied.length} repo assignments.`);
    return;
  }
  if (command === "step") {
    const suggestions = await readJson("suggestions", { collections: [] });
    const state = await readCollections();
    const action = firstSuggestedAction(suggestions, state);
    if (!action) {
      console.log("No unapplied suggestion action available. Run: ghac ai suggest");
      return;
    }
    console.log(JSON.stringify(action, null, 2));
    if (args.includes("--apply")) {
      await applySuggestedAction(state, suggestions, action, "ai.step.apply");
      console.log(`Applied: ${action.repo} -> ${action.collection}`);
    }
    return;
  }
  if (command === "skip") {
    const suggestions = await readJson("suggestions", { collections: [] });
    const state = await readCollections();
    const action = firstSuggestedAction(suggestions, state);
    if (!action) {
      console.log("No unapplied suggestion action available. Run: ghac ai suggest");
      return;
    }
    removeSuggestedAssignment(suggestions, action);
    await writeJson("suggestions", suggestions);
    await appendHistory({ action: "ai.step.skip", repo: action.repo, collection: action.collection });
    console.log(`Skipped: ${action.repo} -> ${action.collection}`);
    return;
  }
  if (command === "review") {
    await reviewSuggestions();
    return;
  }
  if (command === "clear") {
    await removeData("suggestions");
    console.log("Cleared suggestions.");
    return;
  }
  printHelp("ai");
}

async function startAiRepl() {
  const rl = createInterface({ input, output });
  console.log("ghac ai interactive shell. Type /help for commands, /exit to quit.");
  try {
    while (true) {
      const answer = await readReplAnswer(rl, "ghac-ai> ");
      if (answer === null) return;
      const line = answer.trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const shouldExit = await runAiReplCommand(rl, line.slice(1));
        if (shouldExit) return;
        continue;
      }
      await handleNaturalAiInput(rl, line);
    }
  } finally {
    rl.close();
  }
}

async function readReplAnswer(rl, prompt) {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if (error?.code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(error?.message || "")) return null;
    throw error;
  }
}

async function runAiReplCommand(rl, line) {
  const args = parseCommandLine(line);
  const [command, subcommand, ...rest] = args;
  if (!command || command === "help") {
    printAiReplHelp();
    return false;
  }
  if (["exit", "quit", "q"].includes(command)) return true;
  if (command === "auth") {
    await authCommand(subcommand, rest);
    return false;
  }
  if (command === "proxy") {
    await proxyCommand(subcommand, rest);
    return false;
  }
  if (command === "codex") {
    await codexCommand(subcommand, rest);
    return false;
  }
  if (command === "model") {
    await modelCommand(subcommand || "current", rest);
    return false;
  }
  if (command === "stars") {
    await starsCommand(subcommand, rest);
    return false;
  }
  if (command === "lists") {
    await listsCommand(subcommand, rest);
    return false;
  }
  if (command === "collections") {
    await collectionsCommand(subcommand, rest);
    return false;
  }
  if (command === "data") {
    await dataCommand(subcommand);
    return false;
  }
  if (command === "plan") {
    if (subcommand) {
      const plan = await createAndStorePlan([subcommand, ...rest].join(" "));
      printPlan(plan);
    } else {
      printPlan(await readJson("plan", { actions: [] }));
    }
    return false;
  }
  if (command === "apply") {
    const plan = await readJson("plan", { actions: [] });
    if (!plan.actions?.length) {
      console.log("No pending plan. Type a request first, or use /plan <request>.");
      return false;
    }
    printPlan(plan);
    const answer = (await rl.question("Apply this plan to GitHub? [y/N]: ")).trim().toLowerCase();
    if (["y", "yes"].includes(answer)) {
      const applied = await applyGitHubPlan(plan);
      await removeData("plan");
      console.log(`Applied ${applied.length} plan actions.`);
    }
    return false;
  }
  if (command === "clear") {
    await removeData("plan");
    console.log("Cleared pending AI plan.");
    return false;
  }
  console.log(`Unknown AI shell command "/${command}". Type /help.`);
  return false;
}

async function handleNaturalAiInput(rl, text) {
  const plan = await createAndStorePlan(text);
  printPlan(plan);
  if (!plan.actions?.length) return;
  const answer = (await rl.question("Apply this plan to GitHub now? [y/N]: ")).trim().toLowerCase();
  if (["y", "yes"].includes(answer)) {
    const applied = await applyGitHubPlan(plan);
    await removeData("plan");
    console.log(`Applied ${applied.length} plan actions.`);
  }
}

async function createAndStorePlan(prompt) {
  const plan = await planGitHubActions({ prompt });
  await writeJson("plan", plan);
  await appendHistory({ action: "ai.plan", prompt, count: plan.actions?.length || 0 });
  return plan;
}

async function applyGitHubPlan(plan) {
  const config = await readConfig();
  await applyProxyConfig(config);
  const token = tokenFromConfig(config);
  const applied = [];
  for (const action of plan.actions || []) {
    if (action.type === "sync_stars") {
      const stars = await listStarredRepos(token);
      await writeJson("stars", { synced_at: new Date().toISOString(), stars });
      applied.push({ type: action.type, count: stars.length });
      continue;
    }
    if (action.type === "sync_lists") {
      const state = await syncGitHubLists(token);
      await writeJson("lists", state);
      applied.push({ type: action.type, count: state.lists.length });
      continue;
    }
    if (action.type === "create_list") {
      const list = await createGitHubList(token, {
        name: action.name,
        description: action.description || "",
        isPrivate: Boolean(action.private)
      });
      await syncAndCacheLists(token);
      applied.push({ type: action.type, list: list.name });
      continue;
    }
    if (action.type === "add_repo_to_list") {
      const result = await addRepoToGitHubList(token, action.list, action.repo, {
        create: Boolean(action.create),
        star: true
      });
      await syncAndCacheLists(token);
      applied.push({ type: action.type, repo: result.repo, list: result.list.name, changed: result.changed });
      continue;
    }
    if (action.type === "remove_repo_from_list") {
      const result = await removeRepoFromGitHubList(token, action.list, action.repo);
      await syncAndCacheLists(token);
      applied.push({ type: action.type, repo: result.repo, list: result.list.name, changed: result.changed });
      continue;
    }
    throw new Error(`Unsupported plan action "${action.type}".`);
  }
  await appendHistory({ action: "ai.apply-plan", count: applied.length });
  return applied;
}

function printAiReplHelp() {
  console.log(`AI shell commands:
  /help
  /exit
  /model [current|list|use ...]
  /auth status
  /stars sync|list|search|star|unstar
  /lists sync|list|show|create|add|remove
  /plan [natural language request]
  /apply
  /clear

Natural language input asks the configured model to produce a GitHub Star Lists plan.`);
}

function printPlan(plan) {
  if (plan.reply) console.log(plan.reply);
  const actions = plan.actions || [];
  if (!actions.length) {
    console.log("No GitHub actions planned.");
    return;
  }
  console.log("Plan:");
  actions.forEach((action, index) => {
    console.log(`  ${index + 1}. ${formatPlanAction(action)}`);
  });
  console.log("Run /apply in ghac ai, or run: ghac ai apply-plan");
}

function formatPlanAction(action) {
  if (action.type === "sync_stars") return "sync starred repositories";
  if (action.type === "sync_lists") return "sync GitHub Star Lists";
  if (action.type === "create_list") return `create list "${action.name}"${action.private ? " (private)" : ""}`;
  if (action.type === "add_repo_to_list") return `add ${action.repo} to "${action.list}"${action.create ? " (create list if missing)" : ""}`;
  if (action.type === "remove_repo_from_list") return `remove ${action.repo} from "${action.list}"`;
  return JSON.stringify(action);
}

async function dataCommand(command) {
  if (command === "path") {
    console.log(DATA_DIR);
    console.log(`config: ${dataPath("config")}`);
    console.log(`stars: ${dataPath("stars")}`);
    console.log(`lists: ${dataPath("lists")}`);
    console.log(`collections: ${dataPath("collections")}`);
    console.log(`plan: ${dataPath("plan")}`);
    console.log(`suggestions: ${dataPath("suggestions")}`);
    console.log(`history: ${dataPath("history")}`);
    return;
  }
  if (command === "doctor") {
    const config = await readConfig();
    const stars = await readJson("stars", { stars: [] });
    const lists = await readJson("lists", { lists: [] });
    const collections = await readCollections();
    const suggestions = await readJson("suggestions", { collections: [] });
    const starNames = new Set((stars.stars || []).map((repo) => repo.full_name));
    const collectionNames = new Set();
    const duplicateCollections = [];
    const unknownRepos = [];
    for (const collection of collections.collections || []) {
      const key = String(collection.name || "").trim().toLowerCase();
      if (collectionNames.has(key)) duplicateCollections.push(collection.name);
      collectionNames.add(key);
      for (const repo of collection.repos || []) {
        if (starNames.size > 0 && !starNames.has(repo)) unknownRepos.push(`${collection.name}:${repo}`);
      }
    }
    console.log(`Data dir: ${DATA_DIR}`);
    console.log(`GitHub token: ${tokenFromConfig(config) ? "configured" : "missing"}`);
    console.log(proxyStatusLines(config).join("; "));
    console.log(`AI model: ${modelLabel(config)}`);
    console.log(`Stars: ${(stars.stars || []).length}`);
    console.log(`GitHub Star Lists: ${(lists.lists || []).length}`);
    console.log(`Collections: ${(collections.collections || []).length}`);
    console.log(`Pending suggestions: ${countSuggestedAssignments(suggestions)}`);
    if (duplicateCollections.length) console.log(`Duplicate collection names: ${duplicateCollections.join(", ")}`);
    if (unknownRepos.length) console.log(`Repos in collections but not in current stars: ${unknownRepos.slice(0, 20).join(", ")}${unknownRepos.length > 20 ? " ..." : ""}`);
    if (!duplicateCollections.length && !unknownRepos.length) console.log("No obvious data issues.");
    return;
  }
  printHelp("data");
}

function printRepos(repos) {
  if (!repos.length) {
    console.log("No repositories.");
    return;
  }
  for (const repo of repos) {
    const meta = [repo.language, repo.archived ? "archived" : "", repo.starred_at ? `starred ${repo.starred_at.slice(0, 10)}` : ""].filter(Boolean).join(" / ");
    console.log(`${repo.full_name}${meta ? ` - ${meta}` : ""}`);
    if (repo.description) console.log(`  ${repo.description}`);
  }
}

function repoMatches(repo, keyword) {
  return [
    repo.full_name,
    repo.description,
    repo.language,
    ...(repo.topics || [])
  ].join(" ").toLowerCase().includes(keyword);
}

function findCollection(state, name) {
  const clean = String(name || "").trim().toLowerCase();
  const collection = state.collections.find((item) => item.name.toLowerCase() === clean);
  if (!collection) throw new Error(`Collection "${name}" does not exist.`);
  return collection;
}

async function syncAndCacheLists(token) {
  const state = await syncGitHubLists(token);
  await writeJson("lists", state);
  return state;
}

function findLocalList(state, name) {
  const clean = String(name || "").trim().toLowerCase();
  if (!clean) throw new Error("Usage: ghac lists show <name>");
  const list = (state.lists || []).find((item) => item.name.toLowerCase() === clean || item.slug.toLowerCase() === clean);
  if (!list) throw new Error(`GitHub list "${name}" does not exist.`);
  return list;
}

function collectionRepoArgs(args) {
  const repo = args[args.length - 1];
  const name = args.slice(0, -1).join(" ");
  if (!name || !repo) throw new Error("Usage: ghac collections add <collection name> <owner/repo>");
  return { name, repo };
}

function listRepoArgs(args, booleanOptions = []) {
  const values = positionalArgs(args, [], booleanOptions);
  const repo = values[values.length - 1];
  const name = values.slice(0, -1).join(" ");
  if (!name || !repo) throw new Error("Usage: ghac lists add <list name> <owner/repo>");
  return { name, repo };
}

function positionalArgs(args, valueOptions = [], booleanOptions = []) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (valueOptions.includes(item)) {
      index += 1;
      continue;
    }
    if (booleanOptions.includes(item)) continue;
    values.push(item);
  }
  return values;
}

function parseProxyArgs(args) {
  if (!args.length) throw new Error("Usage: ghac proxy set <url>");
  if (!args[0].startsWith("--")) {
    const url = args[0];
    return normalizeProxyConfig({ http: url, https: url });
  }
  const proxy = normalizeProxyConfig({
    http: readOption(args, "--http"),
    https: readOption(args, "--https"),
    all: readOption(args, "--all"),
    noProxy: readOption(args, "--no-proxy")
  });
  if (!Object.keys(proxy).length) throw new Error("Usage: ghac proxy set --http <url> [--https <url>] [--all <url>] [--no-proxy list]");
  return proxy;
}

function defaultModelForProvider(provider) {
  if (provider === "pi") return "openai/gpt-4o-mini";
  if (provider === "codex") return "auto";
  if (provider === "openai-compatible") return "env";
  return "local-rules";
}

function modelLabel(config) {
  if (!config.ai?.provider) return "not configured";
  if (!config.ai?.model) return config.ai.provider;
  return `${config.ai.provider}:${config.ai.model}`;
}

async function createPiModelsWithStore(store) {
  const pi = await import("@earendil-works/pi-ai/providers/all");
  return pi.builtinModels({ credentials: store });
}

async function authLoginPrompt(rl, prompt) {
  if (prompt.type === "select") {
    console.log(`\n${prompt.message}`);
    prompt.options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`);
    });
    const answer = (await questionWithSignal(rl, `Enter number (1-${prompt.options.length}, default 1): `, prompt.signal)).trim();
    const index = answer ? Number(answer) - 1 : 0;
    return prompt.options[index]?.id || prompt.options[0]?.id || "";
  }
  const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
  return questionWithSignal(rl, `${prompt.message}${suffix}: `, prompt.signal);
}

async function questionWithSignal(rl, message, signal) {
  try {
    return await rl.question(message, signal ? { signal } : undefined);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Login prompt was cancelled.");
    throw error;
  }
}

function notifyAuthEvent(event) {
  if (event.type === "auth_url") {
    console.log(`\nOpen this URL in your browser:\n${event.url}`);
    if (event.instructions) console.log(event.instructions);
    return;
  }
  if (event.type === "device_code") {
    console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
    console.log(`Enter code: ${event.userCode}`);
    return;
  }
  if (event.type === "progress") console.log(event.message);
}

function isCodexAlias(value) {
  return ["codex", "pi:codex", "pi:openai/codex"].includes(String(value || "").toLowerCase());
}

function firstSuggestedAction(suggestions, state = { collections: [] }) {
  for (const collection of suggestions.collections || []) {
    for (const repo of collection.repos || []) {
      if (collectionContainsRepo(state, collection.name, repo)) continue;
      return {
        action: "add_to_collection",
        repo,
        collection: collection.name,
        description: collection.description || "",
        reason: `Suggested by ${suggestions.provider || "ai"}:${suggestions.model || "unknown"}`
      };
    }
  }
  return null;
}

function collectionContainsRepo(state, collectionName, repoFullName) {
  const cleanName = String(collectionName || "").trim().toLowerCase();
  const collection = state.collections?.find((item) => item.name.toLowerCase() === cleanName);
  return Boolean(collection?.repos?.includes(repoFullName));
}

function removeSuggestedAssignment(suggestions, action) {
  suggestions.collections = (suggestions.collections || [])
    .map((collection) => {
      if (collection.name !== action.collection) return collection;
      return {
        ...collection,
        repos: (collection.repos || []).filter((repo) => repo !== action.repo)
      };
    })
    .filter((collection) => (collection.repos || []).length > 0);
}

async function applySuggestedAction(state, suggestions, action, historyAction) {
  addRepoToCollection(state, action.collection, action.repo, action.description || "");
  removeSuggestedAssignment(suggestions, action);
  await writeCollections(state);
  await writeJson("suggestions", suggestions);
  await appendHistory({ action: historyAction, repo: action.repo, collection: action.collection });
}

async function reviewSuggestions() {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const suggestions = await readJson("suggestions", { collections: [] });
      const state = await readCollections();
      const action = firstSuggestedAction(suggestions, state);
      if (!action) {
        console.log("No unapplied suggestion action available. Run: ghac ai suggest");
        return;
      }
      console.log(`\n${action.repo} -> ${action.collection}`);
      if (action.description) console.log(action.description);
      console.log(action.reason);
      const answer = (await rl.question("Apply this action? [a]pply/[s]kip/[q]uit: ")).trim().toLowerCase();
      if (answer === "q" || answer === "quit") return;
      if (answer === "s" || answer === "skip") {
        removeSuggestedAssignment(suggestions, action);
        await writeJson("suggestions", suggestions);
        await appendHistory({ action: "ai.review.skip", repo: action.repo, collection: action.collection });
        console.log(`Skipped: ${action.repo} -> ${action.collection}`);
        continue;
      }
      if (answer === "" || answer === "a" || answer === "apply" || answer === "y" || answer === "yes") {
        await applySuggestedAction(state, suggestions, action, "ai.review.apply");
        console.log(`Applied: ${action.repo} -> ${action.collection}`);
        continue;
      }
      console.log("Enter a/apply, s/skip, or q/quit.");
    }
  } finally {
    rl.close();
  }
}

function normalizeCollectionState(value) {
  if (!value || !Array.isArray(value.collections)) {
    throw new Error("Collection file must be JSON with a collections array.");
  }
  return {
    collections: value.collections.map((collection) => ({
      name: String(collection.name || "").trim(),
      description: String(collection.description || ""),
      repos: [...new Set((collection.repos || []).map((repo) => String(repo).trim()).filter(Boolean))].sort(),
      created_at: collection.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    })).filter((collection) => collection.name)
  };
}

function mergeCollectionStates(current, incoming) {
  const next = normalizeCollectionState(current);
  for (const collection of incoming.collections) {
    const target = ensureCollection(next, collection.name, collection.description || "");
    if (!target.description && collection.description) target.description = collection.description;
    for (const repo of collection.repos) {
      addRepoToCollection(next, target.name, repo, collection.description || "");
    }
  }
  return next;
}

function countSuggestedAssignments(suggestions) {
  return (suggestions.collections || []).reduce((total, collection) => total + (collection.repos || []).length, 0);
}

function countUnappliedSuggestions(suggestions, state) {
  let total = 0;
  for (const collection of suggestions.collections || []) {
    for (const repo of collection.repos || []) {
      if (!collectionContainsRepo(state, collection.name, repo)) total += 1;
    }
  }
  return total;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  return args[index + 1] || "";
}

function parseCommandLine(line) {
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of String(line || "")) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in command.");
  if (current) args.push(current);
  return args;
}

async function promptSecret(label) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}
