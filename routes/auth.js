// TODO: unsubscribe, rates limiting

import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import dotenv from 'dotenv';
import { getTelegramTemporaryCode } from '../utils/telegram.js';
import { sendMail, sendMailAsync } from '../utils/email.js';
import { URL } from '../utils/config.js';
import {
    getUserEmailWithTelegramID,
    getNumberNotification,
    getGenderByEmail,
    getFirstNameByEmail,
    getUnsubscribeInfoByEmail,
    incrementNumberNotification,
} from '../utils/utils.js';
import crypto from 'crypto';
dotenv.config();

const router = express.Router();

/* REGISTER */
router.put('/register', async (req, res) => {
    let { name, surname, email, password, password2, gender } = req.body;

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
        console.error(err);
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

                // Start email send; if this throws (beginSend failed), rollback.
                await sendMailAsync(
                    email,
                    `Conferma la registrazione`,
                    `<!doctype html><html><main style="font-family:Helvetica,Arial,Liberation Serif,sans-serif;background-color:#fff;color:#000"><table border=0 cellpadding=0 cellspacing=0 style="max-width:620px;border-collapse:collapse;margin:0 auto 0 auto;text-align:left;font-family:Helvetica,Arial,Liberation Serif,sans-serif"width=620px><tr style=background-color:#fff><td style="width:100%;padding:30px 7% 15px 7%"><a href=${URL}><img src=${URL}/email/v3/logo-long-allmuted-trasp.png style=width:70%;height:auto;color:#fff alt="FERMI NOTIFY"></a><tr style=background-color:#fff><td><table border=0 cellpadding=0 cellspacing=0 style="width:100%;background-color:#fff;padding:30px 7% 30px 7%;border:none;border-top:1px solid #ddd;border-bottom:1px solid #ddd;font-size:16px"><tr><td><h2 style="margin:10px 0">Ciao ${resendName}!</h2><tr><td style=text-align:left><p style=line-height:1.3>Per completare la registrazione, conferma il tuo indirizzo email:<tr><td style="padding:15px 0"><a href=${confirm_link} style="font-size:14px;letter-spacing:1.2px;padding:13px 17px;font-weight:600;background-color:#004a77;border-radius:10px;color:#fff;text-decoration:none"target=_blank>Conferma email</a><tr><td style=text-align:left><p style=line-height:1.3>Appena completerai la registrazione, ti arriverà una seconda email con tutte le indicazioni sull'utilizzo.<tr><td style=text-align:left><p style=line-height:1.3>A presto!</table><tr style=background-color:#fff><td style="padding:15px 7% 30px 7%;font-size:13px;position:relative;background-color:#fff"><p style=color:#8b959e>Il bottone non funziona? Conferma l'email attraverso il seguente link: <a href=${confirm_link} style=color:#004a77 target=_blank>${confirm_link}</a>.<p style=color:#8b959e>Per supporto o informazioni, consulta la <a href=${URL}/faq style=color:#004a77>FAQ</a> o contattaci su Instagram <a href=${URL}/ig style=color:#004a77><i>@ferminotify</i></a>.</p><a href=${URL}><img src=${URL}/email/v3/icon-allmuted.png style=width:70%;height:auto;color:#fff alt="Fermi Notify"></a><p style=margin:0;color:#8b959e><i style=color:#8b959e>Fermi Notify Team</i><p style=margin-top:0><a href=${URL} style=color:#004a77 target=_blank>fn.lkev.in</a><p style=color:#8b959e;font-size:12px>Hai ricevuto questa email perché ti sei registrat${resendGender == "M" ? "o" : resendGender == "F" ? "a" : "ə"} a <i>Fermi Notify</i>. Se non sei stato tu, ignora questa email.</table></main><html>`,
                    `Ciao ${resendName}! Per completare la registrazione, conferma il tuo indirizzo email: ${confirm_link}. Appena completerai la registrazione, ti arriverà una seconda email con tutte le indicazioni sull'utilizzo. A presto!`,
                    {
                        "List-Unsubscribe": `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${updated.id}&token=${updated.unsub_token}&email=${updated.email}>, <${URL}/auth/unsubscribe?id=${updated.id}&token=${updated.unsub_token}&email=${updated.email}>`
                    }
                );

                await client.query('COMMIT');
                client.release();
            } catch (mailOrUpdateErr) {
                console.error('Failed to update/resend confirmation for unconfirmed user:', mailOrUpdateErr);
                try { await client.query('ROLLBACK'); } catch (e) { console.error('Rollback failed:', e); }
                try { client.release(); } catch {}
                return res.status(500).json({ error: 'Errore interno!' });
            }
            return res.status(200).json({ message: "Ti abbiamo reinviato l'email di conferma! (controlla anche lo SPAM)" });
        }
    } catch (preCheckErr) {
        console.error('Pre-check existing email failed:', preCheckErr);
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
        // Start email send; if this throws (beginSend failed), rollback.
        await sendMailAsync(
            email,
            `Conferma la registrazione`,
            `<!doctype html><html><main style="font-family:Helvetica,Arial,Liberation Serif,sans-serif;background-color:#fff;color:#000"><table border=0 cellpadding=0 cellspacing=0 style="max-width:620px;border-collapse:collapse;margin:0 auto 0 auto;text-align:left;font-family:Helvetica,Arial,Liberation Serif,sans-serif"width=620px><tr style=background-color:#fff><td style="width:100%;padding:30px 7% 15px 7%"><a href=${URL}><img src=${URL}/email/v3/logo-long-allmuted-trasp.png style=width:70%;height:auto;color:#fff alt="FERMI NOTIFY"></a><tr style=background-color:#fff><td><table border=0 cellpadding=0 cellspacing=0 style="width:100%;background-color:#fff;padding:30px 7% 30px 7%;border:none;border-top:1px solid #ddd;border-bottom:1px solid #ddd;font-size:16px"><tr><td><h2 style="margin:10px 0">Ciao ${name}!</h2><tr><td style=text-align:left><p style=line-height:1.3>Per completare la registrazione, conferma il tuo indirizzo email:<tr><td style="padding:15px 0"><a href=${confirm_link} style="font-size:14px;letter-spacing:1.2px;padding:13px 17px;font-weight:600;background-color:#004a77;border-radius:10px;color:#fff;text-decoration:none"target=_blank>Conferma email</a><tr><td style=text-align:left><p style=line-height:1.3>Appena completerai la registrazione, ti arriverà una seconda email con tutte le indicazioni sull'utilizzo.<tr><td style=text-align:left><p style=line-height:1.3>A presto!</table><tr style=background-color:#fff><td style="padding:15px 7% 30px 7%;font-size:13px;position:relative;background-color:#fff"><p style=color:#8b959e>Il bottone non funziona? Conferma l'email attraverso il seguente link: <a href=${confirm_link} style=color:#004a77 target=_blank>${confirm_link}</a>.<p style=color:#8b959e>Per supporto o informazioni, consulta la <a href=${URL}/faq style=color:#004a77>FAQ</a> o contattaci su Instagram <a href=${URL}/ig style=color:#004a77><i>@ferminotify</i></a>.</p><a href=${URL}><img src=${URL}/email/v3/icon-allmuted.png style=width:70%;height:auto;color:#fff alt="Fermi Notify"></a><p style=margin:0;color:#8b959e><i style=color:#8b959e>Fermi Notify Team</i><p style=margin-top:0><a href=${URL} style=color:#004a77 target=_blank>fn.lkev.in</a><p style=color:#8b959e;font-size:12px>Hai ricevuto questa email perché ti sei registrat${gender == "M" ? "o" : gender == "F" ? "a" : "ə"} a <i>Fermi Notify</i>. Se non sei stato tu, ignora questa email.</table></main><html>`,
            `Ciao ${name}! Per completare la registrazione, conferma il tuo indirizzo email: ${confirm_link}. Appena completerai la registrazione, ti arriverà una seconda email con tutte le indicazioni sull'utilizzo. A presto!`,
            {
                "List-Unsubscribe": `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${result.rows[0].id}&token=${result.rows[0].unsub_token}&email=${result.rows[0].email}>, <${URL}/auth/unsubscribe?id=${result.rows[0].id}&token=${result.rows[0].unsub_token}&email=${result.rows[0].email}>`
            }
        );

        await client.query('COMMIT');
    } catch (err) {
        console.error(err);
        try { await client.query('ROLLBACK'); } catch (e) { console.error('Rollback failed:', e); }
        if (err.code === '23505') {
            client.release();
            return res.status(400).json({ error: 'Email già registrata!' });
        }
        client.release();
        console.error(err);
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
        const email = await getUserEmailWithTelegramID(code);
        if (!email) return res.status(400).json({ error: 'Codice di conferma non valido!' });
        
        if (await getNumberNotification(email) > -1) return res.status(400).json({ error: 'Account già confermato!' });

        let gender = await getGenderByEmail(email);
        let name = await getFirstNameByEmail(email);
        let unsub_info = await getUnsubscribeInfoByEmail(email);

        // send welcome email
        try{
            await sendMailAsync(
                email,
                `Welcome!`,
                `<!doctype html><main style="font-family:Helvetica,Arial,Liberation Serif,sans-serif;background-color:#fff;color:#000"><table border=0 cellpadding=0 cellspacing=0 style="max-width:620px;border-collapse:collapse;margin:0 auto 0 auto;text-align:left;font-family:Helvetica,Arial,Liberation Serif,sans-serif"width=620px><tr style=background-color:#fff><td style="width:100%;padding:30px 7% 15px 7%"><a href=${URL}><img src=${URL}/email/v3/logo-long-allmuted-trasp.png style=width:70%;height:auto;color:#fff alt="FERMI NOTIFY"></a><tr style=background-color:#fff><td><table border=0 cellpadding=0 cellspacing=0 style="width:100%;background-color:#fff;padding:30px 7% 30px 7%;border:none;border-top:1px solid #ddd;border-bottom:1px solid #ddd;font-size:16px"><tr><td><h2 style="margin:10px 0">Benvenut${gender == "M" ? "o" : gender == "F" ? "a" : "ə"} a Fermi Notify!</h2><tr><td style=text-align:left><h4 style=margin-bottom:0>Ciao ${name}!</h4><p style=line-height:1.3;margin-top:10px;margin-bottom:10px>Grazie per esserti registrat${gender == "M" ? "o" : gender == "F" ? "a" : "ə"}, di seguito ci sono alcune indicazioni sul funzionamento di Fermi Notify.<h4 style=margin-bottom:0>Keyword</h4><p style=line-height:1.3;margin-top:10px;margin-bottom:10px>Nella <a href=${URL}/dashboard style="color:#004a77;text-decoration:none;border-bottom:1px solid #004a77"target=_blank>Dashboard</a> potrai inserire le tue <b>keyword</b>, necessarie per trovare le variazioni dell'orario che ti riguardano. Ti invitiamo ad aggiungere le parole che riconducono a te (il tuo cognome, la tua classe, i tuoi corsi, ecc...).<br>Presta attenzione alla <b>formattazione</b> delle keywords, dev'essere uguale a quella scritta nel calendario giornaliero (es. <i>4CIIN</i>, non "4 CIIN" o "4CIN")!<h4 style=margin-bottom:0>Notifiche</h4><p style=line-height:1.3;margin-top:10px;margin-bottom:10px>Vengono inviate notifiche sulle variazioni che contengono le tue keyword tramite email e/o Telegram. Puoi modificare le preferenze sulle notifiche nella <a href=${URL}/dashboard style="color:#004a77;text-decoration:none;border-bottom:1px solid #004a77"target=_blank>Dashboard</a>.<ul style=padding-top:0;line-height:1.3;margin-top:0><li>Se c'è una variazione dell'orario, riceverai una notifica che riassume tutte le variazioni della giornata alle <b>6 del giorno stesso</b>.<li>Se viene pubblicata una variazione dell'orario poche ore prima che si verifichi (es. sostituzione dell'ultimo minuto), verrai notificat${gender == "M" ? "o" : gender == "F" ? "a" : "ə"} <b>all'istante</b>.</ul><p style=margin-top:10px;margin-bottom:10px>Per maggiori informazioni, visita la <a href=${URL}/faq style="color:#004a77;text-decoration:none;border-bottom:1px solid #004a77"target=_blank>FAQ</a>.</table><tr style=background-color:#fff><td style="padding:15px 7% 30px 7%;font-size:13px;position:relative;background-color:#fff"><p style=color:#8b959e>Per supporto o informazioni, consulta la <a href=${URL}/faq style=color:#004a77>FAQ</a> o contattaci su Instagram <a href=${URL}/ig style=color:#004a77><i>@ferminotify</i></a>.</p><a href=${URL}><img src=${URL}/email/v3/icon-allmuted.png style=height:35px;margin-bottom:5px alt="Fermi Notify"></a><p style=margin:0;color:#8b959e><i style=color:#8b959e>Fermi Notify Team</i><p style=margin-top:0><a href=${URL} style=color:#004a77 target=_blank>fn.lkev.in</a><p style=color:#8b959e;font-size:12px>Hai ricevuto questa email perché ti sei registrat${gender == "M" ? "o" : gender == "F" ? "a" : "ə"} a Fermi Notify. Puoi disattivare le notifiche via mail <a href="${URL}/auth/unsubscribe?id=${unsub_info.id}&token=${unsub_info.unsub_token}&email=${email}" style="color:#004a77;text-decoration:none;border-bottom:1px solid #004a77"target=_blank>qui</a>.</table></main>`,
                `Ciao ${name}! Benvenuto a Fermi Notify! Esplora la Dashboard a ${URL}/dashboard per personalizzare le notifiche e visita ${URL}/faq per scoprire come funziona Fermi Notify.`,
                {
                    "List-Unsubscribe": `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${unsub_info.id}&token=${unsub_info.unsub_token}&email=${email}>, <${URL}/auth/unsubscribe?id=${unsub_info.id}&token=${unsub_info.unsub_token}&email=${email}>`
                },
            );
        } catch (err) {
            console.error("ERR WELCOME " + email + ": " + err);
            return res.status(500).json({ error: 'Errore interno!' });
        }

        const a = await incrementNumberNotification(code);
        
        return res.status(200).json({ message: 'Account confermato con successo! Ora puoi effettuare il login.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Errore interno!' });
    }
});

