
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

async function testConnection() {
    const result = await pool.query(
        "SELECT NOW() AS current_time"
    );

    return result.rows[0];
}

module.exports = {
    pool,
    testConnection
};
