
import express from 'express';
import pool from '../db.js';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';
import { OPT_IN, cleanOptIn } from '../utils/timetable/optIn.js';
dotenv.config();

const router = express.Router();
const log = logger.child('preferences');

router.post('/notification-preferences', async (req, res) => {
    const userId = req.user.id;
    const option = req.body.option;

    if (option < 0 || option > 3) return res.status(400).json({ message: 'Invalid notification preferences option.' });
    try {
        await pool.query(
            'UPDATE subscribers SET notification_preferences = $1 WHERE id = $2',
            [option, userId]
        );
        log.info('Updated notification preferences', { userId, option });
        res.status(200).json({ message: 'Notification preferences updated successfully.' });
    } catch (error) {
        log.error('Error updating notification preferences', { userId, error: error.stack || error });
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.get('/notify-optin', (req, res) => {
    res.json({
        categories: Object.entries(OPT_IN).map(([id, c]) => ({ id, label: c.label, description: c.description, example: c.example })),
    });
});

router.post('/notify-optin', async (req, res) => {
    const userId = req.user.id;
    if (!Array.isArray(req.body?.optin)) return res.status(400).json({ message: 'optin must be an array.' });
    const optin = cleanOptIn(req.body.optin);
    try {
        await pool.query('UPDATE subscribers SET notify_optin = $1 WHERE id = $2', [optin, userId]);
        log.info('Updated notify_optin', { userId, optin });
        res.status(200).json({ notify_optin: optin });
    } catch (error) {
        log.error('Error updating notify_optin', { userId, error: error.stack || error });
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
        log.info('Updated notification time', { userId, time, day });
        res.status(200).json({ message: 'Notification time updated successfully.' });
    } catch (error) {
        log.error('Error updating notification time', { userId, error: error.stack || error });
        res.status(500).json({ message: 'Internal server error.' });
    }
});

export default router;