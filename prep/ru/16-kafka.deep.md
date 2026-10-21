# Kafka и обмен сообщениями: подробно

Здесь разделы краткого конспекта разобраны глубже. Раздел design официальной документации Kafka объясняет, *почему* Kafka устроена именно так, и он достаточно короткий, чтобы прочитать за раз.

## Базовая модель

### Почему лог быстрый
- Запись это последовательное дописывание в файлы сегментов, и чтение в основном тоже последовательное. Диски и кэш страниц ОС с этим отлично справляются.
- Kafka полагается на **page cache** вместо собственного кэша и использует **zero-copy** (`sendfile`), чтобы отправлять данные из page cache в сокет без копирования через JVM.
- Записи пакетируются от начала до конца: продюсер отправляет пакеты, брокер хранит их как есть, консьюмер забирает пакетами.

### Как устроено хранение
```
orders-0/                        partition 0 of topic "orders"
  00000000000000000000.log       segment: records
  00000000000000000000.index     offset -> position in the segment
  00000000000000000000.timeindex timestamp -> offset
  00000000000004500123.log       the next segment, named by its first offset
```
Хранение по сроку и compaction работают с целыми сегментами; активный (последний) сегмент никогда не удаляется и не компактится.

### Репликация и выбор лидера
Продюсеры и консьюмеры работают с **лидером** партиции (с rack awareness консьюмеры могут читать с ближайшего follower). Followers читают с лидера так же, как консьюмеры. **High watermark** это offset, до которого реплицировали все члены ISR; консьюмеры видят только записи ниже него, поэтому никогда не читают то, что может исчезнуть при смене лидера.

`unclean.leader.election.enable=false` (по умолчанию) означает, что отставшая реплика никогда не становится лидером: партиция будет недоступна, но данные не потеряются. Классический выбор из CAP.

