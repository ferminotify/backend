// EJS rendering of the admin pages (views/). Every view gets `h`: formats, chart geometry and link() for the
// current request. Templates are compiled once and cached in production; in development they are reread.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import * as format from './helpers/format.js';
import * as charts from './helpers/charts.js';
import { link } from './lists.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, 'views');
const CSS = `\n${readFileSync(path.join(DIR, 'assets', 'admin.css'), 'utf8')}`;
const LOGO = readFileSync(path.join(DIR, 'assets', 'logo.svg'), 'utf8').replace('<svg ', '<svg aria-hidden="true" ');
export const MENU = [
  ['./', 'Panoramica'], ['utenti', 'Utenti'], ['email', 'Email'], ['notifiche', 'Notifiche'], ['push', 'Push'], ['log', 'Log'],
];
const OPTIONS = { root: ROOT, cache: process.env.NODE_ENV === 'production', strict: false };

const helpers = (req) => ({ ...format, ...charts, CSS, LOGO, MENU, link: (changes) => link(req, changes) });

export const renderView = (view, locals, req) =>
  ejs.renderFile(path.join(ROOT, `${view}.ejs`), { ...locals, h: helpers(req) }, OPTIONS);

export const renderPage = ({ view, title, locals, active: pageActive }, { active, ready }, req) =>
  ejs.renderFile(path.join(ROOT, 'layout.ejs'), { ...locals, title, active: pageActive || active, ready, pageView: `/${view}`, h: helpers(req) }, OPTIONS);
