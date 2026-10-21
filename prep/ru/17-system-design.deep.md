# Основы system design: подробно

Здесь разделы краткого конспекта разобраны глубже, с разобранными примерами. Для senior-позиции бэкенда интервьюеров меньше интересует рисование квадратиков и больше компромиссы, обработка отказов и числа.

## Как вести интервью

### Тайминг на 45 минут
| Минуты | Шаг |
|---|---|
| 0–5 | Требования: функции, пользователи, масштаб, задержка, нужная согласованность. Запиши их. |
| 5–10 | Оценки: QPS (средний и пиковый), объём хранения, трафик. |
| 10–15 | API (эндпоинты или сообщения) и модель данных (сущности, ключи, паттерны доступа). |
| 15–25 | Высокоуровневый дизайн: проведи через него один запрос на чтение и один на запись. |
| 25–40 | Углубления, которые выберет интервьюер: узкие места, масштабирование, сценарии отказов. |
| 40–45 | Итог, компромиссы, что сделал бы при большем времени. |

### Разобранная оценка: сокращатель ссылок
- 100M новых ссылок в месяц → ~40 записей/с в среднем (100M / 2.6M с), скажем, 400/с в пике.
- Соотношение чтение:запись 100:1 → ~4 000 редиректов/с в среднем, ~40 000/с в пике.
- Хранение: 500 байт на ссылку × 100M × 12 месяцев × 5 лет = 3 ТБ. Влезает в одну шардированную или даже в одну большую базу; легко влезает в key-value хранилище.
- Горячий набор: 20% ссылок получают 80% трафика. Кэш на 20% активных за день ссылок влезает в несколько ГБ Redis.

Вывод вслух: "Много чтения, мало данных, чувствительные к задержке редиректы. Фокус на кэше и генерации ID; база не узкое место."

