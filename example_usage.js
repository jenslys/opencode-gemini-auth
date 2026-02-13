import { GeminiSession } from './gemini-client.js';

async function main() {
    const gemini = new GeminiSession();

    try {
        console.log("Initializing Gemini Session...");
        await gemini.init();

        // 1. Text Prompt
        console.log("\n--- Sending Text Prompt ---");
        const response = await gemini.chat("What is the capital of France?");
        console.log("Gemini:", response);

        // 2. Image Prompt (Optional)
        const imagePath = process.argv[2];
        if (imagePath) {
            console.log(`\n--- Sending Image Prompt (${imagePath}) ---`);
            const imageResponse = await gemini.chat("Describe this image.", imagePath);
            console.log("Gemini Vision:", imageResponse);
        }

    } catch (error) {
        console.error("Error:", error.message);
    }
}

main();
