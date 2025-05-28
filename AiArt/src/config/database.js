const { Pool } = require('pg');

// ✅ Hardcoded working config
const pool = new Pool({
    connectionString: "postgres://mural_user:mural123@localhost:5432/mural_dev"
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool
};
