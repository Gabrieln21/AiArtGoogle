import express from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { GoogleAuth } from "google-auth-library";
import { ImagesService } from "../../services/images.service";
import { pool } from "../../config/database"; // for manual SQL delete
import sharp from "sharp";
import type {
    Request as ExpressRequest,
    Response as ExpressResponse,
    NextFunction
} from "express";

// directly after your imports in src/server/routes/api.ts
import pLimit from "p-limit";

// --- Global generation tokens (DB-backed) to cap cross-process concurrency ---
const GEN_TOKENS_TIMEOUT_SEC = parseInt(process.env.GEN_TOKENS_TIMEOUT_SEC || "120", 10); // reclaim stuck > 120s

async function claimGenToken(worker: string): Promise<number> {
    const sql = `
    WITH c AS (
      SELECT id
      FROM gen_tokens
      WHERE in_use = false
         OR (in_use = true AND taken_at < now() - interval '${GEN_TOKENS_TIMEOUT_SEC} seconds')
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE gen_tokens g
      SET in_use = true, taken_by = $1, taken_at = now()
    FROM c
    WHERE g.id = c.id
    RETURNING g.id;
  `;
    const { rows } = await pool.query(sql, [worker]);
    if (!rows.length) throw new Error("no-generation-token-available");
    return rows[0].id as number;
}

async function releaseGenToken(id: number): Promise<void> {
    await pool.query(
        "UPDATE gen_tokens SET in_use=false, taken_by=NULL, taken_at=NULL WHERE id=$1",
        [id]
    );
}

// --- Generic exponential backoff with jitter for transient failures ---
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function isTransientStatus(status: number) {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
function looksTransientErrorBody(body: any): boolean {
    const s = typeof body === "string" ? body : JSON.stringify(body || {});
    return /quota|rate|exceed|throttle|temporar|backend|unavailable|timeout/i.test(s);
}

async function fetchJSONWithBackoff(
    url: string,
    init: globalThis.RequestInit,
    opts: { tries?: number; baseDelayMs?: number; maxDelayMs?: number } = {}
): Promise<{ ok: boolean; status: number; json: any }> {
    const tries = opts.tries ?? 5;
    const base = opts.baseDelayMs ?? 350;
    const maxD  = opts.maxDelayMs ?? 4000;

    for (let i = 0; i < tries; i++) {
        let resp: globalThis.Response | null = null;
        try {
            // 60s timeout per call
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 60_000);
            resp = await fetch(url, { ...init, signal: ctrl.signal });
            clearTimeout(t);

            const textBody = await resp.text();
            const json = textBody ? JSON.parse(textBody) : {};
            if (resp.ok) return { ok: true, status: resp.status, json };

            const transient = isTransientStatus(resp.status) || looksTransientErrorBody(json);
            if (!transient || i === tries - 1) return { ok: false, status: resp.status, json };

            const delay = Math.min(maxD, base * (2 ** i)) + Math.floor(Math.random() * 200);
            await sleep(delay);
            continue;
        } catch (err: any) {
            const isAbort = String(err?.name || "").toLowerCase().includes("abort");
            const lastTry = i === tries - 1;
            const delay   = Math.min(maxD, base * (2 ** i)) + Math.floor(Math.random() * 200);
            if (isAbort && !lastTry) { await sleep(delay); continue; }
            if (lastTry) throw err;
            await sleep(delay);
        }
    }

    return { ok: false, status: 0, json: { error: "exhausted-retries" } };
}



const GEN_LIMIT = parseInt(process.env.GEN_LIMIT || "4", 10);
// p-limit queues promises beyond the concurrency; no 429s, just waits.
const genLimiter = pLimit(GEN_LIMIT);


const router = express.Router();
const upload = multer({ dest: "/tmp" });

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

