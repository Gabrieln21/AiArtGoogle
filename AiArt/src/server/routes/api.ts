import express from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import { ImagesService } from "../../services/images.service";
import fs from "fs";
import path from "path";
import { pool } from "../../config/database"; // ✅ Required for manual SQL delete

const router = express.Router();
const upload = multer({ dest: "/tmp" });

const storage = new Storage();
const bucket = storage.bucket(process.env.GCS_BUCKET!);

const imagesDir = path.join(__dirname, "../../../images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);
router.use("/images", express.static(imagesDir));

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "mom-mural-dev";
const LOCATION = "us-central1";

const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

console.log(`🔧 Initialized Vertex AI for project: ${PROJECT_ID}`);

async function getRelevantEventFromGemini(prompt: string, lastSearch: string): Promise<string> {
    try {
        console.log("🔍 Getting relevant 2025 issue from Gemini...");

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.log("⚠️ No Gemini API key found, using fallback");
            return "climate change impact";
        }

        const combined = `${prompt} ${lastSearch}`.trim().slice(0, 500);
        const input = `
        Given the following creative input: "${combined}",
        identify a real, widely-known global issue, environmental trend, or technological breakthrough occurring in 2025.
        Your answer must:
        - Be an actual, verifiable phenomenon.
        - Be concise (3–5 words).
        - Avoid fictional or speculative ideas like "AI-brewed tea" or vague concepts like "innovation."
        Just return the phrase with no explanation.
        `;

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${apiKey}`;
        const requestBody = {
            contents: [{ parts: [{ text: input }] }]
        };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.log(`⚠️ Gemini API failed: ${response.status} - ${errorText}`);
            return "climate change impact";
        }

        const data = await response.json();
        const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!result || result.length > 50) {
            console.log("⚠️ No usable Gemini result, falling back");
            return "climate change impact";
        }

        console.log("✅ Gemini selected real-world topic:", result);
        return result;

    } catch (error) {
        console.log("⚠️ Gemini API error:", error);
        return "climate change impact";
    }
}



async function rewordAfterFailureWithGemini(text: string): Promise<string> {
    try {
        console.log("🔍 Rewording with Gemini...");

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.log("⚠️ No Gemini API key found, using fallback event");
            return "Failed to reword";
        }

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${apiKey}`;

        const prompt = `
            Reword the following image generation prompt so that it does not fail with Vertex AI and produces a usable, creative image.
            - Only return one single rewritten prompt.
            - Do NOT include explanations, options, or rationale.
            - Keep the rewritten prompt under 50 words.
            - Avoid inappropriate, banned, or overly complex terms.
            - Speak directly to the AI image model.

            Original Prompt:
            ${text}
        `.trim();

        const requestBody = {
            contents: [{
                parts: [{ text: prompt }]
            }]
        };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.log(`⚠️ Gemini API failed: ${response.status} - ${errorText}`);
            return "Failed to reword";
        }

        const data = await response.json();
        const reworded = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!reworded) {
            console.log("⚠️ No usable content returned from Gemini.");
            return "Failed to reword";
        }

        console.log("✅ Gemini reworded prompt:", reworded);
        return reworded;

    } catch (error) {
        console.log("⚠️ Gemini API error:", error);
        return "Failed to reword";
    }
}


/*
function sanitize(text: string): string {
    return text
        .replace(/\b(kill|death|weapon|gun|knife|sword|violence|blood|gore)\b/gi, "")
        .replace(/\b(nude|naked|sexual|explicit)\b/gi, "")
        .replace(/\b(drug|cocaine|marijuana|alcohol)\b/gi, "")
        .replace(/\b(hate|racist|nazi|terrorist)\b/gi, "")
        .replace(/\briding\b/gi, "traveling on")
        .replace(/\bworm\b/gi, "earthworm creature")
        .replace(/\bshot\b/gi, "photograph")
        .replace(/\bfire\b/gi, "flame")
        .replace(/\bbomb\b/gi, "explosion")
        .replace(/\bwar\b/gi, "conflict")
        .replace(/\bdead\b/gi, "still")
        .replace(/\bmurder\b/gi, "mystery")
        .replace(/\bkilling\b/gi, "stopping")
        .replace(/\s+/g, " ")
        .trim();
}
 */
