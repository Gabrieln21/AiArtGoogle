// src/config/database.ts
import { Pool } from 'pg';

// ✅ Hardcoded working config (skip .env for now)
const pool = new Pool({
    connectionString: "postgres://mural_user:mural123@localhost:5432/mural_dev"
});

console.log("🛠️ Using direct connection string for pg.Pool");

export { pool };
