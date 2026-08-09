import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { GeminiAccount } from "./types";

function getConfigFilePath(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test";
  const fileName = isTest ? "gemini-auth.test.json" : "gemini-auth.json";
  return path.join(configDir, fileName);
}

export async function loadAccountsFromDisk(): Promise<GeminiAccount[]> {
  try {
    const filePath = getConfigFilePath();
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.accounts)) {
      return parsed.accounts as GeminiAccount[];
    }
  } catch (error) {
    // Ignore if file doesn't exist or is invalid
  }
  return [];
}

export async function saveAccountsToDisk(accounts: GeminiAccount[]): Promise<void> {
  try {
    const filePath = getConfigFilePath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    
    const data = {
      accounts: accounts.map(a => ({
        id: a.id,
        email: a.email,
        refreshToken: a.refreshToken,
        projectId: a.projectId,
        enabled: a.enabled
      }))
    };
    
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error("[Gemini Auth] Failed to save accounts to disk:", error);
  }
}
