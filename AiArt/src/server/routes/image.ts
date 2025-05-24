/**
 * /image/:id — full-screen single piece view
 */
import express from "express";
import { pool } from "../../config/database";

const router = express.Router();
const BUCKET = process.env.GCS_BUCKET!;

router.get("/image/:id", async (req, res, next) => {
    try {
        const { rows } = await pool.query<
            { id: number; prompt: string; gcs_path: string; model: string; created_at: Date }
        >(
            `SELECT * FROM images WHERE id = $1 LIMIT 1`,
            [req.params.id]
        );

        if (!rows.length) {
            res.status(404).render("404", { title: "Not found" });
            return;
        }

        const r = rows[0];
        const piece = {
            ...r,
            publicUrl: `https://storage.googleapis.com/${BUCKET}/${r.gcs_path}`
        };

        res.render("image", { title: piece.prompt.slice(0, 40), piece });
    } catch (err) { next(err); }
});

export default router;
