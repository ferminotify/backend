import { z } from 'zod';

// Preserves the exact Italian messages the hand-written checks returned.
const REQUIRED = 'Tutti i campi sono obbligatori!';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const email = z
  .string({ error: REQUIRED })
  .trim()
  .toLowerCase()
  .min(1, REQUIRED)
  .regex(EMAIL_REGEX, 'Email non valida!');

export const registerSchema = z
  .object({
    name: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
    surname: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
    email,
    password: z.string({ error: REQUIRED }).min(1, REQUIRED).min(6, 'La password deve essere lunga almeno 6 caratteri!'),
    password2: z.string({ error: REQUIRED }).min(1, REQUIRED),
    gender: z.enum(['M', 'F', 'X'], { error: 'Genere non valido!' }),
  })
  .refine((d) => d.password === d.password2, {
    message: 'Le password non corrispondono!',
    path: ['password2'],
  });

export const loginSchema = z.object({
  email,
  password: z.string({ error: REQUIRED }).min(1, REQUIRED),
});

// Password-reset flow. These endpoints validated only presence (no email regex)
// and used their own messages, preserved here.
export const requestResetSchema = z.object({
  email: z.string({ error: 'Email non fornita' }).trim().toLowerCase().min(1, 'Email non fornita'),
});

const OTP_REQUIRED = 'Email o codice OTP non forniti';
export const otpSchema = z.object({
  email: z.string({ error: OTP_REQUIRED }).trim().toLowerCase().min(1, OTP_REQUIRED),
  otp: z.string({ error: OTP_REQUIRED }).trim().toUpperCase().min(1, OTP_REQUIRED),
});

const MISSING = 'Dati mancanti';
export const newPasswordSchema = z
  .object({
    email: z.string({ error: MISSING }).trim().toLowerCase().min(1, MISSING),
    otp: z.string({ error: MISSING }).trim().toUpperCase().min(1, MISSING),
    newPassword: z.string({ error: MISSING }).min(1, MISSING).min(6, 'La password deve essere lunga almeno 6 caratteri'),
    newPassword2: z.string({ error: MISSING }).min(1, MISSING),
  })
  .refine((d) => d.newPassword === d.newPassword2, {
    message: 'Le password non corrispondono',
    path: ['newPassword2'],
  });
