import express from 'express';
import pool from '../db.js';
import dotenv from 'dotenv';
import keywordRouter from './keyword.js';
import preferencesRouter from './preferences.js';
import TelegramRouter from './telegram.js';
import logger from '../utils/logger.js';
dotenv.config();

const router = express.Router();
const log = logger.child('user');
log.info('Router initialized', { env: process.env.NODE_ENV });

router.get('/profile', async (req, res) => {

    log.debug('Authenticated user', { user: req.user ? { id: req.user.id } : null });
    log.debug('Request meta', { path: req.path, method: req.method, ip: req.ip });

    if (!req.user?.id) {
        log.warn('No user ID found in request. Rejecting as unauthorized.');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = req.user.id;

    try {
        const profileSql = `
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
        `;

        log.debug('Executing profile query for id', { id });
        const result = await pool.query(profileSql, [id]);

        if (result.rows.length === 0) {
            log.info('No user found with ID', { id });
            return res.status(404).json({ error: 'User not found' });
        }

        log.info('Returning profile for user ID', { id, rows: result.rows.length });
        // Avoid logging entire profile object (may contain sensitive fields). Log push subscription summary only.
        try {
            const summary = { push_subscription: result.rows[0].push_subscription ? 'present' : 'none' };
            log.debug('Profile summary', summary);
        } catch (e) {
            log.warn('Could not summarize profile push_subscription', { error: e });
        }

        return res.json(result.rows[0]);

    } catch (err) {
        log.error('Profile fetch error', { error: err.stack || err });
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// mount keyword routes under /keyword with authentication
log.info('Mounting subrouter: /keyword');
router.use('/keyword', keywordRouter);

log.info('Mounting subrouter: /preferences');
router.use('/preferences', preferencesRouter);

log.info('Mounting subrouter: /telegram');
router.use('/telegram', TelegramRouter);

router.post('/edit', async (req, res) => {
    log.debug('POST /edit - incoming request', { ip: req.ip });
    log.debug('Authenticated user (reduced)', { id: req.user?.id, telegram: Boolean(req.user?.telegram) });

    if (!req.user?.id) {
        log.warn('No user ID found in request for edit. Rejecting.');
        return res.status(401).json({ error: 'Unauthorized' });
    }

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
            log.info('Edit called but no updatable fields present in body', { body: req.body });
            return res.status(400).json({ message: 'No valid fields provided.' });
        }

        // Add userId as the last parameter
        values.push(userId);

        const query = `
            UPDATE subscribers
            SET ${fields.join(', ')}
            WHERE id = $${index}
        `;

        log.debug('Executing update', { query: query.replace(/\s+/g, ' ').trim(), values });

        const updateResult = await pool.query(query, values);
        log.info('Update result', { rowCount: updateResult.rowCount, id: userId });

        res.status(200).json({ message: 'Profile updated successfully.' });
    } catch (error) {
        log.error('Error updating profile', { error: error.stack || error });
        res.status(500).json({ message: 'Internal server error.' });
    }
});

export default router;