import { generateText, streamText } from 'ai';
import { opencodeGemini } from '../src/index.js';

async function main() {
    console.log("--- TEST 1: generateText ---");
    try {
        const { text, usage } = await generateText({
            model: opencodeGemini,
            prompt: "Explain quantum computing in 10 words.",
        });
        console.log("Result:", text);
        console.log("Usage:", usage);
    } catch (e) {
        console.error("Generate failed:", e);
    }

    console.log("\n--- TEST 2: streamText ---");
    try {
        const { textStream } = await streamText({
            model: opencodeGemini,
            prompt: "Write a short poem about hacking.",
        });

        for await (const chunk of textStream) {
            process.stdout.write(chunk);
        }
        console.log("\n--- Stream Finished ---");
    } catch (e) {
        console.error("Stream failed:", e);
    }
}

main();
