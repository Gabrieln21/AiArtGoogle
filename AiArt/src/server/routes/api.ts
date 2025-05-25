import express from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import { pool } from "../../config/database";
import { ImagesService } from "../../services/images.service";
import fs from "fs";
import path from "path";

const router = express.Router();
const upload = multer({ dest: "/tmp" });

// 🔗 Google Cloud setup
const storage = new Storage();
const bucket = storage.bucket(process.env.GCS_BUCKET!);

// Serve local /images folder statically
const imagesDir = path.join(__dirname, "../../../images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);
router.use("/images", express.static(imagesDir));

// Vertex AI configuration
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "mom-mural-dev";
const LOCATION = "us-central1";

// Initialize Google Auth
const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

console.log(`🔧 Initialized Vertex AI for project: ${PROJECT_ID}`);

async function getRecentEventsFromGemini(): Promise<string[]> {
    try {
        const prompt = "List 3 current trending topics or recent events happening in the world right now. Keep each item to one short phrase.";

        const authClient = await auth.getClient();
        const accessToken = await authClient.getAccessToken();

        // Use the newer Gemini model endpoint
        const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/gemini-1.5-flash:generateContent`;

        const requestBody = {
            contents: [{
                role: "user",
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.4,
                maxOutputTokens: 200
            }
        };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            console.warn(`⚠️ Gemini API failed: ${response.status}`);
            return ["current global events", "technological advances", "environmental changes"];
        }

        const result = await response.json();
        const content = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        if (!content) {
            return ["current global events", "technological advances", "environmental changes"];
        }

        return content
            .split(/\d+\.|•|-/)
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 5)
            .slice(0, 3);
    } catch (error) {
        console.warn("⚠️ Gemini news fallback:", error);
        return ["current global events", "technological advances", "environmental changes"];
    }
}

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

async function preprocessPrompt(raw: string, lastSearch: string = ""): Promise<string> {
    const sanitized = sanitize(raw);
    const cleanedSearch = sanitize(lastSearch);
    const news = await getRecentEventsFromGemini();
    console.log("📨 Gemini news output:", news);

    const randomEvent = news.length
        ? news[Math.floor(Math.random() * news.length)]
        : "recent global events like economic shifts or climate activity";


    return `A detailed drawing of ${sanitized}, inspired by "${cleanedSearch}" and influenced by ${randomEvent}. Render in high contrast pencil or charcoal, no background, hyper-focused.`;
}


async function generateImageWithVertexAI(prompt: string, lastSearch: string): Promise<{ base64: string; localPath: string; finalPrompt: string }> {
    const finalPrompt = await preprocessPrompt(prompt, lastSearch);
    console.log(`🎨 Generating image for prompt: "${finalPrompt}"`);

    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();
    if (!accessToken.token) throw new Error("Failed to get access token");

    const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration@005:predict`;

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

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Vertex AI API error: ${response.status} - ${errorText}`);
        throw new Error(`Vertex AI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log("🔍 Full Vertex AI response:", JSON.stringify(data, null, 2));

    const prediction = data.predictions?.[0];
    console.log("🔍 Prediction object:", JSON.stringify(prediction, null, 2));

    // Try different possible response structures
    let base64Image = prediction?.bytesBase64Encoded ||
                     prediction?.image?.bytesBase64Encoded ||
                     prediction?.generatedImage?.bytesBase64Encoded ||
                     prediction?.images?.[0]?.bytesBase64Encoded;

    if (!base64Image) {
        console.error("❌ No image data found in response structure:", prediction);
        throw new Error(`No image data in Vertex AI response. Available keys: ${Object.keys(prediction || {}).join(', ')}`);
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
        return;
    } catch (err: any) {
        console.error("❌ Image generation error:", err);
        res.status(500).json({ error: err.message || "Image generation failed" });
        return;
    }
});

export default router;
