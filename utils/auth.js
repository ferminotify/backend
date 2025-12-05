import crypto from 'crypto';
import pool from '../db.js';
export async function generateRefreshToken(id, duration) {
    // generate refresh token to store in DB
    // Use a retry loop to guard against the astronomically unlikely event
    // of a token collision. Also catches unique-violation errors if DB has
    // a unique index on the token column.
    const expiresAt = new Date(Date.now() + duration); 
    let refreshToken;
    const maxRetries = 5;
    let inserted = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        refreshToken = crypto.randomBytes(64).toString('hex');
        try {
            await pool.query(
                'INSERT INTO refresh_tokens (sub_id, token, expires_at) VALUES ($1, $2, $3)',
                [id, refreshToken, expiresAt]
            );
            inserted = true;
            break;
        } catch (e) {
            // If unique-violation on token, retry. Other errors should bubble up.
            if (e && e.code === '23505') {
                // extremely unlikely collision, try again
                continue;
            }
            throw e;
        }
    }
    if (!inserted) {
        throw new Error('Failed to generate unique refresh token after multiple attempts');
    }
    return refreshToken;
}