# Job Tracker

Личный трекер поиска работы: локальная база вакансий и откликов. Пользователь — Senior Java/Kotlin бэкендер
из Алматы. Ищет удалёнку, релокацию (EU, AE) и казахстанские компании (удалёнка из Алматы или гибрид).
Подробности для пользователя в [README.md](README.md), инструкция сборщика в [docs/COLLECTOR.md](docs/COLLECTOR.md).

## Стек и запуск

Node.js 20+ (ESM), Express 4, EJS, `pg` без ORM, PostgreSQL 16 в Docker на `localhost:5433`.

```bash
npm run db:up   # Postgres
npm run dev     # сервер с --watch, миграции применяются при старте
npm run migrate # только миграции
```

Тестов и линтера нет. Проверять правки запуском сервера и открытием страницы на `http://localhost:3000`.

## Как устроено

Приложение ничего не скрапит. Вакансии собирает Claude через Chrome по [docs/COLLECTOR.md](docs/COLLECTOR.md):
читает `collector.config.json`, ищет на площадках и пишет JSON в `data/inbox/`.

```
collector (Claude) -> data/inbox/*.json -> inbox.js (раз в INBOX_POLL_SECONDS) -> importer.js -> Postgres
                                                                    -> data/imported/ или data/failed/ (+ .error.txt)
```

- [src/importer.js](src/importer.js): upsert по `(source, external_id)`, кросс-площадочные дубли по нормализованным
  компании и названию за 60 дней (`duplicate_of`). Поля пользователя (`status`, `notes`) импорт не трогает.
- [src/normalize.js](src/normalize.js): страна в ISO-2, нормализация названий, зарплата в net USD/месяц и `salary_fit`.
- [src/stats.js](src/stats.js): дашборд и воронка. Воронка идёт по view `application_state` (самый дальний этап,
  `rejected`/`withdrawn` не двигают воронку).
- [src/routes/](src/routes/): `admin.js` (дашборд, профиль, настройки, API), `vacancies.js`, `applications.js`.
  Все формы обычные POST + redirect, JS на клиенте минимальный ([public/app.js](public/app.js)).
- [src/routes/prep.js](src/routes/prep.js): подготовка к собеседованиям, без БД. Конспекты `prep/NN-slug.md`, разборы `prep/NN-slug.deep.md` (рендер `marked`)
  и вопросы `prep/NN-slug.quiz.json`, формат в README. Русская версия в `prep/ru/` с теми же именами, язык из cookie `prep_lang`,
  без файла на выбранном языке берётся английский. Меняешь английский контент, обнови и русский. Игра целиком на клиенте (блок `#prep-quiz` в `public/app.js`).
- [src/format.js](src/format.js): русские подписи для enum-значений, доступны во вьюхах как `fmt`.

## Конфиг сборщика

`collector.config.json` в `.gitignore`, это личные настройки. При первом запуске копируется из
`collector.config.example.json`. Новый ключ добавлять в оба файла. Правится через `/profile` (опросник + JSON) или руками.
`onboarded: false` в свежем конфиге: `/` редиректит на `/profile`, пока форма не сохранена.
Читают его и приложение (зарплатный порог, курсы, налоговые доли), и сборщик (запросы, регионы).
Сохранение профиля пересчитывает зарплаты всех вакансий по новым курсам и порогу.

Кнопка "Собрать сейчас" на `/settings` ([src/collector.js](src/collector.js)) запускает `claude -p --chrome --output-format stream-json --verbose` из корня проекта
по отмеченным площадкам профиля. Прогресс по событиям потока отдаёт `GET /api/collector-status`, его показывает плашка в шапке.
По завершении отчёт, токены (сумма по `modelUsage`) и стоимость пишутся в таблицу `collector_runs`.
Сервер слушает только `127.0.0.1`: кнопка запускает процесс на машине пользователя.

Поменять поведение сборщика: править `docs/COLLECTOR.md` и конфиг, код приложения обычно не нужен.

## Правила для изменений

- Схема меняется только новой миграцией `migrations/NNN_*.sql`, старые не редактировать: они уже применены
  (таблица `schema_migrations`).
- Enum-поля (`status`, `remote_type`, `open_to_kz`, `salary_fit` и др.) закреплены `CHECK` в БД. Новое значение:
  миграция на constraint + подпись в `format.js` + вьюхи с фильтрами.
- SQL писать прямо в роутах через `query()`/`tx()` из [src/db.js](src/db.js), параметры только через `$1`.
- Формат файла сборщика описан в README ("Формат файла сборщика"). Меняется формат — обновить README,
  `docs/COLLECTOR.md` и `importer.js` вместе.
- Тексты интерфейса на русском, комментарии в коде на английском.
- `data/` в git не попадает, кроме `.gitkeep`.
