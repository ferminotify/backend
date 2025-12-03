import express from 'express';
import pool from '../db.js';
import dotenv from 'dotenv';
import keywordRouter from './keyword.js';
import preferencesRouter from './preferences.js';
import TelegramRouter from './telegram.js';
dotenv.config();

const router = express.Router();

router.get('/profile', async (req, res) => {
    if (!req.user?.id) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = req.user.id;

    try {
        const result = await pool.query(`
            SELECT
                s.name,
                s.surname,
                s.email,
                s.gender,
                s.tags AS keywords,
                s.telegram,
                s.notifications,
                s.notification_preferences,
                s.include_similar_tags,
                s.notification_day_before,
                s.notification_time,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'endpoint', p.endpoint,
                            'p256dh', p.p256dh,
                            'auth', p.auth,
                            'device_id', p.device_id,
                            'device_info', p.device_info
                        )
                    ) FILTER (WHERE p.endpoint IS NOT NULL),
                    'null'
                ) AS push_subscription
            FROM subscribers s
            LEFT JOIN push p ON p.sub_id = s.id
            WHERE s.id = $1
            GROUP BY s.id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.json(result.rows[0]);

    } catch (err) {
        console.error('Profile fetch error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// mount keyword routes under /keyword with authentication
router.use('/keyword', keywordRouter);

router.use("/preferences", preferencesRouter);

router.use("/telegram", TelegramRouter);

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