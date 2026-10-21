// Auto-submit filter forms on change
document.querySelectorAll('form[data-autosubmit]').forEach((form) => {
  form.querySelectorAll('select, input[type=checkbox]').forEach((el) => el.addEventListener('change', () => form.submit()));
});

// Upload a single file as the raw request body
document.querySelectorAll('form[data-upload]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = form.elements.file.files[0];
    if (file.size > 10 * 1024 * 1024) return window.alert('Файл больше 10 МБ');
    const res = await fetch(form.dataset.upload, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
    if (res.ok) window.location = res.url;
    else window.alert(await res.text());
  });
});

// Confirm destructive actions
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (e) => { if (!window.confirm(form.dataset.confirm)) e.preventDefault(); });
});

// Live progress of a manual collector run (banner rendered by partials/header.ejs)
const banner = document.getElementById('run-banner');
if (banner) {
  const STALL_MS = 3 * 60 * 1000;
  const field = (name) => banner.querySelector(`[data-${name}]`);
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  let status = null;
  const tick = () => {
    if (!status) return;
    field('elapsed').textContent = mmss(Date.now() - new Date(status.startedAt));
    const stalled = Date.now() - new Date(status.lastEventAt) > STALL_MS;
    field('stall').hidden = !stalled;
    banner.classList.toggle('run-banner-warn', stalled);
  };
  const timer = setInterval(tick, 1000);
  const done = (last) => {
    clearInterval(timer);
    banner.className = `run-banner ${last?.error ? 'run-banner-bad' : 'run-banner-done'}`;
    banner.innerHTML = last?.error
      ? '<div><b>Сбор завершился с ошибкой.</b> <a href="/settings">Подробнее</a></div>'
      : '<div><b>Сбор завершён.</b> Новые вакансии появятся в списке в течение минуты. <a href="/settings">Отчёт и расход токенов</a></div>';
  };
  const poll = async () => {
    try {
      const { running, lastRun } = await (await fetch('/api/collector-status')).json();
      if (!running) return done(lastRun);
      status = running;
      field('expected').textContent = running.expectedSec ? ` из обычных ~${Math.max(1, Math.round(running.expectedSec / 60))} мин` : '';
      field('action').textContent = running.lastAction || 'Запускается…';
      field('steps').textContent = running.steps;
      field('vacancies').textContent = running.vacancies;
      field('tokens').textContent = running.tokens.toLocaleString('ru-RU');
      tick();
    } catch {}
    setTimeout(poll, 5000);
  };
  poll();
}

// Check or uncheck every checkbox of the form
document.querySelectorAll('[data-toggle-all]').forEach((btn) => btn.addEventListener('click', () => {
  const boxes = [...btn.form.querySelectorAll('input[type=checkbox]')];
  const on = !boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = on; });
}));

// Interview prep quiz (views/prep-quiz.ejs): one question at a time, explanation after each answer
const quiz = document.getElementById('prep-quiz');
if (quiz) {
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  const codeBlock = (q) => (q.code ? `<pre><code>${esc(q.code)}</code></pre>` : '');
  const questions = shuffle(JSON.parse(document.getElementById('prep-quiz-data').textContent))
    .slice(0, Number(quiz.dataset.n))
    .map((q) => {
      const order = shuffle([0, 1, 2, 3]);
      return { ...q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) };
    });
  const missed = [];
  let idx = 0;
  let answered = false;
  let done = false;

  const show = () => {
    const q = questions[idx];
    answered = false;
    quiz.innerHTML = `
      <div class="pq-head muted small"><span>${idx + 1} / ${questions.length}</span><span class="tag">${esc(q.topic)}</span></div>
      <p class="pq-q">${md(q.q)}</p>
      ${codeBlock(q)}
      <div class="pq-options">${q.options.map((o, i) => `<button type="button" class="pq-opt" data-i="${i}"><b>${i + 1}</b><span>${md(o)}</span></button>`).join('')}</div>
      <div class="pq-explain" hidden></div>
      <button type="button" class="btn" data-next hidden>${idx + 1 < questions.length ? 'Дальше' : 'Результат'}</button>`;
  };
  const answer = (i) => {
    if (answered) return;
    answered = true;
    const q = questions[idx];
    const opts = quiz.querySelectorAll('.pq-opt');
    opts.forEach((b) => { b.disabled = true; });
    opts[q.answer].classList.add('pq-right');
    if (i !== q.answer) { opts[i].classList.add('pq-wrong'); missed.push(q); }
    const ex = quiz.querySelector('.pq-explain');
    ex.innerHTML = `<b>${i === q.answer ? 'Верно.' : 'Неверно.'}</b> ${md(q.explain)}`;
    ex.hidden = false;
    quiz.querySelector('[data-next]').hidden = false;
  };
  const finish = () => {
    done = true;
    const right = questions.length - missed.length;
    quiz.innerHTML = `
      <h2>${right} из ${questions.length} (${Math.round((right / questions.length) * 100)}%)</h2>
      ${missed.length ? '<p class="muted">Ошибки:</p>' : '<p>Без ошибок.</p>'}
      ${missed.map((q) => `<div class="pq-missed">
        <div class="muted small">${esc(q.topic)}</div>
        <p class="pq-q">${md(q.q)}</p>${codeBlock(q)}
        <p><b>Ответ:</b> ${md(q.options[q.answer])}</p>
        <p class="muted">${md(q.explain)}</p></div>`).join('')}
      <div class="btn-row"><a class="btn" href="${esc(window.location.href)}">Ещё раз</a><a class="btn btn-ghost" href="/prep">К темам</a></div>`;
  };
  const next = () => {
    idx += 1;
    if (idx < questions.length) show(); else finish();
  };

  quiz.addEventListener('click', (e) => {
    const opt = e.target.closest('.pq-opt');
    if (opt) answer(Number(opt.dataset.i));
    else if (e.target.closest('[data-next]')) next();
  });
  document.addEventListener('keydown', (e) => {
    if (done || e.target.closest('button, input, select, textarea')) return;
    if (!answered && e.key >= '1' && e.key <= '4') answer(Number(e.key) - 1);
    else if (answered && e.key === 'Enter') next();
  });
  show();
}
