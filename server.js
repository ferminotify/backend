import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRouter, { authenticateToken } from './routes/auth.js';
import userRouter from './routes/user.js';
import pushRouter from './routes/push.js';
import cookieParser from 'cookie-parser';

dotenv.config();

const app = express();
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const corsOptions = {
  origin: FRONTEND_ORIGIN,
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

app.listen(3001, () => console.log('Server running on port 3001'));
