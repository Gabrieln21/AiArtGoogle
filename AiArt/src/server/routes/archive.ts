/**
 * /archive — paged gallery of every image
 */
import express from "express";
import { pool } from "../../config/database";

const router = express.Router();
const BUCKET = process.env.GCS_BUCKET!;

// GET /archive?page=2
router.get("/archive", async (req, res, next) => {
    try {
        const page  = Math.max(parseInt(String(req.query.page || "1"), 10), 1);
        const limit = 30;
        const offset = (page - 1) * limit;

        const { rows } = await pool.query<
            { id: number; prompt: string; gcs_path: string }
        >(
            `SELECT id, prompt, gcs_path
             FROM images
             ORDER BY created_at DESC
                 LIMIT $1
             OFFSET $2`,
            [limit + 1, offset] // fetch one extra to check “hasMore”
        );

        const hasMore = rows.length > limit;
        const images = rows.slice(0, limit).map(r => ({
            ...r,
            publicUrl: `https://storage.googleapis.com/${BUCKET}/${r.gcs_path}`
        }));

        res.render("archive", {
            title:   "Archive",
            route:   "archive", // 👈 this is what's missing in some views
            images,
            hasMore,
            nextPage: page + 1
        });
    } catch (err) {
        next(err);
    }
});

export default router;
