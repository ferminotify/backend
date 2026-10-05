import express from 'express';
import logger from '../utils/logger.js';
import { ENTITY_TYPES, getIndex, getWeek } from '../utils/timetable/index.js';

const router = express.Router();
const log = logger.child('timetable');

// Public, read-only. Short browser cache: variations change during the day.
const setCache = (res, seconds) => res.set('Cache-Control', `public, max-age=${seconds}`);

/** Classes and rooms available on the school timetable. */
router.get('/', async (req, res) => {
  try {
    const index = await getIndex();
    setCache(res, 3600);
    res.json({
      classes: index.class.map(({ key, name }) => ({ key, name })),
      rooms: index.room.map(({ key, name }) => ({ key, name })),
    });
  } catch (err) {
    log.error('Index failed', { error: err.message });
    res.status(502).json({ error: 'Orario della scuola non raggiungibile' });
  }
});

/** Week timetable with variations applied. ?date=YYYY-MM-DD picks the week (default: current). */
router.get('/:type/:ref', async (req, res) => {
  const type = { classe: 'class', aula: 'room' }[req.params.type] || req.params.type;
  if (!ENTITY_TYPES.includes(type)) return res.status(404).json({ error: 'Tipo non valido' });

  try {
    const week = await getWeek(type, req.params.ref, { date: req.query.date });
    if (!week) return res.status(404).json({ error: 'Classe o aula non trovata' });
    setCache(res, 60);
    res.json(week);
  } catch (err) {
    log.error('Week failed', { type, ref: req.params.ref, error: err.message });
    res.status(502).json({ error: 'Orario della scuola non raggiungibile' });
  }
});

export default router;
