import express from 'express';
import pool from '../db.js';

const router = express.Router();

router.put('/add', async (req, res) => {
  const { keyword } = req.body;
  const userId = req.user.id;

  if (!keyword) {
    return res.status(400).json({ message: 'Keyword is required' });
  }

  try {
    const userResult = await pool.query('SELECT tags FROM subscribers WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.tags.includes(keyword)) {
      user.tags.push(keyword);
      await pool.query('UPDATE subscribers SET tags = $1 WHERE id = $2', [user.tags, userId]);
    }

    res.status(200).json({ message: 'Keyword added successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/delete', async (req, res) => {
  const { keyword } = req.body;
  const userId = req.user.id;

  if (!keyword) {
    return res.status(400).json({ message: 'Keyword is required' });
  }

  try {
    const userResult = await pool.query('SELECT tags FROM subscribers WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.tags = user.tags.filter((k) => k !== keyword);
    await pool.query('UPDATE subscribers SET tags = $1 WHERE id = $2', [user.tags, userId]);

    res.status(200).json({ message: 'Keyword deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;