import express from "express";
import { ImagesService } from "../../services/images.service";
import path from "path";
import fs from "fs/promises";

const router = express.Router();
const localImagesPath = path.join(__dirname, "../../../images");

// ---------- Home ----------
router.get("/", async (_req, res, next): Promise<void> => {
    try {
        // Use ImagesService abstraction to keep consistency
        const rows = await ImagesService.listRecent(50);

        const filteredImages = await Promise.all(
            rows.map(async (r) => {
                const fullPath = path.join(localImagesPath, r.gcs_path);
                try {
                    await fs.stat(fullPath); // Confirm file exists locally
                    return {
                        ...r,
                        publicUrl: `/images/${r.gcs_path}`
                    };
                } catch {
                    return null; // Skip if file missing
                }
            })
        );

        const images = filteredImages.filter(Boolean);

        res.render("home", { title: "Home", route: "home", images, layout: false });
    } catch (err) {
        next(err);
    }
});

// ---------- Archive ----------
router.get("/archive", async (_req, res, next) => {
    try {
        const rows = await ImagesService.listRecent(1000);
        const images = rows.map(r => ({
            ...r,
            publicUrl: `/images/${r.gcs_path}`
        }));
        res.render("archive", { title: "Archive", images });
    } catch (err) {
        next(err);
    }
});

// ---------- Image by ID ----------
router.get("/image/:id", async (req, res, next) => {
    try {
        const record = await ImagesService.getById(parseInt(req.params.id, 10));
        if (!record) return res.status(404).render("404");

        res.render("image", {
            title: record.prompt.slice(0, 40),
            piece: {
                ...record,
                publicUrl: `/images/${record.gcs_path}`
            }
        });
    } catch (err) {
        next(err);
    }
});

export default router;
