# Gemini OAuth Plugin for Opencode (with Account Swap)

![License](https://img.shields.io/npm/l/opencode-gemini-auth-swap)

**Authenticate the Opencode CLI with your Google account + easily swap between multiple accounts.**

This is a professional-grade fork of [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) that adds robust multi-account profile management. Use your existing Gemini plan and quotas (including the free tier) directly within Opencode, and switch between different Google accounts/projects with a single command.

## Key Features

- **Multi-Account Support**: Save and switch between an unlimited number of Google accounts.
- **Project Isolation**: Bind specific Google Cloud Project IDs to individual profiles.
- **Smart Account Management**: Automatically handles account rotation and ensures the active account is correctly prioritized for the Opencode agent.
- **Thinking Model Support**: Full configuration support for Gemini 2.5 and 3 "thinking" models.
- **Headless Friendly**: Fallback authentication methods for remote/SSH environments.

## Installation

### 1. Configure Opencode
Add the plugin to your Opencode configuration file (`~/.config/opencode/config.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth-swap@latest"]
}
```

### 2. Install the Swap CLI
Install the management tool globally to enable easy profile switching:

```bash
# Using Bun (Recommended)
bun install -g opencode-gemini-auth-swap

# Or using NPM
npm install -g opencode-gemini-auth-swap
```

## Setup & Account Swapping

### The Workflow

1. **Login with Account A**:
   ```bash
   opencode auth login
   # Choose Google > OAuth with Google (Gemini CLI)
   ```

2. **Save as Profile**:
   ```bash
   gemini-swap save work my-work-project-id
   ```

3. **Login with Account B**:
   ```bash
   opencode auth login
   ```

4. **Save as another Profile**:
   ```bash
   gemini-swap save personal my-personal-project-id
   ```

5. **Switch anytime**:
   ```bash
   gemini-swap use work
   # Your Opencode agent now uses the 'work' credentials and project.
   ```

### CLI Reference

| Command | Description |
| --- | --- |
| `gemini-swap list` | List all saved profiles and show which one is active. |
| `gemini-swap use <name>` | Switch to a saved profile (updates tokens and project ID). |
| `gemini-swap save <name> [projectId]` | Save current session as a named profile. |
| `gemini-swap current` | Display the active profile and current token/project details. |
| `gemini-swap delete <name>` | Remove a saved profile. |

## Model Configuration

### Thinking Models
You can configure "thinking" budgets and levels in your `config.json`:

```json
{
  "provider": {
    "google": {
      "models": {
        "gemini-3-pro-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        },
        "gemini-2.5-flash": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        }
      }
    }
  }
}
```

## Troubleshooting

### Changes not taking effect?
The Opencode agent often caches credentials in memory. If you switch profiles and don't see the change in your agent's behavior:
1.  Close your current Opencode session.
2.  Restart the agent (or your editor/terminal if integrated).

### Manual Google Cloud Setup
If automatic provisioning fails:
1.  Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  Enable the **Gemini for Google Cloud API** (`cloudaicompanion.googleapis.com`).
3.  Ensure your `projectId` is correctly set in your profile via `gemini-swap save <name> <projectId>`.

## Development

```bash
git clone https://github.com/h1n054ur/opencode-gemini-auth-swap.git
cd opencode-gemini-auth-swap
bun install
bun test
```

## Credits

Original plugin by [jenslys](https://github.com/jenslys). Multi-account logic and CLI by [h1n054ur](https://github.com/h1n054ur).

## License

MIT - see [LICENSE](LICENSE)
