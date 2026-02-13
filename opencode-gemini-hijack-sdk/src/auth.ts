import fs from 'fs';
import path from 'path';
import os from 'os';

// Constants
export const CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
export const CLIENT_SECRET = "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";

// Headers
export const HEADERS = {
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

/**
 * Retrieves Opencode credentials from the local filesystem.
 */
export function getCredentials() {
    const homeDir = os.homedir();
    let authPath = path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');

    if (!fs.existsSync(authPath) && os.platform() === 'win32') {
         authPath = path.join(process.env.USERPROFILE || homeDir, '.local', 'share', 'opencode', 'auth.json');
    }

    if (!fs.existsSync(authPath)) {
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        if (data.google && data.google.refresh) {
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
 */
export async function refreshAccessToken(refreshToken: string): Promise<string | null> {
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
            return null;
        }

        const json = await response.json();
        return json.access_token;
    } catch (error) {
        return null;
    }
}
