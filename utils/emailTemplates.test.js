import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationEmailHtml, confirmationEmailText, passwordResetEmailHtml, passwordResetEmailText, welcomeEmailHtml, welcomeEmailText } from './emailTemplates.js';

test('confirmation html embeds the confirm link (button + fallback)', () => {
  const html = confirmationEmailHtml({ safeName: 'Mario', gender: 'M', confirmLink: 'https://x/c/ABC' });
  assert.equal(html.split('https://x/c/ABC').length - 1, 3); // href button + fallback href + visible text
  assert.match(html, /Ciao Mario!/);
});

test('confirmation html keeps footer logo small (regression: was width:70%)', () => {
  const html = confirmationEmailHtml({ safeName: 'X', gender: 'F', confirmLink: 'l' });
  assert.match(html, /icon-allmuted\.png style=height:35px/);
  assert.doesNotMatch(html, /icon-allmuted\.png style=width:70%/);
});

test('gender suffix: M→o, F→a, other→ə', () => {
  assert.match(confirmationEmailHtml({ safeName: 'X', gender: 'M', confirmLink: 'l' }), /registrato a/);
  assert.match(confirmationEmailHtml({ safeName: 'X', gender: 'F', confirmLink: 'l' }), /registrata a/);
  assert.match(confirmationEmailHtml({ safeName: 'X', gender: 'X', confirmLink: 'l' }), /registratə a/);
});

test('confirmation text contains name and link', () => {
  const txt = confirmationEmailText({ name: 'Ada', confirmLink: 'https://x/c/ABC' });
  assert.match(txt, /Ciao Ada!/);
  assert.match(txt, /https:\/\/x\/c\/ABC/);
});

test('password reset html renders each of the 6 code chars in its own cell', () => {
  const html = passwordResetEmailHtml({ safeName: 'Ada', code: 'AB12CD', unsubInfo: { id: 7, unsub_token: 'T' }, email: 'a@b.it' });
  for (const ch of 'AB12CD') assert.match(html, new RegExp(`font-size:24px>${ch}</h1>`));
  assert.match(html, /icon-allmuted\.png" style=height:35px/); // footer small
  assert.match(html, /id=7&token=T&email=a@b\.it/);
});

test('password reset text contains name and full code', () => {
  const txt = passwordResetEmailText({ name: 'Ada', code: 'AB12CD' });
  assert.match(txt, /Ciao Ada,/);
  assert.match(txt, /è: AB12CD\./);
});

test('welcome html: gender greeting + small footer + unsub link', () => {
  const html = welcomeEmailHtml({ safeName: 'Ada', gender: 'F', unsubInfo: { id: 9, unsub_token: 'Z' }, email: 'a@b.it' });
  assert.match(html, /Benvenuta a Fermi Notify!/);
  assert.match(html, /Ciao Ada!/);
  assert.match(html, /icon-allmuted\.png style=height:35px/);
  assert.match(html, /id=9&token=Z&email=a@b\.it/);
});

test('welcome text contains name', () => {
  assert.match(welcomeEmailText({ name: 'Ada' }), /Ciao Ada! Benvenuto/);
});
