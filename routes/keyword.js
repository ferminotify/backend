import express from 'express';
import pool from '../db.js';
import logger from '../utils/logger.js';

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
    if (!user.tags.includes(keyword)) {
      user.tags.push(keyword);
      await pool.query('UPDATE subscribers SET tags = $1 WHERE id = $2', [user.tags, userId]);
      log.info('Keyword added', { userId, keyword });
    } else {
      log.debug('Keyword already present', { userId, keyword });
    }

    res.status(200).json({ message: 'Keyword added successfully' });
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