function sanitize(text: string): string {
    return text
}

async function preprocessPrompt(raw: string, lastSearch: string = ""): Promise<string> {
    const sanitized = sanitize(raw);
    const cleanedSearch = sanitize(lastSearch);
    const event = await getRelevantEventFromGemini(sanitized, cleanedSearch);


    // New phrasing for creativity and blending
    return `
        Create a surreal, high contrast pencil drawing that blends these ideas into one unified, imaginative concept:
        1. ${sanitized}
        2. ${cleanedSearch || "a personal search idea"}
        3. ${event}
        The result should be one wild visual composition where all elements fuse into a single scene or subject. No background. Hyper-focused composition.
    `.trim().replace(/\s+/g, " "); // compact it to a clean one-line prompt
}


async function generateImageWithVertexAI(
    prompt: string,
    lastSearch: string,
    retryCount = 0
): Promise<{ base64: string; localPath: string; finalPrompt: string }> {
    let finalPrompt = await preprocessPrompt(prompt, lastSearch);
    console.log(`🎨 Generating image for prompt (attempt ${retryCount + 1}): "${finalPrompt}"`);

    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();
    if (!accessToken.token) throw new Error("Failed to get access token");

    const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration@006:predict`;

    const requestBody = {
        instances: [{ prompt: finalPrompt }],
        parameters: {
            sampleCount: 1,
            aspectRatio: "1:1",
            safetyFilterLevel: "block_few",
            personGeneration: "allow_adult"
        }
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    const prediction = data.predictions?.[0];
    const base64Image = prediction?.bytesBase64Encoded;

    if (!base64Image) {
        console.warn(`⚠️ No image data in response. Available keys: ${prediction ? Object.keys(prediction).join(", ") : "no prediction object"}`);

        if (retryCount < 2) {
            const rewordedPrompt = await rewordAfterFailureWithGemini(finalPrompt);
            console.log("🔁 Retrying with reworded prompt:", rewordedPrompt);
            return await generateImageWithVertexAI(rewordedPrompt, lastSearch, retryCount + 1);
        }

        throw new Error(`No image data in Vertex AI response after ${retryCount + 1} attempts.`);
    }

    const buffer = Buffer.from(base64Image, "base64");
    const filename = `${uuid()}.png`;
    const localPath = path.join(imagesDir, filename);
    fs.writeFileSync(localPath, buffer);

    return { base64: base64Image, localPath, finalPrompt };
}


router.post("/generate", upload.none(), async (req, res): Promise<void> => {
    try {
        const prompt = req.body.prompt?.trim();
        const lastSearch = req.body.lastSearch?.trim();
        if (!prompt) {
            res.status(400).json({ error: "prompt required" });
            return;
        }

        const { base64, localPath, finalPrompt } = await generateImageWithVertexAI(prompt, lastSearch);

        const buffer = Buffer.from(base64, "base64");
        const objectName = path.basename(localPath);
        const file = bucket.file(objectName);
        await file.save(buffer, { contentType: "image/png" });
        const [url] = await file.getSignedUrl({ action: "read", expires: Date.now() + 6.048e8 });

        const userId = (req.session as any)?.user?.id ?? null;
        const rec = await ImagesService.create(finalPrompt, objectName, "vertex/imagen", userId);

        console.log(`✅ Image generated and saved: ${objectName}`);
        res.status(201).json({ ...rec, url, localPath: `/images/${objectName}` });
    } catch (err: any) {
        console.error("❌ Image generation error:", err);
        res.status(500).json({ error: err.message || "Image generation failed" });
    }
});

router.delete("/images/:id", async (req: express.Request, res: express.Response): Promise<void> => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
        res.status(400).json({ error: "Invalid image ID" });
        return;
    }

    try {
        const success = await ImagesService.remove(id);
        if (success) {
            res.status(200).json({ message: "Image deleted" });
        } else {
            res.status(404).json({ error: "Image not found" });
        }
    } catch (err) {
        console.error("❌ Failed to delete image:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});


export default router;
