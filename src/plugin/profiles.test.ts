import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  setConfig,
  resetConfig,
  getConfig,
  listProfiles,
  saveProfile,
  useProfile,
  deleteProfile,
  getProfile,
  getActiveProfileName,
  currentInfo,
  getCurrentRefreshToken,
  getCurrentProjectId,
  setRefreshToken,
  setProjectId,
  loadProfilesStore,
  saveProfilesStore,
  type ProfileManagerConfig,
  type Profile,
} from "./profiles";

// Create a unique temp directory for each test run
function createTempConfig(): ProfileManagerConfig {
  const configDir = join(tmpdir(), `opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(configDir, { recursive: true });
  return {
    configDir,
    profilesFile: join(configDir, "gemini-profiles.json"),
    accountsFile: join(configDir, "antigravity-accounts.json"),
    configFile: join(configDir, "config.json"),
  };
}

// Clean up temp directory
function cleanupTempConfig(config: ProfileManagerConfig): void {
  try {
    rmSync(config.configDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// Helper to create mock accounts file
function createMockAccountsFile(config: ProfileManagerConfig, refreshToken: string): void {
  const data = {
    version: 3,
    accounts: [
      {
        refreshToken,
        addedAt: Date.now(),
        lastUsed: Date.now(),
        rateLimitResetTimes: {},
      },
    ],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  };
  writeFileSync(config.accountsFile, JSON.stringify(data, null, 2));
}

// Helper to create mock config file
function createMockConfigFile(config: ProfileManagerConfig, projectId: string): void {
  const data = {
    "$schema": "https://opencode.ai/config.json",
    plugin: ["opencode-gemini-auth-swap@latest"],
    provider: {
      google: {
        options: {
          projectId,
        },
      },
    },
  };
  writeFileSync(config.configFile, JSON.stringify(data, null, 2));
}

describe("profiles", () => {
  let tempConfig: ProfileManagerConfig;

  beforeEach(() => {
    tempConfig = createTempConfig();
    setConfig(tempConfig);
  });

  afterEach(() => {
    resetConfig();
    cleanupTempConfig(tempConfig);
  });

  describe("config management", () => {
    it("should set and get config", () => {
      const config = getConfig();
      expect(config.configDir).toBe(tempConfig.configDir);
      expect(config.profilesFile).toBe(tempConfig.profilesFile);
    });

    it("should reset to default config", () => {
      resetConfig();
      const config = getConfig();
      expect(config.configDir).toContain(".config/opencode");
      // Reset back to temp for cleanup
      setConfig(tempConfig);
    });
  });

  describe("getCurrentRefreshToken", () => {
    it("should return undefined when accounts file does not exist", () => {
      expect(getCurrentRefreshToken()).toBeUndefined();
    });

    it("should return refresh token from accounts file", () => {
      createMockAccountsFile(tempConfig, "test-refresh-token-123");
      expect(getCurrentRefreshToken()).toBe("test-refresh-token-123");
    });

    it("should return token at activeIndex", () => {
      const data = {
        version: 3,
        accounts: [
          { refreshToken: "token-0", addedAt: 1, lastUsed: 1, rateLimitResetTimes: {} },
          { refreshToken: "token-1", addedAt: 1, lastUsed: 1, rateLimitResetTimes: {} },
        ],
        activeIndex: 1,
        activeIndexByFamily: { claude: 0, gemini: 1 },
      };
      writeFileSync(tempConfig.accountsFile, JSON.stringify(data));
      expect(getCurrentRefreshToken()).toBe("token-1");
    });

    it("should handle malformed JSON gracefully", () => {
      writeFileSync(tempConfig.accountsFile, "not valid json");
      expect(getCurrentRefreshToken()).toBeUndefined();
    });
  });

  describe("getCurrentProjectId", () => {
    it("should return undefined when config file does not exist", () => {
      expect(getCurrentProjectId()).toBeUndefined();
    });

    it("should return project ID from config file", () => {
      createMockConfigFile(tempConfig, "my-project-123");
      expect(getCurrentProjectId()).toBe("my-project-123");
    });

    it("should handle missing nested properties", () => {
      writeFileSync(tempConfig.configFile, JSON.stringify({ provider: {} }));
      expect(getCurrentProjectId()).toBeUndefined();
    });

    it("should handle malformed JSON gracefully", () => {
      writeFileSync(tempConfig.configFile, "invalid json");
      expect(getCurrentProjectId()).toBeUndefined();
    });
  });

  describe("setRefreshToken", () => {
    it("should create accounts file if it does not exist", () => {
      expect(setRefreshToken("new-token")).toBe(true);
      expect(existsSync(tempConfig.accountsFile)).toBe(true);
      expect(getCurrentRefreshToken()).toBe("new-token");
    });

    it("should update existing token", () => {
      createMockAccountsFile(tempConfig, "old-token");
      expect(setRefreshToken("new-token")).toBe(true);
      expect(getCurrentRefreshToken()).toBe("new-token");
    });

    it("should preserve other account data", () => {
      createMockAccountsFile(tempConfig, "old-token");
      setRefreshToken("new-token");
      const data = JSON.parse(readFileSync(tempConfig.accountsFile, "utf-8"));
      expect(data.version).toBe(3);
      expect(data.accounts[0].refreshToken).toBe("new-token");
      expect(data.accounts[1].refreshToken).toBe("old-token");
      expect(data.activeIndex).toBe(0);
      expect(data.activeIndexByFamily.gemini).toBe(0);
    });
  });

  describe("setProjectId", () => {
    it("should create config file if it does not exist", () => {
      expect(setProjectId("new-project")).toBe(true);
      expect(existsSync(tempConfig.configFile)).toBe(true);
      expect(getCurrentProjectId()).toBe("new-project");
    });

    it("should update existing project ID", () => {
      createMockConfigFile(tempConfig, "old-project");
      expect(setProjectId("new-project")).toBe(true);
      expect(getCurrentProjectId()).toBe("new-project");
    });

    it("should preserve other config data", () => {
      createMockConfigFile(tempConfig, "old-project");
      setProjectId("new-project");
      const data = JSON.parse(readFileSync(tempConfig.configFile, "utf-8"));
      expect(data["$schema"]).toBe("https://opencode.ai/config.json");
      expect(data.plugin).toContain("opencode-gemini-auth-swap@latest");
    });
  });

  describe("listProfiles", () => {
    it("should return empty array when no profiles exist", () => {
      expect(listProfiles()).toEqual([]);
    });

    it("should return saved profiles", () => {
      const store = {
        version: 1,
        profiles: [
          { name: "work", refreshToken: "t1", projectId: "p1", createdAt: 1 },
          { name: "personal", refreshToken: "t2", projectId: "p2", createdAt: 2 },
        ],
      };
      saveProfilesStore(store);
      const profiles = listProfiles();
      expect(profiles).toHaveLength(2);
      expect(profiles[0]?.name).toBe("work");
      expect(profiles[1]?.name).toBe("personal");
    });
  });

  describe("saveProfile", () => {
    it("should fail when no refresh token exists", () => {
      const result = saveProfile("test", "project-123");
      expect(result.success).toBe(false);
      expect(result.message).toContain("No active OAuth session");
    });

    it("should fail when no project ID provided and none in config", () => {
      createMockAccountsFile(tempConfig, "token-123");
      const result = saveProfile("test");
      expect(result.success).toBe(false);
      expect(result.message).toContain("No project ID found");
    });

    it("should save profile with explicit project ID", () => {
      createMockAccountsFile(tempConfig, "token-123");
      const result = saveProfile("work", "my-project");
      expect(result.success).toBe(true);
      expect(result.profile?.name).toBe("work");
      expect(result.profile?.projectId).toBe("my-project");
      expect(result.profile?.refreshToken).toBe("token-123");
    });

    it("should use project ID from config if not provided", () => {
      createMockAccountsFile(tempConfig, "token-123");
      createMockConfigFile(tempConfig, "config-project");
      const result = saveProfile("work");
      expect(result.success).toBe(true);
      expect(result.profile?.projectId).toBe("config-project");
    });

    it("should set active profile after saving", () => {
      createMockAccountsFile(tempConfig, "token-123");
      saveProfile("work", "project");
      expect(getActiveProfileName()).toBe("work");
    });

    it("should update existing profile", () => {
      createMockAccountsFile(tempConfig, "token-1");
      saveProfile("work", "project-1");
      const firstCreatedAt = getProfile("work")?.createdAt;

      createMockAccountsFile(tempConfig, "token-2");
      saveProfile("work", "project-2");

      const profile = getProfile("work");
      expect(profile?.refreshToken).toBe("token-2");
      expect(profile?.projectId).toBe("project-2");
      expect(profile?.createdAt).toBe(firstCreatedAt); // Should preserve original createdAt
    });

    it("should add multiple profiles", () => {
      createMockAccountsFile(tempConfig, "token-1");
      saveProfile("work", "project-1");

      createMockAccountsFile(tempConfig, "token-2");
      saveProfile("personal", "project-2");

      expect(listProfiles()).toHaveLength(2);
    });
  });

  describe("getProfile", () => {
    it("should return undefined for non-existent profile", () => {
      expect(getProfile("nonexistent")).toBeUndefined();
    });

    it("should return profile by name", () => {
      createMockAccountsFile(tempConfig, "token");
      saveProfile("work", "project");
      const profile = getProfile("work");
      expect(profile?.name).toBe("work");
      expect(profile?.projectId).toBe("project");
    });
  });

  describe("useProfile", () => {
    it("should fail for non-existent profile", () => {
      const result = useProfile("nonexistent");
      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });

    it("should list available profiles in error message", () => {
      createMockAccountsFile(tempConfig, "token");
      saveProfile("work", "project");
      const result = useProfile("nonexistent");
      expect(result.message).toContain("work");
    });

    it("should switch to profile and update files", () => {
      // Save first profile
      createMockAccountsFile(tempConfig, "token-1");
      createMockConfigFile(tempConfig, "project-1");
      saveProfile("work", "project-1");

      // Save second profile
      createMockAccountsFile(tempConfig, "token-2");
      saveProfile("personal", "project-2");

      // Switch back to first profile
      const result = useProfile("work");
      expect(result.success).toBe(true);
      expect(getCurrentRefreshToken()).toBe("token-1");
      expect(getCurrentProjectId()).toBe("project-1");
    });

    it("should update active profile name", () => {
      createMockAccountsFile(tempConfig, "token");
      saveProfile("work", "project");
      saveProfile("personal", "project-2");

      useProfile("work");
      expect(getActiveProfileName()).toBe("work");

      useProfile("personal");
      expect(getActiveProfileName()).toBe("personal");
    });

    it("should update lastUsed timestamp", async () => {
      createMockAccountsFile(tempConfig, "token");
      saveProfile("work", "project");

      const before = getProfile("work")?.lastUsed ?? 0;

      // Wait a tiny bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      useProfile("work");
      const after = getProfile("work")?.lastUsed ?? 0;

      expect(after).toBeGreaterThanOrEqual(before);
    });

    it("should correctly switch between multiple existing accounts", () => {
      // 1. Create an accounts file with two accounts
      const accountsData = {
        version: 3,
        accounts: [
          { refreshToken: "token-work", addedAt: 1, lastUsed: 1, rateLimitResetTimes: {} },
          { refreshToken: "token-personal", addedAt: 1, lastUsed: 1, rateLimitResetTimes: {} },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      };
      writeFileSync(tempConfig.accountsFile, JSON.stringify(accountsData));
    
      // 2. Save two profiles, one for each token
      saveProfile("work", "project-work");
      // Manually set the refresh token for the second profile since saveProfile would overwrite it
      const store = loadProfilesStore();
      store.profiles.push({
        name: "personal",
        refreshToken: "token-personal",
        projectId: "project-personal",
        createdAt: Date.now(),
        lastUsed: Date.now(),
      });
      saveProfilesStore(store);
    
    
      // 3. Use the "personal" profile
      useProfile("personal");
    
      // 4. Verify that the activeIndex in antigravity-accounts.json is 0 and personal token is first
      let accounts = JSON.parse(readFileSync(tempConfig.accountsFile, "utf-8"));
      expect(accounts.activeIndex).toBe(0);
      expect(accounts.accounts[0].refreshToken).toBe("token-personal");
      expect(accounts.activeIndexByFamily.gemini).toBe(0);
      expect(getCurrentRefreshToken()).toBe("token-personal");
    
      // 5. Use the "work" profile
      useProfile("work");
    
      // 6. Verify that the activeIndex in antigravity-accounts.json is 0 and work token is first
      accounts = JSON.parse(readFileSync(tempConfig.accountsFile, "utf-8"));
      expect(accounts.activeIndex).toBe(0);
      expect(accounts.accounts[0].refreshToken).toBe("token-work");
      expect(accounts.activeIndexByFamily.gemini).toBe(0);
      expect(getCurrentRefreshToken()).toBe("token-work");
    });
  });

  describe("deleteProfile", () => {
    it("should fail for non-existent profile", () => {
      const result = deleteProfile("nonexistent");
      expect(result.success).toBe(false);
      expect(result.message).toContain("not found");
    });

    it("should delete profile", () => {
      createMockAccountsFile(tempConfig, "token");
      saveProfile("work", "project");
      expect(listProfiles()).toHaveLength(1);

      const result = deleteProfile("work");
      expect(result.success).toBe(true);
      expect(result.profile?.name).toBe("work");
      expect(listProfiles()).toHaveLength(0);
    });

    it("should clear active profile if deleted", () => {
      createMockAccountsFile(tempConfig, "token");
      saveProfile("work", "project");
      expect(getActiveProfileName()).toBe("work");

      deleteProfile("work");
      expect(getActiveProfileName()).toBeUndefined();
    });

    it("should not affect other profiles", () => {
      createMockAccountsFile(tempConfig, "token-1");
      saveProfile("work", "project-1");

      createMockAccountsFile(tempConfig, "token-2");
      saveProfile("personal", "project-2");

      deleteProfile("work");

      expect(listProfiles()).toHaveLength(1);
      expect(getProfile("personal")).toBeDefined();
    });
  });

  describe("currentInfo", () => {
    it("should return undefined values when nothing configured", () => {
      const info = currentInfo();
      expect(info.refreshToken).toBeUndefined();
      expect(info.projectId).toBeUndefined();
      expect(info.activeProfile).toBeUndefined();
    });

    it("should return current configuration", () => {
      createMockAccountsFile(tempConfig, "token-12345678901234567890-rest");
      createMockConfigFile(tempConfig, "my-project");
      saveProfile("work", "my-project");

      const info = currentInfo();
      // refreshToken is truncated to first 20 chars + "..."
      expect(info.refreshToken).toBe("token-12345678901234...");
      expect(info.projectId).toBe("my-project");
      expect(info.activeProfile).toBe("work");
    });
  });

  describe("loadProfilesStore / saveProfilesStore", () => {
    it("should return empty store when file does not exist", () => {
      const store = loadProfilesStore();
      expect(store.version).toBe(1);
      expect(store.profiles).toEqual([]);
    });

    it("should save and load profiles", () => {
      const store = {
        version: 1,
        profiles: [
          { name: "test", refreshToken: "t", projectId: "p", createdAt: 123 },
        ],
        activeProfile: "test",
      };
      saveProfilesStore(store);

      const loaded = loadProfilesStore();
      expect(loaded.version).toBe(1);
      expect(loaded.profiles).toHaveLength(1);
      expect(loaded.profiles[0]?.name).toBe("test");
      expect(loaded.activeProfile).toBe("test");
    });

    it("should handle corrupted JSON gracefully", () => {
      writeFileSync(tempConfig.profilesFile, "corrupted");
      const store = loadProfilesStore();
      expect(store.profiles).toEqual([]);
    });
  });

  describe("integration: full workflow", () => {
    it("should support complete multi-account workflow", () => {
      // Setup account 1
      createMockAccountsFile(tempConfig, "refresh-token-account1");
      createMockConfigFile(tempConfig, "project-account1");

      // Save as profile 1
      let result = saveProfile("account1");
      expect(result.success).toBe(true);

      // Simulate login with account 2
      createMockAccountsFile(tempConfig, "refresh-token-account2");

      // Save as profile 2
      result = saveProfile("account2", "project-account2");
      expect(result.success).toBe(true);

      // Verify both profiles exist
      expect(listProfiles()).toHaveLength(2);
      expect(getActiveProfileName()).toBe("account2");

      // Switch to account 1
      result = useProfile("account1");
      expect(result.success).toBe(true);
      expect(getCurrentRefreshToken()).toBe("refresh-token-account1");
      expect(getCurrentProjectId()).toBe("project-account1");
      expect(getActiveProfileName()).toBe("account1");

      // Switch back to account 2
      result = useProfile("account2");
      expect(result.success).toBe(true);
      expect(getCurrentRefreshToken()).toBe("refresh-token-account2");
      expect(getCurrentProjectId()).toBe("project-account2");
      expect(getActiveProfileName()).toBe("account2");

      // Delete account 1
      result = deleteProfile("account1");
      expect(result.success).toBe(true);
      expect(listProfiles()).toHaveLength(1);

      // account2 should still be active
      expect(getActiveProfileName()).toBe("account2");
    });
  });
});
