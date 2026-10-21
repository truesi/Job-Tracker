# Spring Boot: подробно

Здесь разделы краткого конспекта разобраны глубже. Первоисточник это справочная документация Spring Boot; части про автоконфигурацию и тестирование особенно стоит прочитать целиком.

## Что добавляет Boot

### Boot против чистого Spring на одном примере
Чистому Spring MVC + JPA раньше было нужно: servlet-контейнер для деплоя, регистрация `DispatcherServlet`, `DataSource`, `EntityManagerFactory`, `TransactionManager`, конвертеры Jackson и совместимые версии десятка библиотек. С Boot это два стартера, `spring.datasource.url` и метод `main`. Всё, что настраивает Boot, это обычные бины, которые можно посмотреть (`/actuator/beans`) и заменить.

### Управление зависимостями
BOM `spring-boot-dependencies` фиксирует версии сотен библиотек, протестированных вместе. Переопределяй одну через свойство (`<postgresql.version>` в Maven, `ext['postgresql.version']` в Gradle), а не явной версией в зависимости, чтобы BOM оставался согласованным.

Подробнее: [Spring Boot reference: build systems and dependency management](https://docs.spring.io/spring-boot/reference/using/build-systems.html)

## Автоконфигурация

### Анатомия автоконфигурации
```java
@AutoConfiguration(after = DataSourceAutoConfiguration.class)
@ConditionalOnClass(JdbcTemplate.class)                       // library on the classpath?
@ConditionalOnSingleCandidate(DataSource.class)               // exactly one DataSource?
@EnableConfigurationProperties(JdbcProperties.class)
public class JdbcTemplateAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(JdbcOperations.class)           // user didn't define one?
    JdbcTemplate jdbcTemplate(DataSource dataSource, JdbcProperties properties) {
        JdbcTemplate template = new JdbcTemplate(dataSource);
        template.setFetchSize(properties.getTemplate().getFetchSize());
        return template;
    }
}
```
Это упрощённая версия настоящей. Каждая автоконфигурация устроена так же: условия на классе решают, смотреть ли вообще, условия на бинах решают про каждый бин, а свойства его настраивают.

### Порядок важен
Пользовательская конфигурация (component scan, `@Import`) обрабатывается **раньше** автоконфигурации, поэтому `@ConditionalOnMissingBean` видит твои бины. Автоконфигурации упорядочивают себя через `before`/`after`. Использовать `@ConditionalOnMissingBean` в *своей* обычной `@Configuration` ненадёжно по той же причине: другой бин может быть ещё не зарегистрирован.

### Как читать отчёт об условиях
```
DataSourceAutoConfiguration matched:
   - @ConditionalOnClass found required classes 'javax.sql.DataSource', 'EmbeddedDatabaseType' (OnClassCondition)

MongoAutoConfiguration:
   Did not match:
      - @ConditionalOnClass did not find required class 'com.mongodb.client.MongoClient' (OnClassCondition)
```

Подробнее: [Spring Boot: auto-configuration](https://docs.spring.io/spring-boot/reference/using/auto-configuration.html) · [Spring Boot: creating your own auto-configuration](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)

## Конфигурация

### Источники свойств, упрощённый порядок (побеждает более поздний)
1. Значения по умолчанию (`SpringApplication.setDefaultProperties`)
2. `@PropertySource` на конфигурационных классах
3. `application.yml` внутри jar
4. `application-{profile}.yml` внутри jar
5. `application.yml` снаружи jar (рядом с ним или в `./config`)
6. `application-{profile}.yml` снаружи jar
7. Переменные окружения ОС
8. Системные свойства Java (`-Dkey=value`)
9. Аргументы командной строки (`--key=value`)
10. Тестовые свойства (`@TestPropertySource`, `@SpringBootTest(properties = ...)`)

Полный список в документации состоит из 15 пунктов; этого подмножества хватает почти на любой вопрос собеседования.

### Профили как надо
```yaml
# application.yml: shared defaults
spring:
  jpa:
    open-in-view: false
---
spring:
  config:
    activate:
      on-profile: prod
server:
  shutdown: graceful
```
Группы профилей (`spring.profiles.group.prod=proddb,prodmq`) объединяют мелкие профили. Секреты приходят из окружения, Vault или Kubernetes secrets (`spring.config.import=configtree:/etc/secrets/`), но никогда из закоммиченного файла.

Подробнее: [Spring Boot: externalized configuration](https://docs.spring.io/spring-boot/reference/features/external-config.html) · [Spring Boot: profiles](https://docs.spring.io/spring-boot/reference/features/profiles.html)

## Старт

### Что происходит в SpringApplication.run
1. Определить тип приложения (servlet, reactive, none) по classpath.
2. Загрузить `ApplicationContextInitializer` и `ApplicationListener`.
3. Подготовить `Environment`: все источники свойств и активные профили.
4. Создать `ApplicationContext` и загрузить определения бинов (твои источники + импорты автоконфигурации).
5. `refresh()`: post-processor-ы, создание синглтонов, создание и **запуск встроенного веб-сервера**.
6. Вызвать бины `ApplicationRunner`/`CommandLineRunner`.
7. Опубликовать `ApplicationReadyEvent`: readiness становится `ACCEPTING_TRAFFIC`.

### Как ускорить старт
- Найди медленные бины через эндпоинт Actuator `startup` (`BufferingApplicationStartup`) или через JFR.
- **CDS** (class data sharing): Boot 3.3 умеет распаковать jar и создать CDS-архив в тренировочном запуске, это часто сокращает старт на 30–40%.
- **AOT + native image**: AOT-движок Boot заранее вычисляет определения бинов при сборке; GraalVM компилирует в нативный бинарник со стартом в десятки мс ценой времени сборки, пиковой производительности и настройки reflection.
- **CRaC**: сделать чекпоинт прогретой JVM и восстанавливаться из него (Linux, JDK с поддержкой).

Подробнее: [Spring Boot: SpringApplication](https://docs.spring.io/spring-boot/reference/features/spring-application.html) · [Spring Boot: GraalVM native images](https://docs.spring.io/spring-boot/reference/packaging/native-image/index.html) · [Spring Boot: efficient deployments and CDS](https://docs.spring.io/spring-boot/reference/packaging/efficient.html)

## Actuator и observability

### Разумная продакшен-настройка
```yaml
management:
  server:
    port: 8081                         # not reachable from the public ingress
  endpoints:
    web:
      exposure:
        include: health, info, prometheus, loggers
  endpoint:
    health:
      probes:
        enabled: true
      show-details: never
  observations:
    key-values:
      application: orders
```

### Свой health indicator
```java
@Component
class PaymentProviderHealth implements HealthIndicator {
    private final PaymentClient client;
    PaymentProviderHealth(PaymentClient client) { this.client = client; }

    @Override
    public Health health() {
        return client.ping()
            ? Health.up().build()
            : Health.down().withDetail("provider", "unreachable").build();
    }
}
```
Добавляй его в группу **readiness**, только если приложение правда не может работать без этой зависимости; в liveness никогда.

### Свои метрики
```java
Counter.builder("orders.placed").tag("channel", channel).register(registry).increment();

@Observed(name = "payment.charge")   // timer + span in one annotation (needs ObservedAspect)
public Receipt charge(Payment p) { ... }
```

Подробнее: [Spring Boot Actuator: endpoints](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html) · [Spring Boot Actuator: observability](https://docs.spring.io/spring-boot/reference/actuator/observability.html) · [Micrometer documentation](https://docs.micrometer.io/micrometer/reference/)

## Тестирование

### Какой тест выбрать
| Тест | Загружает | Скорость | Для чего |
|---|---|---|---|
| Обычный JUnit + Mockito | ничего | мс | бизнес-логика |
| `@WebMvcTest` | слой MVC | ~1 с | маппинг запросов, валидация, JSON, обработка ошибок |
| `@DataJpaTest` | слой JPA | ~2 с (+ контейнер) | запросы, маппинги |
| `@SpringBootTest` | всё | секунды | связывание, сквозные сценарии |

### Слайс-тест контроллера
```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {
    @Autowired MockMvc mvc;
    @MockitoBean OrderService orders;

    @Test
    void returns404ForUnknownOrder() throws Exception {
        when(orders.find(42L)).thenThrow(new OrderNotFoundException(42L));
        mvc.perform(get("/orders/42"))
           .andExpect(status().isNotFound())
           .andExpect(jsonPath("$.orderId").value(42));
    }
}
```

### Testcontainers с @ServiceConnection
```java
@SpringBootTest
@Testcontainers
class OrderFlowIT {
    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Test
    void placesOrder() { ... }
}
```
Static-контейнеры общие для всех тестов класса; с общим базовым классом и кэшем контекстов один контейнер обслуживает весь набор тестов.

Подробнее: [Spring Boot: testing](https://docs.spring.io/spring-boot/reference/testing/spring-boot-applications.html) · [Spring Boot: Testcontainers](https://docs.spring.io/spring-boot/reference/testing/testcontainers.html) · [Spring Framework: context caching](https://docs.spring.io/spring-framework/reference/testing/testcontext-framework/ctx-management/caching.html)

## Упаковка и деплой

### Docker-образы
- Используй слоёные jar, чтобы зависимости (меняются редко) были отдельным кэшируемым слоем от твоих классов: `java -Djarmode=tools -jar app.jar extract --layers --launcher` (Boot 3.3+) или просто `./gradlew bootBuildImage` с Buildpacks.
- Задавай память через `-XX:MaxRAMPercentage`, а не фиксированный `-Xmx`, чтобы один образ работал с разными лимитами контейнеров.

### Rolling deploy без простоя в Kubernetes
1. Readiness probe на `/actuator/health/readiness`; liveness на `/actuator/health/liveness`.
2. По SIGTERM Boot переводит readiness в `REFUSING_TRAFFIC`, а graceful shutdown ждёт текущих запросов.
3. Пауза `preStop` в несколько секунд даёт балансировщику убрать под до того, как тот перестанет принимать соединения.

Подробнее: [Spring Boot: graceful shutdown](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html) · [Spring Boot: container images](https://docs.spring.io/spring-boot/reference/packaging/container-images/index.html) · [Spring Boot: executable jar format](https://docs.spring.io/spring-boot/specification/executable-jar/index.html)

## Свой стартер

### Структура модулей
```
acme-client-spring-boot-autoconfigure/
  src/main/java/.../AcmeClientAutoConfiguration.java
  src/main/java/.../AcmeClientProperties.java
  src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
acme-client-spring-boot-starter/
  pom.xml  -> depends on the autoconfigure module + acme-client library
```
```java
@AutoConfiguration
@ConditionalOnClass(AcmeClient.class)
@EnableConfigurationProperties(AcmeClientProperties.class)
public class AcmeClientAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean
    AcmeClient acmeClient(AcmeClientProperties props) {
        return new AcmeClient(props.baseUrl(), props.timeout());
    }
}
```
Тестируй через `ApplicationContextRunner`, который за миллисекунды поднимает крошечные контексты с выбранными свойствами и classpath. Корпоративные стартеры (логирование, безопасность, настройки трейсинга по умолчанию) частая тема на senior-уровне.

Подробнее: [Spring Boot: creating your own starter](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)

## Источники
- [Справочная документация Spring Boot](https://docs.spring.io/spring-boot/reference/)
- [Spring Boot "How-to" guides](https://docs.spring.io/spring-boot/how-to/index.html): короткие ответы на частые практические вопросы.
- [Исходники Spring Boot на GitHub](https://github.com/spring-projects/spring-boot): прочитать пару настоящих автоконфигураций это лучший способ их понять.
