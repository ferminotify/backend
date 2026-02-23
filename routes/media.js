import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const log = logger.child('media');
const mediaDir = path.join(__dirname, '..', 'media');

// Serve media files from /email/v3/..., /email/v4/..., etc.
// Supports nested paths like /email/v3/icon-muted.png without /media prefix
router.use((req, res, next) => {
  const filepath = req.path.replace(/^\//, '').replace(/\/$/, '');

  // If no filepath, it's a directory request - skip to next middleware
  if (!filepath) {
    return next();
  }

  // Security: prevent directory traversal
  if (filepath.includes('..')) {
    log.warn('Attempted unauthorized file access', { filepath, ip: req.ip });
    return res.status(403).json({ error: 'Invalid filepath' });
  }

  const filePath = path.join(mediaDir, filepath);

  // Security: ensure resolved path is within media directory
  if (!filePath.startsWith(mediaDir)) {
    log.warn('Attempted path escape outside media directory', { filepath, ip: req.ip });
    return res.status(403).json({ error: 'Invalid filepath' });
  }

  // Check if file has an extension (not a directory)
  if (path.extname(filePath) === '') {
    log.warn('Attempted to access a directory', { filepath, ip: req.ip });
    return res.status(403).json({ error: 'Invalid filepath' });
  }

  // Check if file exists in media directory before trying to serve
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      // File not found in media directory, pass to next middleware (API routes)
      return next();
    }

    // File exists, serve it
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
});

export default router;
