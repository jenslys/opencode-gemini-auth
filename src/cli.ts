#!/usr/bin/env bun
/**
 * CLI for managing Google account profiles for opencode.
 *
 * Usage:
 *   gemini-swap list                    - List all saved profiles
 *   gemini-swap save <name> [projectId] - Save current config as a profile
 *   gemini-swap use <name>              - Switch to a profile
 *   gemini-swap current                 - Show current configuration
 *   gemini-swap delete <name>           - Delete a profile
 *   gemini-swap help                    - Show this help message
 */

import {
  listProfiles,
  saveProfile,
  useProfile,
  deleteProfile,
  currentInfo,
  getActiveProfileName,
} from "./plugin/profiles";

function printUsage(): void {
  console.log(`
Gemini Account Swap - Manage Google accounts for OpenCode

Usage:
  gemini-swap list                    - List all saved profiles
  gemini-swap save <name> [projectId] - Save current config as a profile
  gemini-swap use <name>              - Switch to a profile
  gemini-swap current                 - Show current configuration
  gemini-swap delete <name>           - Delete a profile
  gemini-swap help, -h, --help        - Show this help message

Examples:
  gemini-swap save work my-work-project-123
  gemini-swap save personal my-personal-project-456
  gemini-swap use work
  gemini-swap list
`);
}

function cmdList(): void {
  const profiles = listProfiles();
  const active = getActiveProfileName();

  if (profiles.length === 0) {
    console.log("No profiles saved yet.");
    console.log("Use 'gemini-swap save <name> [projectId]' to save current config.");
    return;
  }

  console.log("Saved profiles:");
  for (const profile of profiles) {
    const marker = profile.name === active ? " (active)" : "";
    const lastUsed = profile.lastUsed
      ? new Date(profile.lastUsed).toLocaleDateString()
      : "never";
    console.log(`  - ${profile.name}${marker}`);
    console.log(`      projectId: ${profile.projectId}`);
    console.log(`      lastUsed: ${lastUsed}`);
  }
}

function cmdSave(name: string | undefined, projectId: string | undefined): void {
  if (!name) {
    console.error("Error: Profile name required.");
    console.log("Usage: gemini-swap save <name> [projectId]");
    process.exit(1);
  }

  const result = saveProfile(name, projectId);
  if (result.success) {
    console.log(result.message);
  } else {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
}

function cmdUse(name: string | undefined): void {
  if (!name) {
    console.error("Error: Profile name required.");
    console.log("Usage: gemini-swap use <name>");
    process.exit(1);
  }

  const result = useProfile(name);
  if (result.success) {
    console.log(result.message);
  } else {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
}

function cmdDelete(name: string | undefined): void {
  if (!name) {
    console.error("Error: Profile name required.");
    console.log("Usage: gemini-swap delete <name>");
    process.exit(1);
  }

  const result = deleteProfile(name);
  if (result.success) {
    console.log(result.message);
  } else {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }
}

function cmdCurrent(): void {
  const info = currentInfo();
  console.log("Current configuration:");
  console.log(`  Active profile: ${info.activeProfile ?? "(none)"}`);
  console.log(`  Project ID: ${info.projectId ?? "(not set)"}`);
  console.log(`  Refresh token: ${info.refreshToken ?? "(not logged in)"}`);
}

// Main
const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();

switch (command) {
  case "list":
  case "ls":
    cmdList();
    break;
  case "save":
  case "add":
    cmdSave(args[1], args[2]);
    break;
  case "use":
  case "switch":
    cmdUse(args[1]);
    break;
  case "delete":
  case "rm":
  case "remove":
    cmdDelete(args[1]);
    break;
  case "current":
  case "status":
    cmdCurrent();
    break;
  case "help":
  case "-h":
  case "--help":
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