async function verifyInclusionWithGemini(base64Png: string, items: string[]): Promise<boolean> {
    // Ask Gemini Vision to caption/describe and confirm all items appear.
    // We only send a short yes/no-like result to keep it cheap/fast.
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return true; // Skip verification if no key

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${apiKey}`;
    const checkerPrompt = `
    Given the image, answer with ONLY "PASS" or "FAIL".
    PASS if the scene clearly includes ALL of: ${items.map(s => `"${s}"`).join(", ")}.
    FAIL if any item is missing or looks unrelated/separate/collage-like.
    `.trim();

    const requestBody = {
        contents: [{
            parts: [
                { text: checkerPrompt },
                {
                    inline_data: {
                        mime_type: "image/png",
                        data: base64Png
                    }
                }
            ]
        }]
    };

    const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
    const j = await r.json();
    const verdict = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
    return verdict === "PASS";
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
        Reword the following image generation prompt that failed with Vertex AI so it succeeds (Return only ONE rewritten prompt under 50 words. No explanations.)
        
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

function sanitize(text: string): string {
    return text;
}

async function composeCohesivePrompt(main: string, lastSearch: string, event: string): Promise<string> {
    // Turn 3 inputs into ONE fused scene (foreground + action + setting) in ≤45 words.
    const apiKey = process.env.GEMINI_API_KEY;
    const combined = `${main} | ${lastSearch || "personal search idea"} | ${event}`.slice(0, 300);

    if (!apiKey) {
        // Safe local fallback if no Gemini key
        return `A single cohesive scene that blends ${main}, ${lastSearch || "a personal idea"}, and ${event}.`;
    }

    const system = `
    You are an expert prompt-writer for Google Imagen black-and-white etching/ink style.
    Return exactly ONE sentence (< 45 words) describing a SINGLE cohesive scene (foreground/action/background)
    that naturally integrates all three elements provided. Avoid lists, quotes, and collage language.
    White background, minimal linework, no shading, no halftone.
    IMAGE **MUST HAVE 70% WHITE SPACE** 
    IMAGE **MUST HAVE LITTLE TO NO SOLID BLACK**
    `.trim();

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent?key=${apiKey}`;
    const requestBody = {
        contents: [{ parts: [{ text: `${system}\n\nElements: ${combined}` }] }]
    };

    const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
    const j = await r.json();
    return j.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        || `A single cohesive scene that blends ${main}, ${lastSearch || "a personal idea"}, and ${event}.`;
}

type PreprocessOut = { finalPrompt: string; fused: string; event: string };

async function preprocessPrompt(
    raw: string,
    lastSearch: string = "",
    eventOverride?: string
): Promise<PreprocessOut> {
    const main = sanitize(raw);
    const ls = sanitize(lastSearch || "");
    const event = eventOverride ?? await getRelevantEventFromGemini(main, ls);
    const fused = await composeCohesivePrompt(main, ls, event);

    const finalPrompt = [
        "Style: stark black-and-white line art, etching/ink pen only, white background.",
        "No grayscale, no halftone, no gradients.",
        `Scene: ${fused}`
    ].join(" ");

    return { finalPrompt, fused, event };
}



// Convert any image buffer to pure black/white (no grayscale) for jelly-plate printing.
async function toPureBlackWhite(
    buffer: Buffer,
    manualThreshold?: number // allow override with env BW_THRESHOLD
): Promise<Buffer> {
    // Begin in grayscale
    const base = sharp(buffer).grayscale();

    // Analyze image stats to choose a solid threshold (mean + fraction of stdev)
    const stats = await base.stats();
    const ch = stats.channels[0]; // luminance channel
    const autoT = Math.round(
        Math.max(40, Math.min(220, ch.mean + 0.5 * ch.stdev))
    );
    const t = Number.isFinite(manualThreshold!) ? manualThreshold! : autoT;

    // Normalize dynamic range, gently sharpen edges, then binarize
    return await base
        .normalize()         // stretch levels (auto-contrast)
        .sharpen(0.5, 1, 0)  // subtle edge definition without halos
        .threshold(t)        // strictly 0 or 255 — no gray pixels
        .toFormat("png")
        .toBuffer();
}


