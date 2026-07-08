import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DATA_DIR = process.env.GHAC_HOME || process.env.GH_AI_CLIENT_HOME || join(homedir(), ".ghac");

const paths = {
  config: join(DATA_DIR, "config.json"),
  stars: join(DATA_DIR, "stars.json"),
  collections: join(DATA_DIR, "collections.json"),
  suggestions: join(DATA_DIR, "suggestions.json"),
  history: join(DATA_DIR, "history.jsonl")
};

export function dataPath(name) {
  return paths[name] || join(DATA_DIR, name);
}

export async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(dataPath(name), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(name, value) {
  const path = dataPath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function removeData(name) {
  await rm(dataPath(name), { force: true });
}

export async function readConfig() {
  return readJson("config", {
    github: {},
    ai: {
      provider: "mock",
      model: "local-rules"
    }
  });
}

export async function writeConfig(config) {
  await writeJson("config", config);
}

export async function appendHistory(entry) {
  const path = dataPath("history");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { flag: "a" });
}
