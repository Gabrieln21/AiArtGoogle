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
    // @ts-ignore SQL dialect warning
    const check = await pool.query("SELECT to_regclass('public.images')");
    console.log("📦 images table resolved as:", check.rows[0].to_regclass);

    // @ts-ignore SQL dialect warning
    const { rows } = await pool.query(
        `INSERT INTO images (prompt, gcs_path, model, created_by)
         VALUES ($1, $2, $3, $4)
             RETURNING *`,
        [prompt, gcsPath, model, createdBy]
    );
    return rows[0];
}

async function getById(id: number): Promise<ImageRecord | null> {
    // @ts-ignore SQL dialect warning
    const { rows } = await pool.query(`SELECT * FROM images WHERE id = $1`, [id]);
    return rows[0] ?? null;
}

async function listRecent(limit: number = 100): Promise<ImageRecord[]> {
    // @ts-ignore SQL dialect warning
    const { rows } = await pool.query(
        `SELECT * FROM images
         ORDER BY created_at DESC
             LIMIT $1`,
        [limit]
    );
    return rows;
}

async function remove(id: number): Promise<boolean> {
    // @ts-ignore SQL dialect warning
    const { rowCount } = await pool.query(`DELETE FROM images WHERE id = $1`, [id]);
    return rowCount !== null && rowCount > 0;
}

export const ImagesService = {
    create,
    getById,
    listRecent,
    remove
};
