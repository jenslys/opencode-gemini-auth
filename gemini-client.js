import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Constants ---
const CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

// --- Headers ---
const HEADERS = {
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

/**
 * Retrieves Opencode credentials from the local filesystem.
 * @returns {{refreshToken: string, projectId: string} | null}
 */
export function getCredentials() {
    const homeDir = os.homedir();
    // Path for Linux/macOS
    let authPath = path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');

    // Check Windows path if not found
    if (!fs.existsSync(authPath) && os.platform() === 'win32') {
         authPath = path.join(process.env.USERPROFILE || homeDir, '.local', 'share', 'opencode', 'auth.json');
    }

    if (!fs.existsSync(authPath)) {
        console.warn(`Auth file not found at: ${authPath}`);
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        // The plugin uses provider ID 'google'
        if (data.google && data.google.refresh) {
            // Format: refreshToken|projectId|managedProjectId
            const parts = data.google.refresh.split('|');
            return {
                refreshToken: parts[0],
                projectId: parts[1] || ''
            };
        }
    } catch (error) {
        console.error("Error reading auth file:", error);
    }
    return null;
}

/**
 * Exchanges a refresh token for a short-lived access token.
 * @param {string} refreshToken
 * @returns {Promise<string|null>} The access token or null if failed.
 */
export async function refreshAccessToken(refreshToken) {
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('refresh_token', refreshToken);
    params.append('grant_type', 'refresh_token');

    try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params
        });

        if (!response.ok) {
            const text = await response.text();
            console.error("Failed to refresh token:", text);
            return null;
        }

        const json = await response.json();
        return json.access_token;
    } catch (error) {
        console.error("Network error during token refresh:", error);
        return null;
    }
}

/**
 * Generates content using the hijacked Gemini session.
 * @param {string} accessToken - Valid Google Cloud access token.
 * @param {string} projectId - Google Cloud Project ID (from auth file).
 * @param {string} textPrompt - The prompt to send.
 * @param {string|null} imagePath - Optional path to an image file.
 * @returns {Promise<string>} The generated text response.
 */
export async function generateContent(accessToken, projectId, textPrompt, imagePath = null) {
    // The internal endpoint used by the plugin
    const url = "https://cloudcode-pa.googleapis.com/v1internal:generateContent";

    // Construct the parts array
    const parts = [{ text: textPrompt }];

    if (imagePath) {
        try {
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            // Basic mime type detection
            const ext = path.extname(imagePath).toLowerCase();
            let mimeType = 'image/jpeg';
            if (ext === '.png') mimeType = 'image/png';
            if (ext === '.webp') mimeType = 'image/webp';

            parts.push({
                inlineData: {
                    mimeType: mimeType,
                    data: base64Image
                }
            });
        } catch (err) {
            console.error(`Error reading image file: ${err.message}`);
            throw err;
        }
    }

    const requestBody = {
        project: projectId,
        model: "gemini-pro-vision", // Or "gemini-1.5-pro-preview-0409"
        request: {
            contents: [{
                role: "user",
                parts: parts
            }],
            generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 2048
            }
        }
    };

    const headers = {
        ...HEADERS,
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
    };

    const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error ${response.status}: ${text}`);
    }

    const json = await response.json();

    // Parse response
    if (json.candidates && json.candidates.length > 0) {
        const content = json.candidates[0].content;
        if (content && content.parts && content.parts.length > 0) {
            return content.parts[0].text;
        }
    }

    throw new Error("No candidates returned: " + JSON.stringify(json));
}

// --- Default Helper Class for easier import ---
export class GeminiSession {
    constructor() {
        this.creds = null;
        this.accessToken = null;
    }

    async init() {
        this.creds = getCredentials();
        if (!this.creds) {
            throw new Error("Opencode credentials not found. Please run `opencode auth login`.");
        }
        this.accessToken = await refreshAccessToken(this.creds.refreshToken);
        if (!this.accessToken) {
            throw new Error("Failed to refresh access token.");
        }
    }

    async chat(prompt, imagePath = null) {
        if (!this.accessToken) await this.init();
        // Auto-refresh logic could be added here if token expires
        return generateContent(this.accessToken, this.creds.projectId, prompt, imagePath);
    }
}
