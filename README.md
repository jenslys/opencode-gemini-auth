# Gemini OAuth Plugin for Opencode

Authenticate the Opencode CLI with your Google account so you can use your
existing Gemini plan and its included quota instead of API billing.

## Setup

1. Add the plugin to your [Opencode config](https://opencode.ai/docs/config/):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-gemini-auth"]
   }
   ```

2. Run `opencode auth login`.
3. Choose the Google provider and select **OAuth with Google (Gemini CLI)**.

The plugin spins up a local callback listener, so after approving in the
browser you'll land on an "Authentication complete" page with no URL
copy/paste required. If that port is already taken, the CLI automatically
falls back to the classic copy/paste flow and explains what to do.

## Updating

> [!WARNING]
> OpenCode does NOT auto-update plugins

To get the latest version:

```bash
(cd ~ && sed -i.bak '/"opencode-gemini-auth"/d' .cache/opencode/package.json && \
rm -rf .cache/opencode/node_modules/opencode-gemini-auth && \
echo "Plugin update script finished successfully.")
```

```bash
opencode  # Reinstalls latest
```

## Local Development

First, clone the repository and install dependencies:

```bash
git clone https://github.com/jenslys/opencode-gemini-auth.git
cd opencode-gemini-auth
bun install
```

When you want Opencode to use a local checkout of this plugin, point the
`plugin` entry in your config to the folder via a `file://` URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-gemini-auth"]
}
```

Replace `/absolute/path/to/opencode-gemini-auth` with the absolute path to
your local clone.

## Manual Google Cloud Setup

If automatic provisioning fails, use the console:

1. Go to the Google Cloud Console and create (or select) a project, e.g. `gemini`.
2. Select that project.
3. Enable the **Gemini for Google Cloud API** (`cloudaicompanion.googleapis.com`).
4. Re-run `opencode auth login` and enter the project **ID** (not the display name).

## Debugging Gemini Requests

Set `OPENCODE_GEMINI_DEBUG=1` in the environment when you run an Opencode
command to capture every Gemini request/response that this plugin issues. When
enabled, the plugin writes to a timestamped `gemini-debug-<ISO>.log` file in
your current working directory so the CLI output stays clean.

```bash
OPENCODE_GEMINI_DEBUG=1 opencode
```

The logger shows the transformed URL, HTTP method, sanitized headers (the
`Authorization` header is redacted), whether the call used streaming, and a
truncated preview (2 KB) of both the request and response bodies. This is handy
when diagnosing "Bad Request" responses from Gemini. Remember that payloads may
still include parts of your prompt or response, so only enable this flag when
you're comfortable keeping that information in the generated log file.

**404s on `gemini-2.5-flash-image`.** Opencode fires internal
summarization/title requests at `gemini-2.5-flash-image`. The plugin
automatically remaps those payloads to `gemini-2.5-flash`, eliminating the extra
404s for accounts without image access. If you still see a 404, confirm your
project actually has access to the fallback model.
