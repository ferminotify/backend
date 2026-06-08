import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSchema, loginSchema, requestResetSchema, otpSchema, newPasswordSchema } from './auth.schemas.js';

const validReg = { name: 'Mario', surname: 'Rossi', email: 'M@X.IT', password: 'secret1', password2: 'secret1', gender: 'M' };

function firstError(schema, data) {
  const r = schema.safeParse(data);
  return r.success ? null : r.error.issues[0].message;
}

test('register: valid input trims name and lowercases email', () => {
  const r = registerSchema.safeParse({ ...validReg, name: '  Mario  ', email: '  M@X.IT ' });
  assert.equal(r.success, true);
  assert.equal(r.data.name, 'Mario');
  assert.equal(r.data.email, 'm@x.it');
});

test('register: missing field → required message', () => {
  const { surname, ...noSurname } = validReg;
  assert.equal(firstError(registerSchema, noSurname), 'Tutti i campi sono obbligatori!');
});

test('register: password mismatch', () => {
  assert.equal(firstError(registerSchema, { ...validReg, password2: 'other1' }), 'Le password non corrispondono!');
});

test('register: short password', () => {
  assert.equal(firstError(registerSchema, { ...validReg, password: 'a1', password2: 'a1' }), 'La password deve essere lunga almeno 6 caratteri!');
});

test('register: invalid gender', () => {
  assert.equal(firstError(registerSchema, { ...validReg, gender: 'Z' }), 'Genere non valido!');
});

test('register: invalid email', () => {
  assert.equal(firstError(registerSchema, { ...validReg, email: 'not-an-email' }), 'Email non valida!');
});

test('login: valid lowercases email', () => {
  const r = loginSchema.safeParse({ email: 'A@B.IT', password: 'x' });
  assert.equal(r.success, true);
  assert.equal(r.data.email, 'a@b.it');
});

test('login: missing password → required', () => {
  assert.equal(firstError(loginSchema, { email: 'a@b.it' }), 'Tutti i campi sono obbligatori!');
});

test('request reset: missing email → specific message', () => {
  assert.equal(firstError(requestResetSchema, {}), 'Email non fornita');
});

test('otp: missing fields → specific message; otp uppercased', () => {
  assert.equal(firstError(otpSchema, { email: 'a@b.it' }), 'Email o codice OTP non forniti');
  const r = otpSchema.safeParse({ email: 'A@B.it', otp: 'ab12cd' });
  assert.equal(r.data.otp, 'AB12CD');
  assert.equal(r.data.email, 'a@b.it');
});

test('new password: missing → Dati mancanti; mismatch; short', () => {
  assert.equal(firstError(newPasswordSchema, { email: 'a@b.it', otp: 'X' }), 'Dati mancanti');
  assert.equal(firstError(newPasswordSchema, { email: 'a@b.it', otp: 'X', newPassword: 'secret1', newPassword2: 'other1' }), 'Le password non corrispondono');
  assert.equal(firstError(newPasswordSchema, { email: 'a@b.it', otp: 'X', newPassword: 'a1', newPassword2: 'a1' }), 'La password deve essere lunga almeno 6 caratteri');
});
