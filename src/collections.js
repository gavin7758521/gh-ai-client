import { readJson, writeJson } from "./storage.js";

export async function readCollections() {
  return readJson("collections", { collections: [] });
}

export async function writeCollections(collections) {
  await writeJson("collections", collections);
}

export function ensureCollection(state, name, description = "") {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Collection name is required.");
  const existing = state.collections.find((item) => item.name.toLowerCase() === cleanName.toLowerCase());
  if (existing) return existing;
  const collection = {
    name: cleanName,
    description,
    repos: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  state.collections.push(collection);
  return collection;
}

export function addRepoToCollection(state, collectionName, repoFullName, description = "") {
  const collection = ensureCollection(state, collectionName, description);
  if (!collection.repos.includes(repoFullName)) {
    collection.repos.push(repoFullName);
    collection.repos.sort();
    collection.updated_at = new Date().toISOString();
  }
  return collection;
}

export function removeRepoFromCollection(state, collectionName, repoFullName) {
  const collection = state.collections.find((item) => item.name.toLowerCase() === collectionName.toLowerCase());
  if (!collection) throw new Error(`Collection "${collectionName}" does not exist.`);
  collection.repos = collection.repos.filter((repo) => repo !== repoFullName);
  collection.updated_at = new Date().toISOString();
  return collection;
}

export function applySuggestions(collectionState, suggestions) {
  const applied = [];
  for (const suggestion of suggestions.collections || []) {
    const name = String(suggestion.name || "").trim();
    if (!name) continue;
    for (const repo of suggestion.repos || []) {
      const existing = collectionState.collections.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (existing?.repos.includes(repo)) continue;
      addRepoToCollection(collectionState, name, repo, suggestion.description || "");
      applied.push({ collection: name, repo });
    }
  }
  return applied;
}
