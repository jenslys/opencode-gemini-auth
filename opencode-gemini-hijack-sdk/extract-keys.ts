#!/usr/bin/env node
import { getCredentials, refreshAccessToken } from './src/auth.js';

async function main() {
    console.log("Locating Opencode Google Auth credentials...");
    const creds = getCredentials();

    if (!creds) {
        console.error("No credentials found. Have you run 'opencode auth login'?");
        process.exit(1);
    }

    console.log(`Found credentials for Project ID: ${creds.projectId || '(implicit)'}`);
    console.log("Refreshing Access Token...");

    const accessToken = await refreshAccessToken(creds.refreshToken);
    if (!accessToken) {
        console.error("Failed to refresh access token.");
        process.exit(1);
    }

    console.log("\n--- EXTRACTED KEYS ---");
    console.log(`Project ID:   ${creds.projectId}`);
    console.log(`Access Token: ${accessToken}`);
    console.log("----------------------");
    console.log("You can use this Access Token in Authorization header: `Bearer <token>`");
    console.log("Endpoint: https://cloudcode-pa.googleapis.com/v1internal:generateContent");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