async function generateImageWithVertexAI(
    prompt: string,
    lastSearch: string,
    retryCount = 0,
    eventOverride?: string
): Promise<{ base64: string; localPath: string; finalPrompt: string; event: string }> {

    const { finalPrompt, event } = await preprocessPrompt(prompt, lastSearch, eventOverride);
    console.log(`🎨 Generating image (attempt ${retryCount + 1}): "${finalPrompt}"`);

    const MODEL = process.env.IMAGEN_MODEL || "imagen-3.0-generate-002";
    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();
    if (!accessToken.token) throw new Error("Failed to get access token");

    // Acquire a global token to limit cross-process concurrency (released in finally)
    const tokenId = await claimGenToken(`api:${process.pid}`);
    try {
        const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

        // Default sampleCount, but shed load under pressure
        const defaultSamples = Number(process.env.SAMPLE_COUNT || 3);
        const pending = (genLimiter as any).pendingCount ?? 0;
        const active  = (genLimiter as any).activeCount  ?? 0;
        const sampleCount = (pending + active) > 2 ? 1 : defaultSamples;

        const parameters: Record<string, any> = {
            sampleCount,
            aspectRatio: "1:1",
            personGeneration: "allow_adult",
            safetySetting: "block_only_high",
            language: "en",
            enhancePrompt: true
        };
        if (MODEL.startsWith("imagegeneration@")) {
            parameters.negativePrompt =
                "separate panels, collage, split composition, isolated icons, text captions, grayscale, halftone, gradients, missing any required element";
        }
        if (process.env.SEED) {
            parameters.addWatermark = false;
            parameters.seed = Number(process.env.SEED);
        }

        const requestBody = { instances: [{ prompt: finalPrompt }], parameters };

        const { ok, status, json } = await fetchJSONWithBackoff(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody)
        }, { tries: 5, baseDelayMs: 400, maxDelayMs: 5000 });

        if (!ok) {
            // If the backend signaled transient issues, let the outer retry loop handle it
            console.warn(`Vertex call failed (status=${status})`, json?.error || json);
            if (retryCount < 2) {
                const rewordedPrompt = await rewordAfterFailureWithGemini(finalPrompt);
                console.log("🔁 Retrying with reworded prompt (after HTTP failure):", rewordedPrompt);
                return await generateImageWithVertexAI(rewordedPrompt, lastSearch, retryCount + 1, event);
            }
            throw new Error(`Vertex predict failed (status=${status})`);
        }

        const data = json;
        const preds = Array.isArray(data.predictions) ? data.predictions : [];
        const candidates = preds
            .map((p: any) => p?.bytesBase64Encoded)
            .filter((b64: any) => typeof b64 === "string" && b64.length > 0);

        if (!candidates.length) {
            console.warn("⚠️ No image data in response body.", data?.error || "");
            if (retryCount < 2) {
                const rewordedPrompt = await rewordAfterFailureWithGemini(finalPrompt);
                console.log("🔁 Retrying with reworded prompt (no predictions):", rewordedPrompt);
                return await generateImageWithVertexAI(rewordedPrompt, lastSearch, retryCount + 1, event);
            }
            throw new Error(`No image data in Vertex AI response after ${retryCount + 1} attempts.`);
        }

        if (!candidates.length) {
            console.warn("⚠️ No image data in response.", data?.error || "");
            if (retryCount < 2) {
                const rewordedPrompt = await rewordAfterFailureWithGemini(finalPrompt);
                console.log("🔁 Retrying with reworded prompt:", rewordedPrompt);
                return await generateImageWithVertexAI(rewordedPrompt, lastSearch, retryCount + 1, event);
            }
            throw new Error(`No image data in Vertex AI response after ${retryCount + 1} attempts.`);
        }

        const items = [sanitize(prompt), sanitize(lastSearch || "personal idea"), event];

        let chosenBase64 = candidates[0];
        for (const b64 of candidates) {
            const ok = await verifyInclusionWithGemini(b64, items);
            if (ok) { chosenBase64 = b64; break; }
        }

        const buffer = Buffer.from(chosenBase64, "base64");
        const manualT = process.env.BW_THRESHOLD ? parseInt(process.env.BW_THRESHOLD, 10) : undefined;
        const bwBuffer = await toPureBlackWhite(buffer, manualT);

        const filename = `${uuid()}.png`;
        const localPath = path.join(imagesDir, filename);
        fs.writeFileSync(localPath, bwBuffer);

        return { base64: chosenBase64, localPath, finalPrompt, event };
    } finally {
        try { await releaseGenToken(tokenId); } catch {}
    }
}




router.post("/generate", upload.none(), async (req, res): Promise<void> => {
    try {
        const prompt = req.body.prompt?.trim();
        const lastSearch = req.body.lastSearch?.trim();
        if (!prompt) {
            res.status(400).json({ error: "prompt required" });
            return;
        }

        const { base64, localPath, finalPrompt, event } =
            await genLimiter(() => generateImageWithVertexAI(prompt, lastSearch));

        const objectName = path.basename(localPath);

        const userId = (req.session as any)?.user?.id ?? null;

        // Build the caption shown under the image (all three items, no AI fused prompt)
        const mainText = String(req.body.prompt ?? "").trim();
        const searchText = String(req.body.lastSearch ?? "").trim();
        const displayCaption = [mainText, searchText, event].filter(Boolean).join(" • ");

        const rec = await ImagesService.create(displayCaption, objectName, "vertex/imagen", userId);

        console.log(`✅ Image generated and saved: ${objectName}`);
        res.status(201).json({
            ...rec,
            url: `/images/${objectName}`,
            localPath: `/images/${objectName}`,
            // Explicitly include prompt for front-end convenience
            prompt: displayCaption,
            displayCaption,
            inputs: { main: mainText, lastSearch: searchText, event }
        });



    } catch (err: any) {
        console.error("❌ Image generation error:", err);
        res.status(500).json({ error: err.message || "Image generation failed" });
    }
});

