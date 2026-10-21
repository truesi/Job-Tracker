import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { ROOT } from '../config.js';

export const router = express.Router();

const PREP_DIR = path.join(ROOT, 'prep');

const LANGS = ['en', 'ru'];

const readIfExists = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

// For 'ru' reads prep/ru/<file> and falls back to the English file in prep/
function readPrep(file, lang) {
  const translated = lang === 'ru' && readIfExists(path.join(PREP_DIR, 'ru', file));
  return translated ? { text: translated, name: `ru/${file}` } : { text: readIfExists(path.join(PREP_DIR, file)), name: file };
}

const langOf = (req) => (req.headers.cookie?.match(/(?:^|;\s*)prep_lang=(\w+)/)?.[1] === 'ru' ? 'ru' : 'en');

const anchor = (html) => html.replace(/<[^>]+>|&[#\w]+;/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

// Gives every h2 an id, opens external links in a new tab and, when deepUrl is set, links each section
// that the deep dive also has to its counterpart there
function render(md, deepUrl, deepIds = new Set()) {
  return marked.parse(md)
    .replace(/<h2>(.*?)<\/h2>/g, (_, text) => {
      const id = anchor(text);
      const more = deepIds.has(id) ? ` <a class="deep-link" href="${deepUrl}#${id}">подробнее →</a>` : '';
      return `<h2 id="${id}">${text}${more}</h2>`;
    })
    .replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http');
}

/**
 * Reads every topic from prep/: notes from <slug>.md, an optional deep dive from <slug>.deep.md
 * and questions from <slug>.quiz.json. For lang 'ru' each file is taken from prep/ru/ when it exists.
 * Throws on a malformed question.
 */
export function loadTopics(lang = 'en') {
  return fs.readdirSync(PREP_DIR).filter((f) => f.endsWith('.md') && !f.endsWith('.deep.md')).sort().map((f) => {
    const slug = f.slice(0, -3);
    const md = readPrep(f, lang).text;
    const quiz = readPrep(`${slug}.quiz.json`, lang);
    const questions = JSON.parse(quiz.text || '[]');
    questions.forEach((q, i) => {
      if (!q.q || q.options?.length !== 4 || ![0, 1, 2, 3].includes(q.answer) || !q.explain) {
        throw new Error(`${quiz.name}, question #${i + 1}: needs q, 4 options, answer 0-3 and explain`);
      }
    });
    const deep = readPrep(`${slug}.deep.md`, lang).text;
    return { slug, title: md.match(/^# (.+)$/m)?.[1] || slug, md, deep, questions };
  });
}

router.use('/prep', (req, res, next) => {
  res.locals.lang = langOf(req);
  next();
});

router.get('/prep/lang/:lang', (req, res) => {
  res.cookie('prep_lang', LANGS.includes(req.params.lang) ? req.params.lang : 'en', { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax' });
  const back = req.get('Referer') ? new URL(req.get('Referer')) : null;
  res.redirect(back?.pathname.startsWith('/prep') ? back.pathname + back.search : '/prep');
});

router.get('/prep', (req, res) => {
  res.render('prep', { title: 'Подготовка', topics: loadTopics(res.locals.lang) });
});

router.get('/prep/quiz', (req, res) => {
  const picked = [].concat(req.query.topics || []);
  const topics = loadTopics(res.locals.lang).filter((t) => !picked.length || picked.includes(t.slug));
  const questions = topics.flatMap((t) => t.questions.map((q) => ({ ...q, topic: t.title })));
  const n = Math.min(Math.max(Number(req.query.n) || 20, 1), 100);
  res.render('prep-quiz', { title: 'Квиз', questions, n, topics });
});

router.get('/prep/:slug', (req, res, next) => {
  const topic = loadTopics(res.locals.lang).find((t) => t.slug === req.params.slug);
  if (!topic) return next();
  const deepUrl = `/prep/${topic.slug}/deep`;
  const deepIds = new Set(topic.deep ? [...render(topic.deep).matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]) : []);
  res.render('prep-topic', { title: topic.title, topic, deep: false, html: render(topic.md, deepUrl, deepIds) });
});

router.get('/prep/:slug/deep', (req, res, next) => {
  const topic = loadTopics(res.locals.lang).find((t) => t.slug === req.params.slug);
  if (!topic?.deep) return next();
  res.render('prep-topic', { title: `${topic.title}: подробно`, topic, deep: true, html: render(topic.deep) });
});
