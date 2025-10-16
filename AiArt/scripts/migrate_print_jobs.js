#!/usr/bin/env node
// Uses the same DB config as the app, so it hits the right DB.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/database'); // adjust path if needed

(async () => {
    try {
        const sqlPath = path.resolve(__dirname, '../src/db/migrations/001_print_jobs.sql'); // put the .sql here
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await pool.query(sql);
        console.log('✅ print_jobs migration applied.');
        process.exit(0);
    } catch (e) {
        console.error('❌ migration failed:', e.message);
        process.exit(1);
    } finally {
        pool.end && pool.end();
    }
})();