Подробнее: [System Design Primer](https://github.com/donnemartin/system-design-primer) · [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832)

## Строительные блоки масштабирования

### Обычный путь растущего сервиса
1. Один сервер с приложением и БД.
2. Отдельный сервер БД; балансировщик с несколькими stateless-экземплярами приложения.
3. Кэш (Redis) для горячих чтений; CDN для статики.
4. Реплики для чтения; асинхронная работа уезжает в очереди и воркеры.
5. Партиционирование больших таблиц; разделение сервисов по доменным границам.
6. Шардирование данных с интенсивной записью; мультирегион.
Сказать, где на этом пути находится система и зачем нужен следующий шаг, это сильный ответ.

### Инвалидация кэша, честно
- **Только TTL**: просто, устаревание ограничено. Часто этого достаточно.
- **Вытеснение при записи** (cache-aside): обновить БД, затем удалить ключ кэша. Удалять безопаснее, чем обновлять кэш: два конкурентных писателя могут положить значения в кэш в неправильном порядке.
- Гонка всё равно есть: читатель может загрузить старое значение из БД и записать его в кэш после удаления писателем. Короткие TTL ограничивают ущерб; версионированные значения или инвалидация через CDC (Debezium → evict) закрывают дыру.
- **Негативное кэширование**: ненадолго кэшируй "не найдено", чтобы отсутствующие ключи не ходили каждый раз в БД (и как защита от перебора).

### CQRS на практике
Модель записи: нормализованные таблицы с ограничениями и транзакциями. Модель чтения: денормализованные представления (поисковый индекс, заранее посчитанный JSON-документ на страницу), обновляемые по событиям. Чтение масштабируется независимо, ценой eventual consistency между моделями.

Подробнее: [AWS: caching best practices](https://aws.amazon.com/caching/best-practices/) · [Martin Fowler: CQRS](https://martinfowler.com/bliki/CQRS.html)

## Паттерны надёжности

### Таймауты и повторы, конкретно
```yaml
resilience4j:
  circuitbreaker:
    instances:
      payments:
        sliding-window-size: 50
        failure-rate-threshold: 50          # open when 50% of the last 50 calls failed
        slow-call-duration-threshold: 2s
        wait-duration-in-open-state: 30s
        permitted-number-of-calls-in-half-open-state: 5
  retry:
    instances:
      payments:
        max-attempts: 3
        wait-duration: 200ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        enable-randomized-wait: true        # jitter
  timelimiter:
    instances:
      payments:
        timeout-duration: 3s
```
Таймаут выбирай по перцентилям задержки зависимости (чуть выше её p99) и следи, чтобы собственный дедлайн вызывающего был больше всех его повторов вместе.

### Ключи идемпотентности, дизайн таблицы
```sql
CREATE TABLE idempotency_keys (
    key          text PRIMARY KEY,
    request_hash text NOT NULL,              -- reject the same key with a different body
    status       text NOT NULL,              -- IN_PROGRESS / COMPLETED
    response     jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
```
Поток: вставить ключ (конфликт означает повтор: вернуть сохранённый ответ или 409, если ещё в работе), выполнить работу, сохранить ответ, по возможности всё в одной транзакции с бизнес-изменением. Удаляй ключи примерно через 24 часа.

### Примеры graceful degradation
Рекомендации упали → показать бестселлеры из кэша. Сервис цен тормозит → отдать последнюю известную цену с пометкой "может измениться". Поиск упал → простой запрос к БД с меньшим числом возможностей. Договаривайся об этом с продуктом до аварии.

Подробнее: [AWS Builders' Library: timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) · [AWS Builders' Library: making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) · [Stripe: designing robust APIs with idempotency](https://stripe.com/blog/idempotency) · [Resilience4j documentation](https://resilience4j.readme.io/docs/circuitbreaker) · [Google SRE book: service level objectives](https://sre.google/sre-book/service-level-objectives/)

## Rate limiting

### Token bucket в Redis (атомарно через Lua)
```lua
-- KEYS[1] = bucket key; ARGV = capacity, refill_per_sec, now_ms
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or capacity
local ts = tonumber(bucket[2]) or now
tokens = math.min(capacity, tokens + (now - ts) / 1000 * rate)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000))
return allowed and 1 or 0
```
Весь read-modify-write выполняется атомарно внутри Redis, поэтому конкурентные экземпляры API не могут перерасходовать токены.

### Где ограничивать
- На краю (API gateway, Envoy, Nginx) для грубой защиты по IP или API-ключу.
- В сервисе для бизнес-лимитов (5 сбросов пароля в час на аккаунт).
- На каждую внешнюю зависимость (лимиты на стороне клиента), чтобы защитить партнёров и квоты.

Подробнее: [Stripe: scaling your API with rate limiters](https://stripe.com/blog/rate-limiters) · [Cloudflare: how rate limiting works at scale](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)

## Согласованность данных в распределённых системах

### Fencing-токены
```
Client A: acquire lock → token 33 → long GC pause ...... write(token 33) → rejected (storage saw 34)
Client B:                 lock expired → acquire → token 34 → write(token 34) → accepted
```
Защищённое хранилище помнит самый большой увиденный токен и отклоняет более старые. Без этой проверки никакой сервис блокировок не сделает такой сценарий безопасным.

### Согласованность под каждую функцию
| Функция | Допустимая согласованность |
|---|---|
| Баланс счёта, резервирование товара, уникальные имена пользователей | строгая (один лидер, транзакции, ограничения) |
| Страница статуса заказа | read-your-writes |
| Счётчики лайков, просмотров, ленты | eventual |
| Поисковый индекс, аналитика | eventual, от секунд до минут |

Подробнее: [Martin Kleppmann: How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) · [Jepsen: consistency models](https://jepsen.io/consistency)

## Дизайн API

### Соглашения REST, которые всплывают на интервью
| Действие | Запрос | Успех |
|---|---|---|
| Создать | `POST /orders` (+ `Idempotency-Key`) | `201 Created` + `Location` |
| Прочитать | `GET /orders/42` | `200` или `304` с `ETag`/`If-None-Match` |
| Заменить | `PUT /orders/42` | `200`/`204` |
| Частично обновить | `PATCH /orders/42` с `If-Match` | `200`/`204` или `412` при конфликте версий |
| Удалить | `DELETE /orders/42` | `204` (и `204`/`404` при повторе) |
| Долгая операция | `POST /reports` | `202 Accepted` + URL статуса для опроса |

### Ответ с курсорной пагинацией
```json
{
  "items": [ ... ],
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNC0wNi0wMVQxMjowMDowMFoiLCJpZCI6NDJ9"
}
```
Курсор это непрозрачный `(created_at, id)` последнего элемента в base64; сервер декодирует его в keyset-условие `WHERE`.

### gRPC vs REST
gRPC: бинарный Protobuf, мультиплексирование HTTP/2, сгенерированные клиенты, дедлайны, распространяемые по вызовам, двунаправленный стриминг. REST: универсальные инструменты, удобен для браузера, кэшируется HTTP-посредниками. Частое разделение: REST/JSON на краю, gRPC между внутренними сервисами.

Подробнее: [RFC 9110: HTTP semantics, idempotent methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) · [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html) · [Google API design guide](https://cloud.google.com/apis/design)

## Классические задачи

### Сокращатель ссылок, полный набросок
- `POST /links {url}` → сгенерировать id (Snowflake или последовательность БД, раздаваемая диапазонами по экземплярам) → закодировать в base62 → сохранить `code → url` в key-value хранилище или таблице с первичным ключом по `code`.
- `GET /{code}` → кэш Redis → БД при промахе → `302 Location: url`. События кликов асинхронно публиковать в Kafka для аналитики; никогда не заставлять редирект ждать аналитику.
- Свои алиасы: уникальное ограничение на `code`. Злоупотребления: лимиты на пользователя, проверка URL на вредоносность.

### Главное в платёжной системе
- **Ключ идемпотентности** на каждый внешний запрос; **конечный автомат** на каждый платёж (`CREATED → AUTHORIZED → CAPTURED / FAILED / REFUNDED`) с проверкой переходов.
- **Журнал с двойной записью**: каждый платёж создаёт сбалансированные проводки (дебет клиента, кредит мерчанта), которые никогда не обновляются, только дописываются или сторнируются.
- **Сверка**: ежедневное сравнение журнала с отчётами провайдера о расчётах, с алертом на каждое расхождение.
- Вызовы провайдера идут вне транзакций БД; outbox и опрос статуса/webhooks обрабатывают ситуацию "мы не знаем, прошло ли".

### Чат: что спрашивают интервьюеры
- Шлюзы соединений, держащие WebSocket; реестр (Redis), какой шлюз держит какого пользователя.
- Сообщения сначала сохраняются (партиционирование по id беседы, порядок по последовательности внутри беседы), потом доставляются; клиенты подтверждают и после переподключения запрашивают недостающие диапазоны.
- Групповые чаты: fan-out через шлюзы; очень большие группы ведут себя как задача ленты знаменитости.

Подробнее: [ByteByteGo (Alex Xu): System Design Interview](https://bytebytego.com/) · [High Scalability: real architectures](http://highscalability.com/)

## Observability

### Три сигнала, связанные вместе
Trace id, созданный на краю, путешествует в заголовках (W3C `traceparent`) через каждый сервис и сообщение. Логи его содержат, поэтому от медленного трейса можно перейти к его логам; метрики с exemplars связывают всплеск задержки с примерами трейсов. В Spring Boot 3 Micrometer Tracing + экспортёр OpenTelemetry настраивают это в основном конфигурацией.

### Алерты по burn rate SLO
Вместо "доля ошибок > 1% в течение 5 минут" поднимай алерт, когда error budget сгорает слишком быстро: для месячного SLO 99.9% сгорание в 14.4 раза быстрее допустимого в течение часа съедает 2% месячного бюджета. Это повод будить дежурного. Медленное сгорание становится тикетом. Меньше ложных тревог, и каждый вызов дежурного по делу.

Подробнее: [Google SRE workbook: alerting on SLOs](https://sre.google/workbook/alerting-on-slos/) · [OpenTelemetry documentation](https://opentelemetry.io/docs/) · [Google SRE book](https://sre.google/sre-book/table-of-contents/)

## Источники
- Alex Xu, *System Design Interview*, тома 1 и 2: стандартные разборы задач с интервью.
- Martin Kleppmann, *Designing Data-Intensive Applications*: теория за каждым компромиссом выше.
- [System Design Primer](https://github.com/donnemartin/system-design-primer): бесплатный широкий обзор с упражнениями.
- [AWS Builders' Library](https://aws.amazon.com/builders-library/): как Amazon делает повторы, таймауты, load shedding и деплои.
- [Книги Google SRE](https://sre.google/books/): надёжность, SLO и дежурства, бесплатно онлайн.
