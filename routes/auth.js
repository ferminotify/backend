// TODO: unsubscribe, rates limiting

import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';
import { getTelegramTemporaryCode } from '../utils/telegram.js';
import { sendMailAsync, sendWelcomeEmail } from '../utils/email.js';
import { confirmationEmailHtml, confirmationEmailText, passwordResetEmailHtml, passwordResetEmailText } from '../utils/emailTemplates.js';
import { API_URL, URL } from '../utils/config.js';
import subscriberRepo from '../repositories/subscriber.repository.js';
import crypto from 'crypto';
import { generateRefreshToken } from '../utils/auth.js';
dotenv.config();

const router = express.Router();
const log = logger.child('auth');

/** Escape user-supplied strings before interpolating into HTML email templates. */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* REGISTER */
router.put('/register', async (req, res) => {
    let { name, surname, email, password, password2, gender } = req.body;

    log.info('PUT /register called', { email: email?.toLowerCase(), ip: req.ip });

    try {
        // Validation
        name = name.trim();
        surname = surname.trim();
        email = email.trim().toLowerCase();

        if (!name || !surname || !email || !password || !password2 || !gender) return res.status(400).json({ error: 'Tutti i campi sono obbligatori!' });

        if (password !== password2) return res.status(400).json({ error: 'Le password non corrispondono!' });
        
        if (password.length < 6) return res.status(400).json({ error: 'La password deve essere lunga almeno 6 caratteri!' });

        if (!['M', 'F', 'X'].includes(gender)) return res.status(400).json({ error: 'Genere non valido!' });

        // basic email regex validation, checks for presence of "@" and "."
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: 'Email non valida!' });

    } catch (err) {
        log.error('Validation error during register', { error: err.stack || err });
        return res.status(500).json({ error: 'Errore interno!' });
    }
    // If email already exists: if confirmed (notifications > -1) => error, else resend confirmation email and return 200
    try {
        const existing = await pool.query(
            'SELECT id, email, telegram, notifications, unsub_token, name as db_name, gender as db_gender FROM subscribers WHERE email = $1',
            [email]
        );
        if (existing.rowCount > 0) {
            const row = existing.rows[0];
            if ((row.notifications ?? 0) > -1) {
                return res.status(400).json({ error: 'Email già registrata!' });
            }
            // Not confirmed yet: update info and resend confirmation within a transaction
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const hashed = await bcrypt.hash(password, 10);
                const upd = await client.query(
                    'UPDATE subscribers SET name = $1, surname = $2, password = $3, gender = $4 WHERE id = $5 RETURNING id, email, unsub_token, telegram, name as db_name, gender as db_gender',
                    [name, surname, hashed, gender, row.id]
                );
                const updated = upd.rows[0];
                const code = updated.telegram;
                const confirm_link = `${URL}/user/auth/register/confirmation/${code}`;
                const resendName = updated.db_name || name;
                const resendGender = updated.db_gender || gender;
                const safeResendName = escapeHtml(resendName);

                // Start email send; if this throws (beginSend failed), rollback.
                await sendMailAsync(
                    email,
                    `Conferma la registrazione`,
                    confirmationEmailHtml({ safeName: safeResendName, gender: resendGender, confirmLink: confirm_link }),
                    confirmationEmailText({ name: resendName, confirmLink: confirm_link }),
                    {
                        "List-Unsubscribe": `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${updated.id}&token=${updated.unsub_token}&email=${updated.email}>, <${URL}/auth/unsubscribe?id=${updated.id}&token=${updated.unsub_token}&email=${updated.email}>`
                    }
                );

                await client.query('COMMIT');
            } catch (mailOrUpdateErr) {
                log.error('Failed to update/resend confirmation for unconfirmed user', { error: mailOrUpdateErr.stack || mailOrUpdateErr });
                try { await client.query('ROLLBACK'); } catch (e) { log.error('Rollback failed during resend flow', { error: e.stack || e }); }
                return res.status(500).json({ error: 'Errore interno!' });
            } finally {
                try { client.release(); } catch {}
            }
            return res.status(200).json({ message: "Ti abbiamo reinviato l'email di conferma! (controlla anche lo SPAM)" });
        }
    } catch (preCheckErr) {
        log.error('Pre-check existing email failed', { error: preCheckErr.stack || preCheckErr });
        return res.status(500).json({ error: 'Errore interno!' });
    }
    // Use a transaction so we rollback insert if email beginSend fails
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hashed = await bcrypt.hash(password, 10);
        const telegramTemporaryCode = await getTelegramTemporaryCode();
        const result = await client.query(
        `INSERT INTO subscribers (name, surname, email, password, notifications, telegram, gender, notification_preferences)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, unsub_token, notification_preferences, email`,
          [name, surname, email, hashed, -1, telegramTemporaryCode, gender, 2],
        );

        const confirm_link = `${URL}/user/auth/register/confirmation/${telegramTemporaryCode}`;
        const safeName = escapeHtml(name);
        // Start email send; if this throws (beginSend failed), rollback.
        await sendMailAsync(
            email,
            `Conferma la registrazione`,
            confirmationEmailHtml({ safeName, gender, confirmLink: confirm_link }),
            confirmationEmailText({ name, confirmLink: confirm_link }),
            {
                "List-Unsubscribe": `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${result.rows[0].id}&token=${result.rows[0].unsub_token}&email=${result.rows[0].email}>, <${URL}/auth/unsubscribe?id=${result.rows[0].id}&token=${result.rows[0].unsub_token}&email=${result.rows[0].email}>`
            }
        );

        await client.query('COMMIT');
    } catch (err) {
        log.error('Error during registration transaction', { error: err.stack || err });
        try { await client.query('ROLLBACK'); } catch (e) { log.error('Rollback failed during registration', { error: e.stack || e }); }
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Email già registrata!' });
        }
        return res.status(500).json({ error: 'Errore interno!' });
    } finally {
        // ensure release if not already released
        try { client.release(); } catch {}
    }
    res.status(201).json({ message: 'Ti abbiamo inviato una mail per confermare l\'account! (controlla anche lo SPAM)' });
});

