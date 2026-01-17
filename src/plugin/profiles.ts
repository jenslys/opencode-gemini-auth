import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A named profile containing OAuth credentials and project configuration.
 */
export interface Profile {
  name: string;
  refreshToken: string;
  projectId: string;
  createdAt: number;
  lastUsed?: number;
}

/**
 * Storage format for profiles file.
 */
export interface ProfilesStore {
  version: number;
  profiles: Profile[];
  activeProfile?: string;
}

/**
 * Result of a profile operation.
 */
export interface ProfileResult {
  success: boolean;
  message: string;
  profile?: Profile;
}

/**
 * Configuration for the profile manager paths.
 */
export interface ProfileManagerConfig {
  configDir: string;
  profilesFile: string;
  accountsFile: string;
  configFile: string;
}

/**
 * Returns default config paths using the user's home directory.
 */
export function getDefaultConfig(): ProfileManagerConfig {
  const configDir = join(homedir(), ".config", "opencode");
  return {
    configDir,
    profilesFile: join(configDir, "gemini-profiles.json"),
    accountsFile: join(configDir, "antigravity-accounts.json"),
    configFile: join(configDir, "config.json"),
  };
}

// Default config - can be overridden for testing
let currentConfig: ProfileManagerConfig = getDefaultConfig();

/**
 * Sets the configuration paths. Used for testing with temp directories.
 */
export function setConfig(config: ProfileManagerConfig): void {
  currentConfig = config;
}

/**
 * Resets to default configuration.
 */
export function resetConfig(): void {
  currentConfig = getDefaultConfig();
}

/**
 * Gets current configuration.
 */
export function getConfig(): ProfileManagerConfig {
  return currentConfig;
}

/**
 * Ensures the config directory exists.
 */
function ensureConfigDir(): void {
  if (!existsSync(currentConfig.configDir)) {
    mkdirSync(currentConfig.configDir, { recursive: true });
  }
}

/**
 * Loads the profiles store from disk.
 */
export function loadProfilesStore(): ProfilesStore {
  ensureConfigDir();
  if (!existsSync(currentConfig.profilesFile)) {
    return { version: 1, profiles: [] };
  }
  try {
    const content = readFileSync(currentConfig.profilesFile, "utf-8");
    return JSON.parse(content) as ProfilesStore;
  } catch {
    return { version: 1, profiles: [] };
  }
}

/**
 * Saves the profiles store to disk.
 */
export function saveProfilesStore(store: ProfilesStore): void {
  ensureConfigDir();
  writeFileSync(currentConfig.profilesFile, JSON.stringify(store, null, 2));
}

/**
 * Reads current refresh token from antigravity-accounts.json.
 */
export function getCurrentRefreshToken(): string | undefined {
  if (!existsSync(currentConfig.accountsFile)) {
    return undefined;
  }
  try {
    const content = readFileSync(currentConfig.accountsFile, "utf-8");
    const data = JSON.parse(content) as {
      accounts?: Array<{ refreshToken?: string }>;
      activeIndex?: number;
    };
    const activeIndex = data.activeIndex ?? 0;
    return data.accounts?.[activeIndex]?.refreshToken;
  } catch {
    return undefined;
  }
}

/**
 * Reads current project ID from config.json.
 */
export function getCurrentProjectId(): string | undefined {
  if (!existsSync(currentConfig.configFile)) {
    return undefined;
  }
  try {
    const content = readFileSync(currentConfig.configFile, "utf-8");
    const data = JSON.parse(content) as {
      provider?: {
        google?: {
          options?: {
            projectId?: string;
          };
        };
      };
    };
    return data.provider?.google?.options?.projectId;
  } catch {
    return undefined;
  }
}

/**
 * Updates the refresh token in antigravity-accounts.json.
 */
