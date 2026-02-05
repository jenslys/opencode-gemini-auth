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
(`~/.config/opencode/opencode.json` or similar):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth@latest"]
}
```

> [!IMPORTANT]
> If you're using a paid Gemini Code Assist subscription (Standard/Enterprise),
> explicitly configure a Google Cloud `projectId`. Free tier accounts should
> auto-provision a managed project, but you can still set `projectId` to force
> a specific project.

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
     you can manually paste the callback URL or just the authorization code.

Once authenticated, Opencode will use your Google account for Gemini requests.

## Configuration

### Google Cloud Project

By default, the plugin attempts to provision or find a suitable Google Cloud
project. To force a specific project, set the `projectId` in your configuration
or via environment variables:

**File:** `~/.config/opencode/opencode.json`

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

You can also set `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or
`GOOGLE_CLOUD_PROJECT_ID` to supply the project ID via environment variables.

### Model list

Below are example model entries you can add under `provider.google.models` in your
Opencode config. Each model can include an `options.thinkingConfig` block to
enable "thinking" features.

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
        },
        "gemini-2.5-pro": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        },
        "gemini-3-flash-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        },
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

Note: Available model names and previews may change—check Google's documentation or
the Gemini product page for the current model identifiers.

### Thinking Models

The plugin supports configuring Gemini "thinking" features per-model via
`thinkingConfig`. The available fields depend on the model family:

- For Gemini 3 models: use `thinkingLevel` with values `"low"` or `"high"`.
- For Gemini 2.5 models: use `thinkingBudget` (token count).
- `includeThoughts` (boolean) controls whether the model emits internal thoughts.

A combined example showing both model types:

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

If you don't set a `thinkingConfig` for a model, the plugin will use default
behavior for that model.

## Troubleshooting

### Manual Google Cloud Setup

If automatic provisioning fails, you may need to set up the project manually:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **Gemini for Google Cloud API**
   (`cloudaicompanion.googleapis.com`).
4. Configure the `projectId` in your Opencode config as shown above.

### Quotas, Plans, and 429 Errors

Common causes of `429 RESOURCE_EXHAUSTED` or `QUOTA_EXHAUSTED`:

- **No project ID configured**: the plugin uses a managed free-tier project, which has lower quotas.
- **Model-specific limits**: quotas are tracked per model (e.g., `gemini-3-pro-preview` vs `gemini-3-flash-preview`).
- **Large prompts**: OAuth/Code Assist does not support cached content, so long system prompts and history can burn quota quickly.
- **Parallel sessions**: multiple Opencode windows can drain the same bucket.

Notes:

- **Gemini CLI auto-fallbacks**: the official CLI may fall back to Flash when Pro quotas are exhausted, so it can appear to “work” even if the Pro bucket is depleted.
- **Paid plans still require a project**: to use paid quotas in Opencode, set `provider.google.options.projectId` (or `OPENCODE_GEMINI_PROJECT_ID`) and re-authenticate.

### Debugging

To view detailed logs of Gemini requests and responses, set the
`OPENCODE_GEMINI_DEBUG` environment variable:

```bash
OPENCODE_GEMINI_DEBUG=1 opencode
```

This will generate `gemini-debug-<timestamp>.log` files in your working
directory containing sanitized request/response details.

## Parity Notes

This plugin mirrors the official Gemini CLI OAuth flow and Code Assist
endpoints. In particular, project onboarding and quota retry handling follow
the same behavior patterns as the Gemini CLI.

### References

- Gemini CLI repository: https://github.com/google-gemini/gemini-cli
- Gemini CLI quota documentation: https://developers.google.com/gemini-code-assist/resources/quotas

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
