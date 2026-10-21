# Spring Boot

## Что добавляет Boot
- **Автоконфигурация**: бины настраиваются по тому, что есть в classpath и свойствах, и отступают, когда ты объявляешь свои.
- **Стартеры**: наборы зависимостей (`spring-boot-starter-web`, `-data-jpa`...) с версиями из BOM Boot.
- **Встроенный сервер**: Tomcat по умолчанию (Jetty, Undertow; Netty для WebFlux), поэтому приложение это просто `java -jar`.
- Внешняя конфигурация, Actuator, исполняемые fat jar, разумные значения по умолчанию. Без генерации кода и без XML.

## Автоконфигурация
- `@SpringBootApplication` = `@SpringBootConfiguration` + `@EnableAutoConfiguration` + `@ComponentScan` (пакет главного класса и ниже).
- Boot 3 перечисляет кандидатов в `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` (Boot 2 использовал `spring.factories`).
- Каждая защищена условиями: `@ConditionalOnClass`, `@ConditionalOnMissingBean` (**твой бин побеждает**), `@ConditionalOnProperty`, `@ConditionalOnWebApplication`...
- Почему что-то настроилось (или нет)? Запусти с `--debug`, чтобы получить отчёт об условиях, или загляни в `/actuator/conditions`.
- Исключение через `@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)` или `spring.autoconfigure.exclude`.

## Конфигурация
- `application.properties`/`.yml`, файлы профилей `application-{profile}.yml`, активируются через `spring.profiles.active`.
- Приоритет, от высшего: аргументы командной строки → переменные окружения ОС → файлы профилей → `application.*` → значения по умолчанию. Файлы снаружи побеждают файлы внутри jar.
- **Relaxed binding**: `spring.datasource.url` можно задать переменной окружения `SPRING_DATASOURCE_URL`.
- `@ConfigurationProperties` + `@Validated` (подходят records), регистрируются через `@ConfigurationPropertiesScan`.
- `spring.config.import` подключает дополнительные источники (config tree Kubernetes, Vault, Config Server).

## Старт
- `SpringApplication.run`: подготовить `Environment` → создать `ApplicationContext` → refresh (определения бинов, post-processor-ы, синглтоны, запуск веб-сервера) → вызвать бины `ApplicationRunner`/`CommandLineRunner` → опубликовать `ApplicationReadyEvent`.
- Ускорение старта: `spring.main.lazy-initialization` (ошибки всплывают позже), class data sharing (CDS), AOT-обработка и нативные образы GraalVM (Boot 3), чекпоинты CRaC.

## Actuator и observability
- Эндпоинты: `health` (с группами `liveness`/`readiness` для проб Kubernetes), `info`, `metrics`, `prometheus`, `env`, `loggers` (менять уровни на ходу), `threaddump`, `heapdump`, `conditions`, `mappings`.
- По HTTP по умолчанию открыт только `health`. Открывай больше через `management.endpoints.web.exposure.include`, лучше на отдельном management-порту, и никогда не выставляй `env` или `heapdump` наружу.
- Micrometer для метрик; Micrometer Tracing (Boot 3, заменил Spring Cloud Sleuth) с OpenTelemetry или Brave; свои `HealthIndicator`.

## Тестирование
- `@SpringBootTest`: полный контекст (`webEnvironment = RANDOM_PORT` для настоящего HTTP).
- Слайсы загружают только часть приложения: `@WebMvcTest` (контроллеры + MockMvc; сервисы мокаются), `@DataJpaTest` (JPA + тестовая база, каждый тест откатывается), `@JsonTest`, `@RestClientTest`.
- `@MockitoBean` (Spring Framework 6.2 / Boot 3.4) заменяет `@MockBean`. Каждый новый набор моков или свойств создаёт новый контекст: кэш контекстов используется хуже, и тесты замедляются.
- Testcontainers + `@ServiceConnection` (Boot 3.1+): настоящий PostgreSQL или Kafka в Docker, а свойства подключения прописываются автоматически.

## Упаковка и деплой
- В fat jar есть `BOOT-INF/classes`, `BOOT-INF/lib` (вложенные jar) и лаунчер (`JarLauncher`) со своим загрузчиком классов.
- Слоёные jar для эффективных слоёв Docker; `bootBuildImage`/`spring-boot:build-image` собирает OCI-образ через Cloud Native Buildpacks.
- `server.shutdown=graceful`: перестать принимать новые запросы и доделать текущие в пределах `spring.lifecycle.timeout-per-shutdown-phase`.
- `spring.threads.virtual.enabled=true` (Boot 3.2+, Java 21): Tomcat и `@Async` на virtual threads.

## Свой стартер
- Модуль `-autoconfigure`: классы `@AutoConfiguration` с условиями, перечисленные в файле `AutoConfiguration.imports`, с `@ConditionalOnMissingBean`, чтобы пользователи могли переопределить, плюс `@ConfigurationProperties` для настроек.
- Модуль `-starter`, который только подтягивает модуль autoconfigure и нужные библиотеки.