/* LOGIN */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM subscribers WHERE email = $1', [email]);
    if (result.rowCount === 0)
      return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    let refreshToken = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
    await pool.query(
        'INSERT INTO refresh_tokens (sub_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, refreshToken, expiresAt]
    );

    try {
        await pool.query(
            "UPDATE subscribers SET last_login = (NOW() AT TIME ZONE 'UTC') WHERE id = $1",
            [user.id]
        );
    } catch (e) {
        console.error('Failed to update last_login for user', user.id, e);
    }

    // TEMP use flag onboarding for all users, then use flag notification == -1 for first login TODO
    res.json({ token, refreshToken, onboarding: !user.onboarding });
    // update onboarding set to true after first login
    await pool.query('UPDATE subscribers SET onboarding = TRUE WHERE id = $1', [user.id]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/refresh_token', async (req, res) => {
    const { refreshToken } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
            [refreshToken]
        );
        if (result.rowCount === 0)
            return res.status(401).json({ error: 'Invalid or expired refresh token' });

        const tokenData = result.rows[0];
        const userResult = await pool.query('SELECT * FROM subscribers WHERE id = $1', [tokenData.sub_id]);
        const user = userResult.rows[0];

        const newAccessToken = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
            expiresIn: '1h',
        });

        const newExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

        await pool.query(
            'UPDATE refresh_tokens SET expires_at = $1 WHERE token = $2',
            [newExpiresAt, refreshToken]
        );

        res.json({ token: newAccessToken });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'No refresh token provided' });
  try {
    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
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
