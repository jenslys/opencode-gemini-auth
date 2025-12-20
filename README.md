# Gemini OAuth Plugin for Opencode

![License](https://img.shields.io/npm/l/opencode-gemini-auth)
![Version](https://img.shields.io/npm/v/opencode-gemini-auth)

**Authenticate the Opencode CLI with your Google account.** This plugin enables
you to use your existing Gemini plan and quotas (including the free tier)
directly within Opencode, bypassing separate API billing.

## Prerequisites

- [Opencode CLI](https://opencode.ai) installed.
- A Google account with access to Gemini.

## Installation

Add the plugin to your Opencode configuration file
(`~/.config/opencode/config.json` or similar):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth@latest"]
}
```

## Usage

1. **Login**: Run the authentication command in your terminal:

   ```bash
   opencode auth login
   ```

2. **Select Provider**: Choose **Google** from the list.
3. **Authenticate**: Select **OAuth with Google (Gemini CLI)**.
   - A browser window will open for you to approve the access.
   - The plugin spins up a temporary local server to capture the callback.
   - If the local server fails (e.g., port in use or headless environment),
     you can manually copy/paste the callback URL as instructed.

Once authenticated, Opencode will use your Google account for Gemini requests.

## Configuration

### Google Cloud Project

By default, the plugin attempts to provision or find a suitable Google Cloud
project. To force a specific project, set the `projectId` in your configuration:

```json
{
  "provider": {
    "google": {
      "options": {
        "projectId": "your-specific-project-id"
      }
    }
  }
}
```

### Thinking Models

Configure "thinking" capabilities for Gemini models using the `thinkingConfig`
option in your `config.json`.

**Gemini 3 (Thinking Level)**
Use `thinkingLevel` (`"low"`, `"high"`) for Gemini 3 models.

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
        }
      }
    }
  }
}
```

**Gemini 2.5 (Thinking Budget)**
Use `thinkingBudget` (token count) for Gemini 2.5 models.

```json
{
  "provider": {
    "google": {
      "models": {
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

### Manual Google Cloud Setup

If automatic provisioning fails, you may need to set up the project manually:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **Gemini for Google Cloud API**
   (`cloudaicompanion.googleapis.com`).
4. Configure the `projectId` in your Opencode config as shown above.

### Debugging

To view detailed logs of Gemini requests and responses, set the
`OPENCODE_GEMINI_DEBUG` environment variable:

```bash
OPENCODE_GEMINI_DEBUG=1 opencode
```

This will generate `gemini-debug-<timestamp>.log` files in your working
directory containing sanitized request/response details.

### Updating

Opencode does not automatically update plugins. To update to the latest version,
you must clear the cached plugin:

```bash
# Clear the specific plugin cache
rm -rf ~/.cache/opencode/node_modules/opencode-gemini-auth

# Run Opencode to trigger a fresh install
opencode
```

## Development

To develop on this plugin locally:

1. **Clone**:

   ```bash
   git clone https://github.com/jenslys/opencode-gemini-auth.git
   cd opencode-gemini-auth
   bun install
   ```

2. **Link**:
   Update your Opencode config to point to your local directory using a
   `file://` URL:

   ```json
   {
     "plugin": ["file:///absolute/path/to/opencode-gemini-auth"]
   }
   ```

## License

MIT
