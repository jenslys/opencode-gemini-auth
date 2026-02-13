# Opencode Gemini Session Hijacking Guide

This guide explains how to leverage the authentication session from the Opencode plugin to make requests to Gemini models (including Pro subscription quotas) from your own scripts.

## Is this risky? Will I get flagged?

### Risk Analysis
*   **Low Risk**: You are using your own legitimate Google account and credentials that you have already authorized.
*   **No "Hacking" Involved**: You are simply re-using a refresh token stored on your own local disk. This is standard behavior for many CLI tools.
*   **Quota Limits**: You are still bound by the quotas of your account. If you spam requests, you will hit rate limits (429 errors) just like you would using the plugin normally.

### Mitigation
*   **Do not share your `auth.json` file.** It contains your refresh token, which provides long-term access to your account.
*   **Mimicry**: The script provided (`gemini-client.js`) exactly mimics the headers and endpoint used by the official plugin. To Google's servers, your script looks identical to the Opencode CLI plugin.

## How it Works

The Opencode plugin does not use the public `generativelanguage.googleapis.com` API key flow. Instead, it uses:
1.  **Internal Endpoint**: `https://cloudcode-pa.googleapis.com/v1internal:generateContent`
2.  **OAuth 2.0**: It uses a refresh token to get a short-lived access token.
3.  **Client Masquerading**: It sends specific headers (`X-Goog-Api-Client`, `Client-Metadata`) to identify itself as an IDE plugin.

Our script (`gemini-client.js`) replicates this entire flow:
1.  Reads `~/.local/share/opencode/auth.json` to find your `refresh_token` and `project_id`.
2.  Exchanges the refresh token for a Bearer token.
3.  Constructs a request with the exact same internal JSON structure and headers.

## Installation & Usage

### 1. Prerequisites
*   Node.js installed.
*   **Opencode CLI installed and authenticated** (`opencode auth login`).

### 2. The Module (`gemini-client.js`)
This file exports a simple class `GeminiSession` that handles all the complexity.

```javascript
import { GeminiSession } from './gemini-client.js';

const session = new GeminiSession();
await session.init(); // Loads creds from disk and refreshes token

const answer = await session.chat("Hello, Gemini!");
console.log(answer);
```

### 3. Running the Example
We have included a ready-to-run example script.

**Text Only:**
```bash
node example_usage.js
```

**With Image:**
```bash
node example_usage.js /path/to/my/image.png
```

## Integration into Your Projects

To use this in your own personal project:

1.  Copy `gemini-client.js` into your project folder.
2.  Import it:
    ```javascript
    import { GeminiSession } from './gemini-client.js';
    ```
3.  Ensure your project allows ESM imports (add `"type": "module"` to your `package.json`).

### Example: A Simple CLI Tool
Create a file `ask-gemini.js`:

```javascript
import { GeminiSession } from './gemini-client.js';

const prompt = process.argv[2] || "Tell me a joke";
const session = new GeminiSession();

(async () => {
    try {
        await session.init();
        console.log("Thinking...");
        const response = await session.chat(prompt);
        console.log("\n" + response);
    } catch (e) {
        console.error("Error:", e.message);
    }
})();
```

Run it:
```bash
node ask-gemini.js "Explain quantum computing in 5 words"
```
