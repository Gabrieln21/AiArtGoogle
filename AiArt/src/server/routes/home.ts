import express from "express";
import { pool } from "../../config/database";
import path from "path";
import fs from "fs/promises";

const router = express.Router();
const BUCKET = process.env.GCS_BUCKET!;
const localImagesPath = path.join(__dirname, "../../../images");

router.get("/", async (_req, res, next): Promise<void> => {
    try {
        // Read most recent 50 images that actually exist in local folder
        const { rows } = await pool.query(
            `SELECT id, prompt, gcs_path, created_at
             FROM images
             ORDER BY created_at DESC
                 LIMIT 50`
        );

        const filteredImages = await Promise.all(
            rows.map(async (r) => {
                const fullPath = path.join(localImagesPath, r.gcs_path);
                try {
                    await fs.stat(fullPath); // check file exists
                    return {
                        ...r,
                        publicUrl: `/images/${r.gcs_path}`
                    };
                } catch {
                    return null;
                }
            })
        );

        const images = filteredImages.filter(Boolean);

        res.render("home", { title: "Home", route: "home", images });
    } catch (err) {
        next(err);
    }
});

// routes/archive.ts
router.get("/archive", async (_req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, prompt, gcs_path, created_at
             FROM images
             ORDER BY created_at DESC`
        );
        const images = rows.map(r => ({
            ...r,
            publicUrl: `https://storage.googleapis.com/${process.env.GCS_BUCKET}/${r.gcs_path}`
        }));
        res.render("archive", { title: "Archive", images });
    } catch (err) { next(err); }
});

// routes/image.ts
router.get("/image/:id", async (req, res, next) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM images WHERE id = $1`, [req.params.id]);
        if (!rows.length) return res.status(404).render("404");
        const r = rows[0];
        res.render("image", {
            title: r.prompt.slice(0, 40),
            piece: {
                ...r,
                publicUrl: `https://storage.googleapis.com/${process.env.GCS_BUCKET}/${r.gcs_path}`
            }
        });
    } catch (err) { next(err); }
});

export default router;