export function setRefreshToken(refreshToken: string): boolean {
  try {
    ensureConfigDir();
    let data: {
      version: number;
      accounts: Array<{ refreshToken: string; addedAt: number; lastUsed: number; rateLimitResetTimes: Record<string, unknown> }>;
      activeIndex: number;
      activeIndexByFamily: Record<string, number>;
    };

    if (existsSync(currentConfig.accountsFile)) {
      const content = readFileSync(currentConfig.accountsFile, "utf-8");
      data = JSON.parse(content);
    } else {
      data = {
        version: 3,
        accounts: [],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      };
    }

    // Find account with matching token
    let accountIndex = data.accounts.findIndex(
      (acc) => acc.refreshToken === refreshToken
    );

    let activeAccount;
    if (accountIndex !== -1) {
      // Account exists, remove it from its current position
      [activeAccount] = data.accounts.splice(accountIndex, 1);
    } else {
      // Account doesn't exist, create it
      activeAccount = {
        refreshToken,
        addedAt: Date.now(),
        lastUsed: Date.now(),
        rateLimitResetTimes: {},
      };
    }

    // Always put the active account at index 0 to ensure it's picked up by opencode
    activeAccount.lastUsed = Date.now();
    data.accounts.unshift(activeAccount);
    data.activeIndex = 0;

    // Update all family indices to point to the active account (index 0)
    for (const family of Object.keys(data.activeIndexByFamily)) {
      data.activeIndexByFamily[family] = 0;
    }

    writeFileSync(currentConfig.accountsFile, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Updates the project ID in config.json.
 */
export function setProjectId(projectId: string): boolean {
  try {
    ensureConfigDir();
    let data: Record<string, unknown> = {};

    if (existsSync(currentConfig.configFile)) {
      const content = readFileSync(currentConfig.configFile, "utf-8");
      data = JSON.parse(content);
    }

    // Ensure nested structure exists
    if (!data.provider) {
      data.provider = {};
    }
    const provider = data.provider as Record<string, unknown>;
    if (!provider.google) {
      provider.google = {};
    }
    const google = provider.google as Record<string, unknown>;
    if (!google.options) {
      google.options = {};
    }
    const options = google.options as Record<string, unknown>;
    options.projectId = projectId;

    writeFileSync(currentConfig.configFile, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists all saved profiles.
 */
export function listProfiles(): Profile[] {
  const store = loadProfilesStore();
  return store.profiles;
}

/**
 * Gets the currently active profile name.
 */
export function getActiveProfileName(): string | undefined {
  const store = loadProfilesStore();
  return store.activeProfile;
}

/**
 * Gets a profile by name.
 */
export function getProfile(name: string): Profile | undefined {
  const store = loadProfilesStore();
  return store.profiles.find((p) => p.name === name);
}

/**
 * Saves the current configuration as a named profile.
 */
export function saveProfile(name: string, projectId?: string): ProfileResult {
  const refreshToken = getCurrentRefreshToken();
  if (!refreshToken) {
    return {
      success: false,
      message: "No active OAuth session found. Run 'opencode auth login' first.",
    };
  }

  const resolvedProjectId = projectId ?? getCurrentProjectId() ?? "";
  if (!resolvedProjectId) {
    return {
      success: false,
      message: "No project ID found. Provide one as argument or set in config.json.",
    };
  }

  const store = loadProfilesStore();
  const existingIndex = store.profiles.findIndex((p) => p.name === name);
  const existingProfile = existingIndex >= 0 ? store.profiles[existingIndex] : undefined;

  const profile: Profile = {
    name,
    refreshToken,
    projectId: resolvedProjectId,
    createdAt: existingProfile?.createdAt ?? Date.now(),
    lastUsed: Date.now(),
  };

  if (existingIndex >= 0) {
    store.profiles[existingIndex] = profile;
  } else {
    store.profiles.push(profile);
  }

  store.activeProfile = name;
  saveProfilesStore(store);

  return {
    success: true,
    message: `Profile '${name}' saved (projectId: ${resolvedProjectId})`,
    profile,
  };
}

/**
 * Switches to a named profile.
 */
export function useProfile(name: string): ProfileResult {
  const store = loadProfilesStore();
  const profile = store.profiles.find((p) => p.name === name);

  if (!profile) {
    const available = store.profiles.map((p) => p.name).join(", ") || "(none)";
    return {
      success: false,
      message: `Profile '${name}' not found. Available: ${available}`,
    };
  }

  // Update refresh token
  if (!setRefreshToken(profile.refreshToken)) {
    return {
      success: false,
      message: "Failed to update refresh token in accounts file.",
    };
  }

  // Update project ID
  if (!setProjectId(profile.projectId)) {
    return {
      success: false,
      message: "Failed to update project ID in config file.",
    };
  }

  // Update last used and active profile
  profile.lastUsed = Date.now();
  store.activeProfile = name;
  saveProfilesStore(store);

  return {
    success: true,
    message: `Switched to profile '${name}' (projectId: ${profile.projectId})`,
    profile,
  };
}

/**
 * Deletes a profile by name.
 */
export function deleteProfile(name: string): ProfileResult {
  const store = loadProfilesStore();
  const index = store.profiles.findIndex((p) => p.name === name);

  if (index < 0) {
    return {
      success: false,
      message: `Profile '${name}' not found.`,
    };
  }

  const [removed] = store.profiles.splice(index, 1);

  if (store.activeProfile === name) {
    store.activeProfile = undefined;
  }

  saveProfilesStore(store);

  return {
    success: true,
    message: `Profile '${name}' deleted.`,
    profile: removed,
  };
}

/**
 * Shows current configuration info.
 */
export function currentInfo(): { refreshToken?: string; projectId?: string; activeProfile?: string } {
  const token = getCurrentRefreshToken();
  return {
    refreshToken: token ? token.slice(0, 20) + "..." : undefined,
    projectId: getCurrentProjectId(),
    activeProfile: getActiveProfileName(),
  };
}
