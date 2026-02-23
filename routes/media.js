import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const log = logger.child('media');

// Serve media files without CORS restrictions
// This allows backend instances on any machine to access media assets
// Supports nested paths like /email/v3/icon-muted.png
router.use((req, res) => {
  const filepath = req.path.replace(/^\//, '');

  // Security: prevent directory traversal
  if (filepath.includes('..')) {
    log.warn('Attempted unauthorized file access', { filepath, ip: req.ip });
    return res.status(403).json({ error: 'Invalid filepath' });
  }

  const filePath = path.join(__dirname, '..', 'media', filepath);

  if (path.extname(filePath) === '') {
    log.warn('Attempted to access a directory', { filepath, ip: req.ip });
    return res.status(403).json({ error: 'Invalid filepath' });
  }

  res.sendFile(filePath, (err) => {
    if (err) {
      if (err.code === 'ENOENT') {
        log.debug('Media file not found', { filepath });
        return res.status(404).json({ error: 'Media file not found' });
      }
      log.error('Error serving media file', { filepath, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
});

export default router;