router.get('/register/confirmation/:code', async (req, res) => {
    const code = req.params.code;

    try {
        // Single round-trip: pull every column the welcome flow needs by the
        // confirmation code, instead of 5 separate SELECTs by email.
        const sub = await subscriberRepo.findByTelegram(code);
        if (!sub) return res.status(400).json({ error: 'Codice di conferma non valido!' });

        if (sub.notifications > -1) return res.status(400).json({ error: 'Account già confermato!' });

        const { email, gender, name } = sub;
        const unsub_info = { id: sub.id, unsub_token: sub.unsub_token, notification_preferences: sub.notification_preferences };

        // send welcome email
        try{
            await sendWelcomeEmail(email, { name, gender, unsubInfo: unsub_info });
        } catch (err) {
            log.error('Error sending welcome email', { email, error: err.stack || err });
            return res.status(500).json({ error: 'Errore interno!' });
        }

        await subscriberRepo.incrementNotificationsByTelegram(code);

        return res.status(200).json({ message: 'Account confermato con successo! Ora puoi effettuare il login.' });
    } catch (err) {
        log.error('Error in register confirmation flow', { error: err.stack || err });
        return res.status(500).json({ error: 'Errore interno!' });
    }
});

/* LOGIN */
router.post('/login', async (req, res) => {
    let { email, password } = req.body;
    email = email.trim().toLowerCase();

    try {
    const result = await pool.query('SELECT * FROM subscribers WHERE email = $1', [email]);
    if (result.rowCount === 0) {
        log.warn('Login failed - email not found', { email: email?.toLowerCase(), ip: req.ip });
        return res.status(404).json({ error: 'Email not found' });
    }

    const user = result.rows[0];
    // Google-only accounts have no password set.
    if (!user.password) {
        log.warn('Login failed - account has no password (Google-only)', { id: user.id, email: user.email, ip: req.ip });
        return res.status(401).json({ error: 'Questo account usa l\'accesso con Google.', code: 'google_only' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
        log.warn('Login failed - invalid password', { id: user.id, email: user.email, ip: req.ip });
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    // generate JWT token of 1 min
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    let refreshToken;
    try{
        refreshToken = await generateRefreshToken(user.id, 365 * 24 * 60 * 60 * 1000); // 1 year
    }catch(e){
        log.error('Failed to generate refresh token for user', { id: user.id, error: e.stack || e });
        return res.status(500).json({ error: 'Internal error' });
    }

    try {
        await pool.query(
            "UPDATE subscribers SET last_login = (NOW() AT TIME ZONE 'UTC') WHERE id = $1",
            [user.id]
        );
    } catch (e) {
        log.warn('Failed to update last_login for user', { id: user.id, error: e.stack || e });
    }

    // TEMP use flag onboarding for all users, then use flag notification == -1 for first login TODO
    res.cookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: "lax",
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    });
    log.info('Login success', { id: user.id, email: user.email, ip: req.ip });
    res.json({ token, onboarding: !user.onboarding });
    // update onboarding set to true after first login
    await pool.query('UPDATE subscribers SET onboarding = TRUE WHERE id = $1', [user.id]);
    } catch (err) {
        log.error('Error in login', { error: err.stack || err });
        res.status(500).json({ error: 'Internal error' });
    }
});

// Refresh access token using a valid refresh token.
router.post('/refresh_token', async (req, res) => {
    const refreshToken = req.cookies.refreshToken;

    if (!refreshToken)
        return res.status(401).json({ error: 'No refresh token provided' });

    try {
        const result = await pool.query(
            'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
            [refreshToken]
        );
        if (result.rowCount === 0)
            return res.status(401).json({ error: 'Invalid or expired refresh token' });

        const tokenData = result.rows[0];
        const userResult = await pool.query('SELECT email FROM subscribers WHERE id = $1', [tokenData.sub_id]);
        const user_email = userResult.rows[0].email;
        const user = { id: tokenData.sub_id, email: user_email };

        const newAccessToken = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
            expiresIn: '1h',
        });

        // rotation: generate a new token and update the existing DB row
        let newRefreshToken;
        try {
            newRefreshToken = crypto.randomBytes(64).toString('hex');
        } catch (e) {
            log.error('Failed to generate new refresh token for user', { id: user.id, error: e.stack || e });
            return res.status(500).json({ error: 'Internal error' });
        }

        await pool.query(
            "UPDATE refresh_tokens SET token = $1, expires_at = NOW() + INTERVAL '365 days' WHERE id = $2",
            [newRefreshToken, tokenData.id]
        );

        // Set the new refresh token cookie (HttpOnly)
        res.cookie('refreshToken', newRefreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 365 * 24 * 60 * 60 * 1000,
        });

        return res.status(200).json({ token: newAccessToken });
    } catch (err) {
        log.error('Error in refresh_token', { error: err.stack || err });
        return res.status(500).json({ error: 'Internal error' });
    }
});

