import express from 'express';
import { query } from '../db.js';
import { readCollectorConfig } from '../config.js';

export const router = express.Router();

router.get('/applications', async (req, res) => {
  const ghostDays = readCollectorConfig().ghosted_after_days;
  const view = ['open', 'closed', 'ghosted', 'all'].includes(req.query.view) ? req.query.view : 'open';
  const filters = {
    open: 'NOT s.is_closed',
    closed: 's.is_closed',
    ghosted: `NOT s.is_closed AND COALESCE(s.last_event_at, s.applied_at) < now() - ($1 || ' days')::interval`,
    all: 'true',
  };
  const { rows } = await query(
    `SELECT a.*, v.title, v.company, v.source, v.url, v.location_country, v.remote_type,
            s.last_event, s.last_event_at, s.max_rank, s.is_closed, s.first_response_at, et.label AS stage_label,
            EXTRACT(DAY FROM now() - COALESCE(s.last_event_at, s.applied_at))::int AS days_idle
     FROM applications a
     JOIN vacancies v ON v.id = a.vacancy_id
     JOIN application_state s ON s.application_id = a.id
     LEFT JOIN event_types et ON et.code = s.last_event
     WHERE ${filters[view]} AND $1::int IS NOT NULL
     ORDER BY COALESCE(s.last_event_at, s.applied_at) DESC`,
    [ghostDays],
  );
  res.render('applications', { title: 'Отклики', rows, view, ghostDays });
});

router.post('/applications/:id', async (req, res) => {
  const b = req.body;
  const { rows: [a] } = await query(
    `UPDATE applications SET applied_at = COALESCE($2, applied_at), channel = $3, cv_version = $4, contact = $5, notes = $6
     WHERE id = $1 RETURNING vacancy_id`,
    [Number(req.params.id), b.applied_at ? new Date(b.applied_at) : null, b.channel || null, b.cv_version || null, b.contact || null, b.notes || null],
  );
  res.redirect(`/vacancies/${a.vacancy_id}?msg=saved`);
});

router.post('/applications/:id/events', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  await query(
    'INSERT INTO application_events (application_id, type, happened_at, note) VALUES ($1,$2,$3,$4)',
    [id, b.type, b.happened_at ? new Date(b.happened_at) : new Date(), b.note || null],
  );
  const { rows: [a] } = await query('SELECT vacancy_id FROM applications WHERE id = $1', [id]);
  const back = /^\/(applications|vacancies)(\?|$)/.test(b.back) ? b.back : `/vacancies/${a.vacancy_id}?msg=event`;
  res.redirect(back);
});

router.post('/events/:id/delete', async (req, res) => {
  const { rows: [r] } = await query(
    `DELETE FROM application_events e USING applications a
     WHERE e.id = $1 AND a.id = e.application_id RETURNING a.vacancy_id`, [Number(req.params.id)]);
  res.redirect(r ? `/vacancies/${r.vacancy_id}` : '/applications');
});

router.post('/applications/:id/delete', async (req, res) => {
  const { rows: [r] } = await query('DELETE FROM applications WHERE id = $1 RETURNING vacancy_id', [Number(req.params.id)]);
  res.redirect(r ? `/vacancies/${r.vacancy_id}` : '/applications');
});