router.get(
    "/preview",
    async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
        try {
            const imgUrl = String(req.query.url || "");

            const t = req.query.threshold ? parseInt(String(req.query.threshold), 10) : undefined;

            if (!imgUrl) {
                res.status(400).send("url required");
                return;
            }

            // Fetch the source image (works for your own /images/... URLs)
            const resp = await fetch(imgUrl);
            if (!resp.ok) {
                res.status(400).send("failed to fetch image");
                return;
            }

            const buf = Buffer.from(await resp.arrayBuffer());
            const out = await toPureBlackWhite(buf, t);

            res.setHeader("Content-Type", "image/png");
            res.send(out);
            return;
        } catch (e: any) {
            console.error("preview error", e);
            res.status(500).send("error");
            return;
        }
    }
);

// Users click “Request Print” in the modal -> enqueue (idempotent while inflight)
router.post("/print/:imageId", async (req, res): Promise<void> => {
    try {
        const imageId = parseInt(req.params.imageId, 10);
        if (Number.isNaN(imageId)) {
            res.status(400).json({ error: "invalid image id" }); return;
        }

        const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
            || req.socket.remoteAddress || null;
        const copies = Math.max(1, Math.min(5, parseInt(String(req.body?.copies ?? "1"), 10) || 1));
        const media  = String(req.body?.media ?? process.env.PRINT_MEDIA ?? "Letter");

        // Ensure image exists (optional safety)
        const { rows: imgRows } = await pool.query(
            "SELECT id FROM images WHERE id = $1 LIMIT 1", [imageId]
        );
        if (imgRows.length === 0) { res.status(404).json({ error: "image not found" }); return; }

        // Idempotent enqueue while a job is queued/printing for this image (requires partial unique index from migration)
        const { rows } = await pool.query(`
            WITH ins AS (
            INSERT INTO print_jobs(image_id, copies, media, requester_ip)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (image_id) WHERE (status IN ('queued','printing')) DO NOTHING
                RETURNING *
                )
            SELECT * FROM ins
            UNION ALL
            SELECT * FROM print_jobs
            WHERE image_id = $1 AND status IN ('queued','printing')
            ORDER BY created_at ASC
                LIMIT 1
        `, [imageId, copies, media, ip]);

        res.status(201).json({ ok: true, job: rows[0] });
    } catch (e:any) {
        console.error("enqueue error", e);
        res.status(500).json({ error: e.message || "failed to enqueue" });
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

// --- Simple admin gate (set ADMIN_KEY in env) ---
function adminGate(req: express.Request, res: express.Response, next: NextFunction) {
    const key = (req.header('x-admin-key') || String(req.query.key || '')).trim();
    if (!process.env.ADMIN_KEY || key === process.env.ADMIN_KEY) return next();
    res.status(401).send('Unauthorized');
}

// --- Admin: Print Queue ---
// --- Admin: Print Queue ---
router.get('/admin/prints', adminGate, async (req, res) => {
    const { rows } = await pool.query(`
        SELECT
            pj.id,
            pj.status,
            pj.copies,
            pj.media,
            pj.created_at,
            pj.started_at,
            pj.finished_at,
            pj.error,
            i.id                AS image_id,
            i.prompt            AS caption,
            i.gcs_path,
            ('/images/' || i.gcs_path) AS public_url
        FROM print_jobs pj
                 JOIN images i ON i.id = pj.image_id
        ORDER BY
            CASE pj.status
                WHEN 'queued'   THEN 0
                WHEN 'printing' THEN 1
                WHEN 'error'    THEN 2
                WHEN 'done'     THEN 3
                ELSE 4
                END,
            pj.created_at ASC
    `);

    const adminKey = String(req.query.key || req.header('x-admin-key') || '');

    res.render('admin_prints', {
        jobs: rows,
        layout: 'partials/_layout',
        title: 'Print Queue',
        route: '',
        adminKey
    });
});


router.post('/admin/prints/:id/done', adminGate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await pool.query(
        "UPDATE print_jobs SET status='done', finished_at=now(), error=NULL WHERE id=$1",
        [id]
    );
    // stay under /api and preserve ?key=...
    res.redirect(`/api/admin/prints?key=${encodeURIComponent(String(req.query.key || ''))}`);
});

router.post('/admin/prints/:id/requeue', adminGate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await pool.query(
        "UPDATE print_jobs SET status='queued', started_at=NULL, worker_id=NULL, error=NULL WHERE id=$1",
        [id]
    );
    // stay under /api and preserve ?key=...
    res.redirect(`/api/admin/prints?key=${encodeURIComponent(String(req.query.key || ''))}`);
});

router.post('/admin/prints/:id/delete', adminGate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await pool.query("DELETE FROM print_jobs WHERE id=$1", [id]);
    // stay under /api and preserve ?key=...
    res.redirect(`/api/admin/prints?key=${encodeURIComponent(String(req.query.key || ''))}`);
});



export default router;

