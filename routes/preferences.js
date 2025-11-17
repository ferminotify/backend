
import express from 'express';
import pool from '../db.js';
import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

router.post('/notification-preferences', async (req, res) => {
    const userId = req.user.id;
    const option = req.body.option;

    if (option < 0 || option > 3) return res.status(400).json({ message: 'Invalid notification preferences option.' });
    try {
        await pool.query(
            'UPDATE subscribers SET notification_preferences = $1 WHERE id = $2',
            [option, userId]
        );
        res.status(200).json({ message: 'Notification preferences updated successfully.' });
    } catch (error) {
        console.error('Error updating notification preferences:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/toggle-probable-notifications', async (req, res) => {
    const userId = req.user.id;

    try {
        const result = await pool.query(
            'UPDATE subscribers SET include_similar_tags = NOT include_similar_tags WHERE id = $1 RETURNING include_similar_tags',
            [userId]
        );
        const newValue = result.rows[0].include_similar_tags;
        res.status(200).json({ message: 'Probable notifications preference toggled successfully.', include_similar_tags: newValue });
    } catch (error) {
        console.error('Error toggling probable notifications preference:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/notification-time', async (req, res) => {
    const userId = req.user.id;
    const { time, day } = req.body;

    try {
        await pool.query(
            'UPDATE subscribers SET notification_time = $1, notification_day_before = $2 WHERE id = $3',
            [time, day, userId]
        );
        res.status(200).json({ message: 'Notification time updated successfully.' });
    } catch (error) {
        console.error('Error updating notification time:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

export default router;