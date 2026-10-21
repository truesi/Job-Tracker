import express from 'express';
import path from 'node:path';
import { ROOT, env } from './config.js';
import { migrate } from './migrate.js';
import { processInbox } from './inbox.js';
import { router as adminRouter } from './routes/admin.js';
import { router as vacancyRouter } from './routes/vacancies.js';
import { router as applicationRouter } from './routes/applications.js';
import { router as prepRouter } from './routes/prep.js';
import * as fmt from './format.js';
import { runStatus } from './collector.js';

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.locals.fmt = fmt;

app.use(express.static(path.join(ROOT, 'public')));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use((req, res, next) => { res.locals.path = req.path; res.locals.running = runStatus(); next(); });

// Express 4 does not catch rejected promises from async handlers
const wrap = (router) => {
  for (const layer of router.stack) {
    for (const l of layer.route?.stack || []) {
      const fn = l.handle;
      if (fn.constructor.name === 'AsyncFunction') l.handle = (req, res, next) => fn(req, res, next).catch(next);
    }
  }
  return router;
};

app.use(wrap(adminRouter));
app.use(wrap(vacancyRouter));
app.use(wrap(applicationRouter));
app.use(wrap(prepRouter));

app.use((req, res) => res.status(404).render('error', { title: 'Не найдено', message: 'Страница не найдена' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Ошибка', message: err.message });
});

await migrate();
app.listen(env.port, '127.0.0.1', () => console.log(`job-tracker: http://localhost:${env.port}`));

// Picks up files the collector drops into data/inbox
const tick = () => processInbox().catch((e) => console.error('inbox:', e.message));
tick();
setInterval(tick, env.inboxPollSeconds * 1000);
