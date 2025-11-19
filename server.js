import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRouter, { authenticateToken } from './routes/auth.js';
import userRouter from './routes/user.js';
import pushRouter from './routes/push.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use('/user/auth', authRouter);

app.use('/user', authenticateToken, userRouter);

app.listen(3001, () => console.log('Server running on port 3001'));
