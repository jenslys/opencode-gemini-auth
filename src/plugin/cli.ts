import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function promptProjectId(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Project ID (leave blank to use your default project): ");
    return answer.trim();
  } finally {
    rl.close();
  }
}
