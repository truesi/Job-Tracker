import express from 'express';
import { query, tx } from '../db.js';

export const router = express.Router();

const PAGE_SIZE = 50;
const SORTS = {
  score: 'v.match_score DESC NULLS LAST, v.first_seen_at DESC',
  new: 'v.first_seen_at DESC',
  posted: 'v.posted_at DESC NULLS LAST',
  salary: 'COALESCE(v.salary_net_usd_max, v.salary_net_usd_min) DESC NULLS LAST',
  company: 'v.company_norm ASC NULLS LAST',
};

router.get('/vacancies', async (req, res) => {
  const f = {
    q: req.query.q || '', source: req.query.source || '', remote: req.query.remote || '',
    country: req.query.country || '', fit: req.query.fit || '', status: req.query.status || '',
    kz: req.query.kz || '', applied: req.query.applied || '', min_score: req.query.min_score || '',
    dups: req.query.dups || '', sort: SORTS[req.query.sort] ? req.query.sort : 'score',
  };
  const page = Math.max(1, Number(req.query.page) || 1);
  const where = [];
  const params = [];
  // each "?" in sql consumes the next value
  const add = (sql, ...values) => {
    where.push(sql.replace(/\?/g, () => { params.push(values.shift()); return `$${params.length}`; }));
  };

  if (f.q) {
    const like = `%${f.q}%`;
    add(`(v.title ILIKE ? OR v.company ILIKE ? OR v.description ILIKE ?
          OR EXISTS (SELECT 1 FROM unnest(v.stack) st WHERE st ILIKE ?))`, like, like, like, f.q);
  }
  if (f.source) add('v.source = ?', f.source);
  if (f.remote) add('v.remote_type = ?', f.remote);
  if (f.country) add('v.location_country = ?', f.country.toUpperCase());
  if (f.fit) add('v.salary_fit = ?', f.fit);
  if (f.status) add('v.status = ?', f.status);
  else where.push(`v.status NOT IN ('skipped','closed','applied_before')`);
  if (f.kz) add('v.open_to_kz = ?', f.kz);
  if (f.min_score) add('v.match_score >= ?', Number(f.min_score));
  if (f.applied === 'yes') where.push('a.id IS NOT NULL');
  if (f.applied === 'no') where.push('a.id IS NULL');
  if (f.dups !== 'show') where.push('v.duplicate_of IS NULL');

  const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const base = `FROM vacancies v
                LEFT JOIN applications a ON a.vacancy_id = v.id
                LEFT JOIN application_state s ON s.application_id = a.id
                LEFT JOIN event_types et ON et.code = s.last_event
                ${sqlWhere}`;

  const [{ rows }, { rows: [{ n }] }, { rows: sources }, { rows: countries }] = await Promise.all([
    query(`SELECT v.id, v.source, v.url, v.title, v.company, v.location_country, v.location_city,
                  v.remote_type, v.remote_region, v.relocation, v.visa_sponsorship, v.open_to_kz,
                  v.salary_net_usd_min, v.salary_net_usd_max, v.salary_fit, v.salary_min, v.salary_max, v.salary_currency, v.salary_period,
                  v.match_score, v.status, v.stack, v.posted_at, v.first_seen_at, v.duplicate_of,
                  a.id AS application_id, et.label AS stage_label, s.is_closed, s.last_event
           ${base} ORDER BY ${SORTS[f.sort]} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    query(`SELECT COUNT(*) AS n ${base}`, params),
    query(`SELECT DISTINCT source FROM vacancies ORDER BY 1`),
    query(`SELECT DISTINCT location_country FROM vacancies WHERE location_country IS NOT NULL ORDER BY 1`),
  ]);

  res.render('vacancies', {
    title: 'Вакансии', originalUrl: req.originalUrl, rows, total: n, page, pages: Math.max(1, Math.ceil(n / PAGE_SIZE)), f,
    sources: sources.map((r) => r.source), countries: countries.map((r) => r.location_country),
  });
});

router.get('/vacancies/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [v] } = await query('SELECT * FROM vacancies WHERE id = $1', [id]);
  if (!v) return res.status(404).render('error', { title: 'Не найдено', message: 'Вакансия не найдена' });

  const [{ rows: [app] }, { rows: dups }, { rows: types }] = await Promise.all([
    query(`SELECT a.*, s.last_event, s.max_rank, s.is_closed FROM applications a
           JOIN application_state s ON s.application_id = a.id WHERE a.vacancy_id = $1`, [id]),
    query(`SELECT id, source, url, title, company FROM vacancies
           WHERE (duplicate_of = $1 OR id = $2) AND id <> $1`, [id, v.duplicate_of]),
    query('SELECT * FROM event_types ORDER BY rank, code'),
  ]);
  let events = [];
  if (app) {
    ({ rows: events } = await query(
      `SELECT e.*, t.label FROM application_events e JOIN event_types t ON t.code = e.type
       WHERE e.application_id = $1 ORDER BY e.happened_at, e.id`, [app.id]));
  }
  res.render('vacancy', { title: v.title, v, app, events, dups, types, msg: req.query.msg });
});

router.post('/vacancies/:id', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const tri = (x) => (x === 'true' ? true : x === 'false' ? false : null);
  await query(
    `UPDATE vacancies SET status = $2, notes = $3, open_to_kz = $4, relocation = $5, visa_sponsorship = $6,
            match_score = $7, updated_at = now() WHERE id = $1`,
    [id, b.status, b.notes || null, b.open_to_kz, tri(b.relocation), tri(b.visa_sponsorship),
      b.match_score === '' || b.match_score == null ? null : Number(b.match_score)],
  );
  res.redirect(`/vacancies/${id}?msg=saved`);
});

router.post('/vacancies/:id/apply', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const appliedAt = b.applied_at ? new Date(b.applied_at) : new Date();
  await tx(async (c) => {
    const { rows: [a] } = await c.query(
      `INSERT INTO applications (vacancy_id, applied_at, channel, cv_version, contact, notes)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (vacancy_id) DO NOTHING RETURNING id`,
      [id, appliedAt, b.channel || null, b.cv_version || null, b.contact || null, b.notes || null],
    );
    if (a) {
      await c.query(`INSERT INTO application_events (application_id, type, happened_at) VALUES ($1,'applied',$2)`, [a.id, appliedAt]);
      await c.query(`UPDATE vacancies SET status = 'shortlisted', updated_at = now() WHERE id = $1 AND status = 'new'`, [id]);
    }
  });
  res.redirect(`/vacancies/${id}?msg=applied`);
});

router.post('/vacancies/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  if (!['skipped', 'applied_before'].includes(req.body.status)) return res.status(400).render('error', { title: 'Ошибка', message: 'Неизвестный статус' });
  await query('UPDATE vacancies SET status = $2, updated_at = now() WHERE id = $1', [id, req.body.status]);
  res.redirect(`/vacancies/${id}?msg=saved`);
});
