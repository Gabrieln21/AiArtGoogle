import { pool } from "../config/database";

export interface ImageRecord {
    id: number;
    prompt: string;
    gcs_path: string;
    model: string;
    parent_id?: number | null;
    created_by: number | null;
    created_at: Date;
}

async function create(
    prompt: string,
    gcsPath: string,
    model: string,
    createdBy: number | null
): Promise<ImageRecord> {
    console.log("🔍 Checking if table 'images' exists...");
    const check = await pool.query("SELECT to_regclass('public.images')");
    console.log("📦 images table resolved as:", check.rows[0].to_regclass);

    const { rows } = await pool.query(
        `INSERT INTO images (prompt, gcs_path, model, created_by)
         VALUES ($1, $2, $3, $4)
             RETURNING *`,
        [prompt, gcsPath, model, createdBy]
    );
    return rows[0];
}

/**
 * Create a new image that is explicitly linked to an earlier one
 * (used for “Regenerate” / iterative edits).
 */
async function createRevision(
    parentId: number,
    gcsPath: string,
    prompt: string,
    model: string,
    userId: number | null
): Promise<ImageRecord> {
    const { rows } = await pool.query(
        `INSERT INTO images (prompt, gcs_path, model, parent_id, created_by)
         VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
        [prompt, gcsPath, model, parentId, userId]
    );
    return rows[0];
}

async function getById(id: number): Promise<ImageRecord | null> {
    const { rows } = await pool.query(`SELECT * FROM images WHERE id = $1`, [id]);
    return rows[0] ?? null;
}

export const ImagesService = {
    create,
    createRevision,
    getById,
    // add other list/query helpers later…
};
