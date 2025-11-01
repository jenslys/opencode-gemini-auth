# Gemini OAuth Plugin for Opencode

Authenticate the Opencode CLI with your Google account so you can use your existing Gemini plan and its included quota instead of API billing.

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

The plugin spins up a local callback listener, so after approving in the browser you'll land on an "Authentication complete" page with no URL copy/paste required. If that port is already taken, the CLI automatically falls back to the classic copy/paste flow and explains what to do.
