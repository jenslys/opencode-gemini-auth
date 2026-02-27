import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, "..");
const geminiCliPackagePath = join(rootDir, ".local/gemini-cli/packages/cli/package.json");
const targetFilePath = join(rootDir, "src/plugin/gemini-cli-version.ts");

function readGeminiCliVersion() {
  const sourceText = readFileSync(geminiCliPackagePath, "utf8");
  const sourceJson = JSON.parse(sourceText);
  const version = sourceJson?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`Invalid or missing version in ${geminiCliPackagePath}`);
  }
  return version.trim();
}

function buildTargetFile(version) {
  return `/**
 * Synced from \`.local/gemini-cli/packages/cli/package.json\`.
 * Update with: \`npm run update:gemini-cli-version\`
 */
export const GEMINI_CLI_VERSION = "${version}";
`;
}

function main() {
  const version = readGeminiCliVersion();
  const nextContent = buildTargetFile(version);
  let currentContent = "";
  try {
    currentContent = readFileSync(targetFilePath, "utf8");
  } catch {}

  if (currentContent === nextContent) {
    console.log(`Gemini CLI version already up-to-date: ${version}`);
    return;
  }

  writeFileSync(targetFilePath, nextContent, "utf8");
  console.log(`Updated src/plugin/gemini-cli-version.ts -> ${version}`);
}

main();
