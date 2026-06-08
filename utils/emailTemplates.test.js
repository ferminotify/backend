import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationEmailHtml, confirmationEmailText } from './emailTemplates.js';

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