router.post('/logout', authenticateToken, async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token provided' });
  try {
    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    res.json({ success: true });
  } catch (err) {
        log.error('Error during logout', { error: err.stack || err });
        res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/request-change-password', async (req, res) => {
    let { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email non fornita' });
    email = email.trim().toLowerCase();
    log.info('POST /request-change-password', { email, ip: req.ip });
    try {
        const user = await subscriberRepo.findByEmail(email);
        if (!user) return res.status(404).json({ error: 'Email non registrata' });
        const name = user.name || '';
        if (!name) return res.status(500).json({ error: 'Si è verificato un errore. Riprova più tardi.' });
        const safeName = escapeHtml(name);

        // Generate a 6-char uppercase code (A-Z0-9). Keep existing style.
        const randomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        try {
            await pool.query(
                `UPDATE subscribers SET secret_temp = $1, secret_temp_timestamp = CURRENT_TIMESTAMP WHERE email = $2;`,
                [randomCode, email]
            );
        } catch (err) {
            log.error('ERR SET TEMP SECRET', { email, error: err.stack || err });
            return res.status(500).json({ error: 'Si è verificato un errore. Riprova più tardi.' });
        }

        try {
            await sendMailAsync(
                email,
                `Codice OTP [${randomCode}]`,
                passwordResetEmailHtml({ safeName, code: randomCode, unsubInfo: { id: user.id, unsub_token: user.unsub_token }, email }),
                passwordResetEmailText({ name, code: randomCode }),
                {
                    'List-Unsubscribe': `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${user.id}&token=${user.unsub_token}&email=${email}>, <${URL}/auth/unsubscribe?id=${user.id}&token=${user.unsub_token}&email=${email}>`
                }
            );
        } catch (mailErr) {
            log.error('ERR SEND RESET EMAIL', { email, error: mailErr.stack || mailErr });
            return res.status(500).json({ error: 'Si è verificato un errore nell\'invio dell\'email.' });
        }

        return res.status(200).json({ message: 'Ti abbiamo inviato un codice per reimpostare la password. Controlla anche lo SPAM.' });
    } catch (err) {
        log.error('Error in request-change-password', { email, error: err.stack || err });
        return res.status(500).json({ error: 'Si è verificato un errore. Riprova più tardi.' });
    }
});

router.post('/otp-change-password', async (req, res) => {
    let { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email o codice OTP non forniti' });
    email = email.trim().toLowerCase();
    otp = otp.trim().toUpperCase();
    try {
        const valid = await subscriberRepo.verifyOTP(email, otp);

        if (valid !== "OK") {
            return res.status(400).json({ error: valid });
        }

        return res.sendStatus(200);
    } catch (err) {
        log.error('Error in otp-change-password', { email, error: err.stack || err });
        return res.status(500).json({ error: 'Si è verificato un errore. Riprova più tardi.' });
    }
});

router.post('/new-change-password', async (req, res) => {
    let { email, otp, newPassword, newPassword2 } = req.body;
    if (!email || !otp || !newPassword || !newPassword2)
        return res.status(400).json({ error: 'Dati mancanti' });
    email = email.trim().toLowerCase();
    otp = otp.trim().toUpperCase();

    if (newPassword !== newPassword2)
        return res.status(400).json({ error: 'Le password non corrispondono' });
    
    if (newPassword.length < 6)
        return res.status(400).json({ error: 'La password deve essere lunga almeno 6 caratteri' });
    
    try {
        const valid = await subscriberRepo.verifyOTP(email, otp);

        if (valid !== "OK") {
            return res.status(400).json({ error: valid });
        }
        
        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query(
            `UPDATE subscribers SET password = $1, secret_temp = NULL, secret_temp_timestamp = NULL WHERE email = $2`,
            [hashed, email]
        );

        return res.status(200).json({ message: 'Password cambiata con successo' });
    } catch (err) {
        log.error('Error in new-change-password', { email, error: err.stack || err });
        return res.status(500).json({ error: 'Si è verificato un errore. Riprova più tardi.' });
    }
});

// Middleware to verify token
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1]; // Bearer TOKEN
  if (!token) return res.status(401).json({ error: 'No token' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

export default router;
