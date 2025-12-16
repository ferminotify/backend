import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import authRouter, { authenticateToken } from './routes/auth.js';
import userRouter from './routes/user.js';
import pushRouter from './routes/push.js';
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

    // Reject other origins
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.use(express.urlencoded({ extended: true }));

app.use('/user/auth', authRouter);

app.use('/user/push', pushRouter);

app.use('/user', authenticateToken, userRouter);

app.get('/', (req, res) => {
  res.send('Fermi Notify Backend is running.');
});

app.listen(3001, () => log.info('Server running on port 3001'));
