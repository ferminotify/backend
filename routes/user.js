import express from 'express';
import pool from '../db.js';
import dotenv from 'dotenv';
import keywordRouter from './keyword.js';
import preferencesRouter from './preferences.js';
import TelegramRouter from './telegram.js';
dotenv.config();

const router = express.Router();

router.get('/profile', async (req, res) => {
    const id = req.user.id;
    try {
        const user = await pool.query(`
            SELECT
            name,
            surname,
            email,
            gender,
            tags AS keywords,
            telegram,
            notifications,
            notification_preferences,
            include_similar_tags,
            notification_day_before,
            notification_time
            FROM subscribers WHERE id = $1`, [id]);
        res.json(user.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// mount keyword routes under /keyword with authentication
router.use('/keyword', keywordRouter);

router.use("/preferences", preferencesRouter);

router.use("/telegram", TelegramRouter);

app.use('/push', pushRouter);

router.post('/edit', async (req, res) => {
    const userId = req.user.id;
    const { name, surname, gender } = req.body;

    try {
        const fields = [];
        const values = [];
        let index = 1;

        if (name !== undefined) {
            fields.push(`name = $${index++}`);
            values.push(name);
        }

        if (surname !== undefined) {
            fields.push(`surname = $${index++}`);
            values.push(surname);
        }

        if (gender !== undefined) {
            fields.push(`gender = $${index++}`);
            values.push(gender);
        }

        // If no fields to update
        if (fields.length === 0) {
            return res.status(400).json({ message: 'No valid fields provided.' });
        }

        // Add userId as the last parameter
        values.push(userId);

        const query = `
            UPDATE subscribers
            SET ${fields.join(', ')}
            WHERE id = $${index}
        `;

        await pool.query(query, values);

        res.status(200).json({ message: 'Profile updated successfully.' });
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

export default router;