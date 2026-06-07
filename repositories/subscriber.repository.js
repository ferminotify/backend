import defaultPool from '../db.js';

/**
 * Data-access layer for the `subscribers` table.
 *
 * Centralises every query that previously lived as one-off helpers in
 * `utils/utils.js`. Methods return `null` (not a thrown error) when no row
 * matches, so callers never hit `rows[0].col` on an empty result set.
 *
 * The pool is injected via the constructor (default = shared app pool) so the
 * repository can be unit-tested against a fake pool without a real database.
 */

// Columns needed across the auth flows. Selecting them once lets callers
// collapse several single-column lookups into a single round-trip.
const SUBSCRIBER_COLUMNS = [
    'id',
    'name',
    'surname',
    'email',
    'gender',
    'telegram',
    'notifications',
    'unsub_token',
    'notification_preferences',
    'secret_temp',
    'secret_temp_timestamp',
].join(', ');

const OTP_VALIDITY_MS = 15 * 60 * 1000; // 15 minutes

export class SubscriberRepository {
    constructor(pool = defaultPool) {
        this.pool = pool;
    }

    /** Full subscriber row by email, or null if not registered. */
    async findByEmail(email) {
        const res = await this.pool.query(
            `SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE email = $1`,
            [email]
        );
        return res.rows[0] ?? null;
    }

    /** Full subscriber row by Telegram id / confirmation code, or null. */
    async findByTelegram(telegramId) {
        const res = await this.pool.query(
            `SELECT ${SUBSCRIBER_COLUMNS} FROM subscribers WHERE telegram = $1`,
            [telegramId]
        );
        return res.rows[0] ?? null;
    }

    /**
     * Confirm a pending registration: bump notifications from the sentinel -1
     * to 0. No-op (0 rows) if already confirmed. Returns the pg result.
     */
    async incrementNotificationsByTelegram(telegramId) {
        return this.pool.query(
            `UPDATE subscribers
                SET notifications = notifications + 1
              WHERE telegram = $1 AND notifications = -1`,
            [telegramId]
        );
    }

    /**
     * Validate a password-reset OTP. Returns one of the Italian status strings
     * the routes already expect: 'OK', 'Email non registrata', 'OTP scaduto',
     * 'OTP non valido'. DB errors propagate to the caller's try/catch.
     */
    async verifyOTP(email, otp) {
        const res = await this.pool.query(
            `SELECT secret_temp, secret_temp_timestamp FROM subscribers WHERE email = $1`,
            [email]
        );
        if (res.rows.length === 0) return 'Email non registrata';

        const { secret_temp, secret_temp_timestamp } = res.rows[0];
        if (Date.now() - new Date(secret_temp_timestamp).getTime() > OTP_VALIDITY_MS) {
            return 'OTP scaduto';
        }
        if (secret_temp !== otp) return 'OTP non valido';
        return 'OK';
    }
}

// Shared singleton bound to the app pool — import this in routes.
export default new SubscriberRepository();
