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

function preprocessPrompt(raw: string): string {
    const sanitized = raw
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

    return `high contrast pencil or charcoal drawing, no background, hyper-focused on: ${sanitized}`;
}

async function generateImageWithVertexAI(prompt: string): Promise<{ base64: string; localPath: string; finalPrompt: string }> {
    const finalPrompt = preprocessPrompt(prompt);
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
        throw new Error(`Vertex AI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const prediction = data.predictions?.[0];
    const base64Image = prediction?.bytesBase64Encoded;
    if (!base64Image) throw new Error("No image data in Vertex AI response");

    const buffer = Buffer.from(base64Image, "base64");
    const filename = `${uuid()}.png`;
    const localPath = path.join(imagesDir, filename);
    fs.writeFileSync(localPath, buffer);

    return { base64: base64Image, localPath, finalPrompt };
}

router.post("/generate", upload.none(), async (req, res): Promise<void> => {
    try {
        const prompt = req.body.prompt?.trim();
        if (!prompt) {
            res.status(400).json({ error: "prompt required" });
            return;
        }

        const { base64, localPath, finalPrompt } = await generateImageWithVertexAI(prompt);

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
