// Activities only some students take part in (help desks, peer tutoring, competitions,
// meetings for class representatives). Listed for a whole year or group of classes
// ("CLASSI 2^ IT - SPORTELLO FISICA"), they are not news for every class of that year:
// notified only to users who opted in (subscribers.notify_optin), or when the title names
// the user's class. /orario shows them all anyway.
import { textWords } from './merge.js';

export const OPT_IN = {
  sportelli: {
    label: 'Sportelli',
    description: 'Sportelli di matematica, fisica, chimica… per anno o indirizzo',
    example: 'CLASSI 2^ IT - AULA 10 - SPORTELLO FISICA',
    words: [/^SPORTELL/],
  },
  tutoring: {
    label: 'Peer tutoring',
    description: 'Lezioni tenute da studenti tutor',
    example: 'PEER TUTORING FISICA - TUTOR (3A) - CLASSI PRIME',
    words: [/^TUTOR/],
  },
  olimpiadi: {
    label: 'Olimpiadi e gare',
    description: 'Olimpiadi, gare e allenamenti',
    example: 'OLIMPIADI DELLA MATEMATICA - CLASSI TRIENNIO',
    words: [/^OLIMPIAD/],
  },
  rappresentanti: {
    label: 'Rappresentanti',
    description: 'Incontri per i rappresentanti di classe',
    example: 'INCONTRO DS CON RAPPRESENTANTI CLASSI 1^',
    words: [/^RAPPRESENTANT/],
  },
};

// A few students per class ("2 STUDENTI PER CIASCUNA CLASSE", "MAX 3 STUDENTI"): chosen by
// the school, nobody can opt in beforehand. Never notified to a whole year.
const FEW_STUDENTS = /\b\d+\s*(STUDENT|ALUNN)/;

/** Valid opt-in ids only, no duplicates. */
export const cleanOptIn = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => Object.hasOwn(OPT_IN, id)))];

/**
 * The opt-in category of a title, `'few'` for few-students events, or null.
 * @param {string} summary
 */
export function optInCategory(summary) {
  const words = textWords(summary);
  for (const [id, c] of Object.entries(OPT_IN)) {
    if (words.some((w) => c.words.some((re) => re.test(w)))) return id;
  }
  // On the raw title: the words merge "2 STUDENTI" as if it were a class code ("2STUDENTI").
  if (FEW_STUDENTS.test(String(summary || '').toUpperCase())) return 'few';
  return null;
}
