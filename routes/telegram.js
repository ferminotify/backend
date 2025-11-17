import express from 'express';
import pool from '../db.js';
import dotenv from 'dotenv';
import { getTelegramTemporaryCode } from '../utils/telegram.js';
dotenv.config();

const router = express.Router();

router.post('/disconnect', async (req, res) => {
    const userId = req.user.id;
    // Generate a unique temporary telegram code. If a collision occurs (very unlikely),
    // regenerate up to MAX_ATTEMPTS times to ensure uniqueness since `telegram` must be unique.
    const MAX_ATTEMPTS = 10;
    let new_telegram_code = null;
    try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const candidate = await getTelegramTemporaryCode();
            const { rows } = await pool.query('SELECT id FROM subscribers WHERE telegram = $1', [candidate]);
            if (rows.length === 0) {
                new_telegram_code = candidate;
                break;
            }
            // otherwise collision - try again
        }

        if (!new_telegram_code) {
            console.error('Failed to generate a unique telegram temporary code after', MAX_ATTEMPTS, 'attempts');
            return res.status(500).json({ error: 'Could not generate unique telegram code' });
        }

        const result = await pool.query(
            'UPDATE subscribers SET telegram = $1 WHERE id = $2 RETURNING telegram',
            [new_telegram_code, userId]
        );

        res.json({ message: 'Telegram disconnected successfully', telegram: result.rows[0].telegram });
    } catch (error) {
        console.error('Error disconnecting Telegram:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;