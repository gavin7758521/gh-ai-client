import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DATA_DIR = process.env.GHAC_HOME || process.env.GH_AI_CLIENT_HOME || join(homedir(), ".ghac");

const paths = {
  config: join(DATA_DIR, "config.json")
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

export async function readConfig() {
  return readJson("config", {
    github: {},
    ai: {
      provider: "",
      model: ""
    }
  });
}

export async function writeConfig(config) {
  await writeJson("config", config);
}
