import express from 'express';
import cors from 'cors';
import authRouter, { authenticateToken } from './routes/auth.js';
import keywordRouter from './routes/keyword.js';

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.urlencoded({ extended: true }));

// mount keyword routes under /keyword with authentication
app.use('/keyword', authenticateToken, keywordRouter);

app.use('/auth', authRouter);

app.listen(3001, () => console.log('Server running on port 3001'));
