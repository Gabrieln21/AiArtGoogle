// src/config/database.ts
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

console.log("🛠️ Setting up pg.Pool with connection string:", process.env.DATABASE_URL);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

export { pool };