Подробнее: [Kafka documentation: design](https://kafka.apache.org/43/design/design/) · [Kafka documentation: replication](https://kafka.apache.org/43/design/design/#replication) · [Kafka documentation: log compaction](https://kafka.apache.org/43/design/design/#log-compaction)

## Продюсеры

### Надёжные настройки продюсера
```properties
acks=all
enable.idempotence=true                 # default since 3.0
max.in.flight.requests.per.connection=5 # max allowed with idempotence; order is still kept
retries=2147483647                      # retry until...
delivery.timeout.ms=120000              # ...this overall deadline
linger.ms=5
compression.type=zstd
```
На стороне топика: `replication.factor=3`, `min.insync.replicas=2`.

### Что на самом деле делает идемпотентность
Каждый продюсер получает producer id; каждый пакет для партиции несёт номер последовательности. Брокер отклоняет пакет с уже записанным номером (повтор после потерянного подтверждения) и замечает пропуски. Это убирает дубликаты от **повторов**, но не дубликаты от того, что приложение дважды вызвало `send()`, и не от перезапущенного продюсера (новый producer id), если только не использовать транзакции со стабильным `transactional.id`.

### Транзакции
```java
producer.initTransactions();
while (running) {
    ConsumerRecords<String, Order> records = consumer.poll(Duration.ofMillis(200));
    producer.beginTransaction();
    for (var r : records) {
        producer.send(new ProducerRecord<>("invoices", r.key(), toInvoice(r.value())));
    }
    producer.sendOffsetsToTransaction(nextOffsets(records), consumer.groupMetadata());
    producer.commitTransaction();          // outputs + input offsets, atomically
}
```
**Зомби** (старый экземпляр с тем же `transactional.id`, который продолжил работать после паузы) отсекается номером эпохи: его коммиты падают.

Подробнее: [Kafka documentation: producer configs](https://kafka.apache.org/43/configuration/producer-configs/) · [Confluent: exactly-once semantics in Kafka](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)

## Консьюмеры и группы консьюмеров

### Цикл poll
```java
try (var consumer = new KafkaConsumer<String, Order>(props)) {
    consumer.subscribe(List.of("orders"));
    while (running) {
        var records = consumer.poll(Duration.ofMillis(500));   // also sends heartbeats and handles rebalances
        for (var r : records) {
            process(r);
        }
        consumer.commitSync();                                // after processing: at-least-once
    }
}
```
`KafkaConsumer` **не потокобезопасен**. Масштабируйся добавлением консьюмеров (до числа партиций) или передавай записи в пул воркеров, аккуратно отслеживая, какие offset-ы безопасно коммитить.

### Ребалансировка
- **Eager**-протокол (старый по умолчанию): все консьюмеры останавливаются, отдают все партиции и получают новое распределение. Всё встаёт.
- **Cooperative** (инкрементальный): отзываются только переезжающие партиции. Используй `CooperativeStickyAssignor` (а в Kafka 4.0 новый серверный протокол групп консьюмеров, KIP-848, делает ребалансировки инкрементальными и управляемыми брокером).
- **Static membership**: с `group.instance.id` перезапускающийся консьюмер (rolling deploy) получает свои партиции обратно без ребалансировки, если вернулся в пределах `session.timeout.ms`.
- Heartbeat-ы (`session.timeout.ms`) обнаруживают мёртвый процесс; `max.poll.interval.ms` обнаруживает зависший.

### Мониторинг lag
Lag в записях получить легко, но пользователи чувствуют **lag во времени** (насколько старая самая старая необработанная запись). Алерт ставь на lag, который продолжает расти, а не на фиксированное число: всплеск, который быстро рассасывается, это нормально.

Подробнее: [Kafka documentation: consumer configs](https://kafka.apache.org/43/configuration/consumer-configs/) · [KIP-848: the next-gen consumer rebalance protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol)

## Семантика доставки

### Откуда берутся дубликаты
1. Повтор продюсера после потерянного подтверждения (лечится идемпотентным продюсером).
2. Падение консьюмера между обработкой и коммитом.
3. Ребалансировка во время обработки: партиция переезжает, и новый владелец начинает с последнего закоммиченного offset.
4. Сервисы выше по цепочке публикуют одно событие дважды (relay outbox тоже at-least-once).

Поэтому проектируй консьюмеров идемпотентными, всегда.

### Идемпотентный консьюмер с таблицей дедупликации
```java
@KafkaListener(topics = "payments")
@Transactional
public void on(PaymentReceived event) {
    int inserted = jdbc.update(
        "INSERT INTO processed_events (event_id) VALUES (?) ON CONFLICT DO NOTHING", event.id());
    if (inserted == 0) return;                // already processed
    orders.markPaid(event.orderId());         // same DB transaction as the dedupe row
}
```
Offset коммитится после возврата из метода. Падение до коммита приведёт к повторной доставке, и строка дедупликации сделает второй запуск пустым.

Подробнее: [Kafka documentation: message delivery semantics](https://kafka.apache.org/43/design/design/#message-delivery-semantics) · [microservices.io: idempotent consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html)

## Обработка ошибок

### Spring Kafka: блокирующие повторы, затем DLT
```java
@Bean
DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> template) {
    var recoverer = new DeadLetterPublishingRecoverer(template);       // -> "<topic>.DLT" by default
    var backoff = new ExponentialBackOffWithMaxRetries(4);
    backoff.setInitialInterval(500);
    backoff.setMultiplier(2.0);
    var handler = new DefaultErrorHandler(recoverer, backoff);
    handler.addNotRetryableExceptions(ValidationException.class);      // straight to DLT
    return handler;
}
```

### Неблокирующие повторы
```java
@RetryableTopic(attempts = "4", backoff = @Backoff(delay = 1000, multiplier = 2))
@KafkaListener(topics = "emails")
void send(EmailRequest req) { mailer.send(req); }

@DltHandler
void failed(EmailRequest req, @Header(KafkaHeaders.EXCEPTION_MESSAGE) String error) { ... }
```
Spring создаёт retry-топики (`emails-retry-...`), которые читаются с задержкой, плюс `emails-dlt`, а основной топик продолжает течь.

### Как выбирать
| Ситуация | Стратегия |
|---|---|
| Строгий порядок по ключу (балансы, изменения состояния) | блокирующие повторы; при окончательной неудаче DLT и, возможно, пауза партиции |
| Независимые события (письма, уведомления) | неблокирующие retry-топики |
| Плохие данные (валидация, десериализация) | без повторов, сразу в DLT |

Подробнее: [Spring Kafka: handling exceptions](https://docs.spring.io/spring-kafka/reference/kafka/annotation-error-handling.html) · [Spring Kafka: non-blocking retries](https://docs.spring.io/spring-kafka/reference/retrytopic.html)

## Решения при проектировании

### Сколько нужно партиций
- Измерь пропускную способность одной партиции для своих продюсера и консьюмера (скажем, 10 МБ/с на запись, 5 МБ/с на чтение). Для цели в 100 МБ/с нужно минимум 20 партиций.
- Закладывай рост, потому что уменьшить число партиций нельзя, а добавление перетасовывает ключи.
- Не перебарщивай: каждая партиция стоит открытых файлов, памяти и выборов лидера. Тысячи на брокер с KRaft это нормально, но не без предела.

### Проектирование событий
- **События** сообщают факты в прошедшем времени (`OrderPlaced`), **команды** это просьбы (`ChargeCard`). Между сервисами предпочитай события.
- **Тонкие события** (только id) заставляют консьюмеров ходить за данными обратно; **толстые события** (полное состояние) лучше развязывают, но раздувают схемы. Частая середина: состояние изменившейся сущности плюс id связанных сущностей.
- Добавляй id события, тип, версию, timestamp и correlation/trace id в заголовки.

### Эволюция схем
С Avro и Schema Registry в режиме совместимости `BACKWARD` новые консьюмеры могут читать старые данные: можно добавлять поля со значениями по умолчанию и удалять поля, но нельзя добавлять обязательные. При обратно совместимых изменениях деплой консьюмеров идёт раньше продюсеров.

Подробнее: [Confluent: choosing the number of partitions](https://www.confluent.io/blog/how-choose-number-topics-partitions-kafka-cluster/) · [Confluent: schema evolution and compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)

## Spring Kafka

### Типичная настройка слушателя
```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    consumer:
      group-id: billing
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
      properties:
        spring.deserializer.value.delegate.class: org.springframework.kafka.support.serializer.JsonDeserializer
        spring.json.trusted.packages: com.shop.events
    listener:
      ack-mode: record
      concurrency: 3
```

### Отправка с проверкой результата
```java
kafkaTemplate.send("orders", order.id().toString(), event)
    .whenComplete((result, ex) -> {
        if (ex != null) log.error("publish failed for {}", order.id(), ex);
    });
```
"Отправил и забыл" без проверки означает тихую потерю данных при недоступности брокера. Для событий, которые нельзя потерять и которые пишутся вместе с изменениями в БД, используй outbox.

### Тестирование
`@EmbeddedKafka` (брокер в памяти) для быстрых тестов или Testcontainers с настоящей Kafka и `@ServiceConnection` для реалистичных.

Подробнее: [Spring for Apache Kafka reference](https://docs.spring.io/spring-kafka/reference/) · [Spring Boot: Kafka support](https://docs.spring.io/spring-boot/reference/messaging/kafka.html)

## Источники
- [Документация Apache Kafka](https://kafka.apache.org/documentation/): особенно Design, Implementation и Operations.
- Gwen Shapira и др., *Kafka: The Definitive Guide*, 2-е издание.
- [Курсы Confluent Developer](https://developer.confluent.io/courses/): бесплатные короткие видеокурсы по внутреннему устройству Kafka.
- Martin Kleppmann, *Designing Data-Intensive Applications*, глава 11 "Stream Processing".
