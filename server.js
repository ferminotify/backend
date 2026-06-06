import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import authRouter, { authenticateToken } from './routes/auth.js';
import googleRouter from './routes/google.js';
import userRouter from './routes/user.js';
import pushRouter from './routes/push.js';
import mediaRouter from './routes/media.js';
import cookieParser from 'cookie-parser';

dotenv.config();

const app = express();
const log = logger.child('server');
// Support multiple allowed frontend origins. Set `FRONTEND_ORIGIN` to a comma-separated
// list like: "https://fn.lkev.in,https://ferminotify.lkev.in,https://pwa.fn.lkev.in"
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const FRONTEND_ORIGINS = FRONTEND_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow non-browser requests (e.g. curl, server-to-server) where origin is undefined
    if (!origin) return callback(null, true);

    if (FRONTEND_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    // Reject other origins - error logged in middleware below
    return callback(new Error(`CORS rejected origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

// Log incoming requests before CORS check for debugging
app.use((req, res, next) => {
  log.debug(`Incoming request: ${req.method} ${req.originalUrl} from origin: ${req.headers.origin || 'no-origin'}`);
  next();
});

// Media route without CORS restrictions (for backend server-to-server access)
// Mounted at root to expose folders directly: /email/v3/logo.png, /email/v4/logo.png, etc.
app.use('/', mediaRouter);

app.use(cors(corsOptions));

// CORS error handler
app.use((err, req, res, next) => {
  if (err.message && err.message.startsWith('CORS rejected')) {
    log.warn(`CORS blocked: ${req.method} ${req.originalUrl} - Origin: ${req.headers.origin} - Allowed: [${FRONTEND_ORIGINS.join(', ')}]`);
    return res.status(403).json({ error: 'Not allowed by CORS', origin: req.headers.origin });
  }
  next(err);
});
app.use(express.json());
app.use(cookieParser());

app.use(express.urlencoded({ extended: true }));

app.use('/user/auth/google', googleRouter);

app.use('/user/auth', authRouter);

app.use('/user/push', pushRouter);

app.use('/user', authenticateToken, userRouter);

app.get('/', (req, res) => {
  res.send('Fermi Notify Backend is running.');
});

app.listen(3001, () => log.info('Server running on port 3001'));
