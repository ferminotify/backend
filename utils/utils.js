import pool from '../db.js';

async function getUserEmailWithTelegramID(telegramId) {
  try {
    const RES = await pool.query(
      `SELECT email FROM subscribers
        WHERE telegram = $1`,
      [telegramId]
    );
    return RES.rows[0].email;
  } catch (err) {
    console.error("ERR GET EMAIL WITH TG ID " + telegramId + ": " + err.stack);
  }
}

async function getNumberNotification(email){
  try{
    const RES = await pool.query(
      `SELECT notifications FROM subscribers
        WHERE email = $1`,
      [email]
    );
    return RES.rows[0].notifications;
  } catch (err) {
    console.error("ERR GET NUMBER NOTIFICATIONS " + email + ": " + err.stack);
  }
}

async function getGenderByEmail(email){
  try {
    const RES = await pool.query(
      `SELECT gender FROM subscribers
        WHERE email = $1`,
      [email]
    );
    return RES.rows[0].gender;
  } catch (err) {
    console.error("ERR GET USER GENDER BY EMAIL " + email + ": " + err.stack);
  }
}

async function getFirstNameByEmail(email){
  try{
    const RES = await pool.query(
      `SELECT name FROM subscribers
        WHERE email = $1`,
      [email]
    );
    return RES.rows[0].name;
  } catch (err) {
    console.error("ERR GET USER NAME BY EMAIL " + email + ": " + err.stack);
  }
}

async function getUnsubscribeInfoByEmail(email){
  try {
    const RES = await pool.query(
      `SELECT id, unsub_token, notification_preferences FROM subscribers
        WHERE email = $1`,
      [email]
    )
    return RES.rows[0];
  } catch (err) {
    return null;
  }
}

async function incrementNumberNotification(telegramId){
  try {
    const RES = await pool.query(
      `UPDATE subscribers
         SET notifications = notifications + 1
       WHERE telegram = $1 AND notifications = -1`,
      [telegramId]
    );
    console.log("SUCCESS CONFIRMATION TG ID: " + telegramId);
    return RES;
  } catch (err) {
    console.error("ERR ADD NOTIFICATIONS " + telegramId + ": " + err.stack);
  }
}

async function userExistsByEmail(email){
  try {
    const res = await pool.query(
      `SELECT * FROM subscribers
        WHERE email = $1`,
      [email]
    );
    return res.rows[0];
  } catch (err) {
    console.error("ERR USER EXISTS BY EMAIL " + email + ": " + err.stack);
  }
}

async function verifyUserOTP(email, otp) {
  try {
    const RES = await pool.query(
      `SELECT secret_temp, secret_temp_timestamp FROM subscribers WHERE email = $1`,
      [email]
    );
    if (RES.rows.length === 0) {
      return "Email non registrata";
    }
    const { secret_temp, secret_temp_timestamp } = RES.rows[0];
    const currentTime = Date.now();
    const otpValidityDuration = 15 * 60 * 1000; // 15 minutes in milliseconds

    if (currentTime - new Date(secret_temp_timestamp).getTime() > otpValidityDuration) {
      return "OTP scaduto";
    }

    if (secret_temp !== otp) {
      return "OTP non valido";
    }

    return "OK";
  } catch (err) {
    console.error("ERR VERIFY USER OTP " + email + ": " + err.stack);
    return "Errore durante la verifica dell'OTP";
  }
}


export { getUserEmailWithTelegramID, getNumberNotification, getGenderByEmail, getFirstNameByEmail, getUnsubscribeInfoByEmail, incrementNumberNotification, userExistsByEmail, verifyUserOTP };