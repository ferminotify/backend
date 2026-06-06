import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const sslConfig = process.env.DB_SSL_CERT
  ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CERT }
  : false;

const pool = new Pool({
  connectionString: `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}?sslmode=${sslConfig ? 'require' : 'disable'}`,
  ssl: sslConfig,
});

export default pool;
