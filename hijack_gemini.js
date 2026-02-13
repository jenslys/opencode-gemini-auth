import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Constants from src/constants.ts ---
const CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

// --- Headers from src/constants.ts and src/plugin/request.ts ---
const HEADERS = {
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

// --- Helper to read auth file ---
function getCredentials() {
    const homeDir = os.homedir();
    // Path for Linux/macOS
    let authPath = path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');

    // Check Windows path if not found
    if (!fs.existsSync(authPath) && os.platform() === 'win32') {
         authPath = path.join(process.env.USERPROFILE || homeDir, '.local', 'share', 'opencode', 'auth.json');
    }

    if (!fs.existsSync(authPath)) {
        console.error(`Auth file not found at: ${authPath}`);
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

// --- Refresh Access Token ---
async function refreshAccessToken(refreshToken) {
    console.log("Refreshing Access Token...");
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('refresh_token', refreshToken);
    params.append('grant_type', 'refresh_token');

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
}

// --- Make Gemini Request ---
async function generateContent(accessToken, projectId, textPrompt, imagePath = null) {
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
            console.log(`Included image: ${imagePath} (${mimeType})`);
        } catch (err) {
            console.error(`Error reading image file: ${err.message}`);
        }
    }

    const requestBody = {
        project: projectId, // This ensures it hits your specific project (Pro tier)
        model: "gemini-pro-vision" || "gemini-1.5-pro-preview-0409", // Or just 'gemini-pro' for text
        // Note: The plugin maps "gemini-2.5-flash-image" -> "gemini-2.5-flash" internally.
        // For simplicity we use a known model name that supports vision if image is present.
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

    console.log(`\nSending request to Cloud Code API (Project: ${projectId})...`);

    const response = await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const text = await response.text();
        console.error(`Error ${response.status}: ${text}`);
        return;
    }

    const json = await response.json();

    // Parse response
    if (json.candidates && json.candidates.length > 0) {
        const content = json.candidates[0].content;
        if (content && content.parts && content.parts.length > 0) {
            console.log("\n--- Gemini Response ---");
            console.log(content.parts[0].text);
            return;
        }
    }

    console.log("Full Response:", JSON.stringify(json, null, 2));
}

// --- Main Execution ---
async function main() {
    const creds = getCredentials();
    if (!creds) {
        console.log("Could not find Opencode credentials. Run 'opencode auth login' first.");
        return;
    }

    const accessToken = await refreshAccessToken(creds.refreshToken);
    if (!accessToken) return;

    // Example 1: Text only
    // await generateContent(accessToken, creds.projectId, "Hello! Are you aware you are running outside of the plugin?");

    // Example 2: With Image
    // Replace 'example_image.png' with a real path to test
    const imageFile = process.argv[2];
    if (imageFile) {
        await generateContent(accessToken, creds.projectId, "Describe this image in detail.", imageFile);
    } else {
        await generateContent(accessToken, creds.projectId, "Write a haiku about hacking code.");
    }
}

main();
