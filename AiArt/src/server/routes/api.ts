import express from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
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
        console.log("🔍 Fetching recent events from Gemini...");
        const prompt = "List 3 current trending topics or recent events happening in the world right now. Keep each item to one short phrase.";

        const authClient = await auth.getClient();
        const accessToken = await authClient.getAccessToken();

        if (!accessToken.token) {
            console.warn("⚠️ No access token available for Gemini");
            return ["current global events", "technological advances", "environmental changes"];
        }

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

        console.log("📤 Sending request to Gemini API...");
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`⚠️ Gemini API failed: ${response.status} - ${errorText}`);
            return ["current global events", "technological advances", "environmental changes"];
        }

        const result = await response.json();
        console.log("📥 Gemini API response:", JSON.stringify(result, null, 2));

        const content = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        if (!content) {
            console.warn("⚠️ No content in Gemini response");
            return ["current global events", "technological advances", "environmental changes"];
        }

        const events = content
            .split(/\d+\.|•|-/)
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 5)
            .slice(0, 3);

        console.log("✅ Parsed events from Gemini:", events);
        return events.length > 0 ? events : ["current global events", "technological advances", "environmental changes"];
    } catch (error) {
        console.warn("⚠️ Gemini news fallback due to error:", error);
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
    console.log(`🔧 NEW PREPROCESSOR: "${raw}" with lastSearch: "${lastSearch}"`);

    const sanitized = sanitize(raw);
    const cleanedSearch = sanitize(lastSearch);

    console.log(`🧹 NEW Sanitized prompt: "${sanitized}"`);
    console.log(`🧹 NEW Sanitized lastSearch: "${cleanedSearch}"`);

    let finalPrompt: string;

    if (cleanedSearch && cleanedSearch.length > 3) {
        finalPrompt = `A detailed pencil drawing of ${sanitized} and ${cleanedSearch}. High contrast black and white sketch, no background.`;
    } else {
        finalPrompt = `A detailed pencil drawing of ${sanitized}. High contrast black and white sketch, no background.`;
    }

    console.log(`🎨 NEW Final processed prompt: "${finalPrompt}"`);

    return finalPrompt;
}


async function generateImageWithVertexAI(prompt: string, lastSearch: string): Promise<{ base64: string; localPath: string; finalPrompt: string }> {
    const finalPrompt = await preprocessPrompt(prompt, lastSearch);
    console.log(`🎨 Generating image for prompt: "${finalPrompt}"`);

    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();
    if (!accessToken.token) throw new Error("Failed to get access token");

    // Use the working model only
    const models = [
        {
            name: "imagegeneration@006",
            endpoint: `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration@006:predict`
        }
    ];

    for (const model of models) {
        try {
            console.log(`📤 Trying model: ${model.name}`);

            const requestBody = {
                instances: [{
                    prompt: finalPrompt
                }],
                parameters: {
                    sampleCount: 1,
                    aspectRatio: "1:1",
                    safetyFilterLevel: "block_few",
                    personGeneration: "allow_adult"
                }
            };

            const response = await fetch(model.endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.warn(`⚠️ Model ${model.name} failed: ${response.status} - ${errorText}`);
            } else {
                const data = await response.json();
                console.log(`🔍 Response from ${model.name}:`, JSON.stringify(data, null, 2));

                // Check if we have predictions at all
                if (!data.predictions || !Array.isArray(data.predictions) || data.predictions.length === 0) {
                    console.warn(`⚠️ No predictions from ${model.name}:`, data);
                } else {
                    const prediction = data.predictions[0];
                    console.log("🔍 Prediction object:", JSON.stringify(prediction, null, 2));

                    // Check if prediction is empty or null
                    if (!prediction || typeof prediction !== 'object') {
                        console.warn(`⚠️ Invalid prediction from ${model.name}:`, prediction);
                    } else {
                        // Try different possible response structures for different model versions
                        let base64Image =
                            prediction.bytesBase64Encoded ||
                            prediction.image?.bytesBase64Encoded ||
                            prediction.generatedImage?.bytesBase64Encoded ||
                            prediction.images?.[0]?.bytesBase64Encoded ||
                            prediction.artifacts?.[0]?.base64 ||
                            prediction.generated_images?.[0]?.bytes_base64_encoded ||
                            prediction.encodedImage ||
                            prediction.image ||
                            prediction.data;

                        if (base64Image) {
                            console.log(`✅ Successfully got image from ${model.name}`);
                            const buffer = Buffer.from(base64Image, "base64");
                            const filename = `${uuid()}.png`;
                            const localPath = path.join(imagesDir, filename);
                            fs.writeFileSync(localPath, buffer);

                            return { base64: base64Image, localPath, finalPrompt };
                        } else {
                            const availableKeys = Object.keys(prediction).join(', ');
                            console.warn(`⚠️ No image data from ${model.name}. Available keys: ${availableKeys}`);
                        }
                    }
                }
            }

        } catch (error) {
            console.warn(`⚠️ Error with model ${model.name}:`, error);
        }
    }

    // If we get here, all models failed
    throw new Error("All Vertex AI models failed to generate an image. Check the console logs for details.");
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
