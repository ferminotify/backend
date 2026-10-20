import express from 'express';
import pool from '../db.js';
import logger from '../utils/logger.js';
import { jointKeywords } from '../utils/timetable/keywords.js';

const router = express.Router();
const log = logger.child('keyword');

router.put('/add', async (req, res) => {
  const { keyword } = req.body;
  const userId = req.user.id;

  log.info('PUT /add called', { userId });

  if (!keyword) {
    log.warn('Keyword missing in request body', { userId });
    return res.status(400).json({ message: 'Keyword is required' });
  }

  try {
    const userResult = await pool.query('SELECT tags FROM subscribers WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) {
      log.warn('User not found when adding keyword', { userId });
      return res.status(404).json({ message: 'User not found' });
    }

    user.tags = user.tags || [];
    // A class also brings the joint classes it is part of ("5EELE" → "5EELEET"): the notifier
    // matches only the keywords set, so removing one stops those events.
    let joints = [];
    try {
      joints = await jointKeywords(keyword);
    } catch (err) {
      log.warn('Joint classes unavailable, keyword added alone', { userId, error: err.message });
    }
    const have = new Set(user.tags.map((t) => String(t).toUpperCase()));
    const added = [keyword, ...joints].filter((k) => !have.has(k.toUpperCase()) && have.add(k.toUpperCase()));
    if (added.length) {
      user.tags.push(...added);
      await pool.query('UPDATE subscribers SET tags = $1 WHERE id = $2', [user.tags, userId]);
      log.info('Keyword added', { userId, keyword, joints });
    } else {
      log.debug('Keyword already present', { userId, keyword });
    }

    res.status(200).json({ message: 'Keyword added successfully', keywords: user.tags, added });
  } catch (error) {
    log.error('Error adding keyword', { userId, error: error.stack || error });
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/delete', async (req, res) => {
  const { keyword } = req.body;
  const userId = req.user.id;

  log.info('DELETE /delete called', { userId });

  if (!keyword) {
    log.warn('Keyword missing in delete request', { userId });
    return res.status(400).json({ message: 'Keyword is required' });
  }

  try {
    const userResult = await pool.query('SELECT tags FROM subscribers WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) {
      log.warn('User not found when deleting keyword', { userId });
      return res.status(404).json({ message: 'User not found' });
    }

    user.tags = user.tags.filter((k) => k !== keyword);
    await pool.query('UPDATE subscribers SET tags = $1 WHERE id = $2', [user.tags, userId]);

    log.info('Keyword deleted', { userId, keyword });
    res.status(200).json({ message: 'Keyword deleted successfully' });
  } catch (error) {
    log.error('Error deleting keyword', { userId, error: error.stack || error });
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;