import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
  connectionString: `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}?sslmode=require`,
  ssl: {
    rejectUnauthorized: true,
    ca: process.env.DB_SSL_CERT
  }
});

export default pool;
