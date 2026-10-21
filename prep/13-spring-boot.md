# Spring Boot

## What Boot adds
- **Auto-configuration**: beans configured from what's on the classpath and in properties, backing off when you define your own.
- **Starters**: dependency bundles (`spring-boot-starter-web`, `-data-jpa`...) with versions managed by the Boot BOM.
- **Embedded server**: Tomcat by default (Jetty, Undertow; Netty for WebFlux), so the app is just `java -jar`.
- Externalized configuration, Actuator, executable fat jars, opinionated defaults. No code generation and no XML.

## Auto-configuration
- `@SpringBootApplication` = `@SpringBootConfiguration` + `@EnableAutoConfiguration` + `@ComponentScan` (the main class's package and below).
- Boot 3 lists candidate classes in `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` (Boot 2 used `spring.factories`).
- Each one is guarded by conditions: `@ConditionalOnClass`, `@ConditionalOnMissingBean` (**your bean wins**), `@ConditionalOnProperty`, `@ConditionalOnWebApplication`...
- Why did something get (not) configured? Run with `--debug` for the conditions evaluation report, or check `/actuator/conditions`.
- Exclude with `@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)` or `spring.autoconfigure.exclude`.

## Configuration
- `application.properties`/`.yml`, profile files `application-{profile}.yml`, activated with `spring.profiles.active`.
- Precedence, highest first: command-line arguments → OS environment variables → profile-specific files → `application.*` → defaults. Outside files beat files inside the jar.
- **Relaxed binding**: `spring.datasource.url` can come from the environment variable `SPRING_DATASOURCE_URL`.
- `@ConfigurationProperties` + `@Validated` (records work), registered with `@ConfigurationPropertiesScan`.
- `spring.config.import` pulls extra sources (Kubernetes config trees, Vault, Config Server).

## Startup
- `SpringApplication.run`: prepare the `Environment` → create the `ApplicationContext` → refresh it (bean definitions, post-processors, singletons, start the web server) → call `ApplicationRunner`/`CommandLineRunner` beans → publish `ApplicationReadyEvent`.
- Faster startup: `spring.main.lazy-initialization` (errors surface later), class data sharing (CDS), AOT processing and GraalVM native images (Boot 3), CRaC checkpoints.

## Actuator and observability
- Endpoints: `health` (with `liveness`/`readiness` groups for Kubernetes probes), `info`, `metrics`, `prometheus`, `env`, `loggers` (change levels at runtime), `threaddump`, `heapdump`, `conditions`, `mappings`.
- Only `health` is exposed over HTTP by default. Expose more with `management.endpoints.web.exposure.include`, ideally on a separate management port, and never expose `env` or `heapdump` publicly.
- Micrometer for metrics; Micrometer Tracing (Boot 3, replacing Spring Cloud Sleuth) with OpenTelemetry or Brave; custom `HealthIndicator`s.

## Testing
- `@SpringBootTest`: the full context (`webEnvironment = RANDOM_PORT` for real HTTP).
- Slices load only part of the app: `@WebMvcTest` (controllers + MockMvc; mock the services), `@DataJpaTest` (JPA + a test database, each test rolled back), `@JsonTest`, `@RestClientTest`.
- `@MockitoBean` (Spring Framework 6.2 / Boot 3.4) replaces `@MockBean`. Every different set of mocks or properties creates a new context: the context cache gets less use and the test suite slows down.
- Testcontainers + `@ServiceConnection` (Boot 3.1+): a real PostgreSQL or Kafka in Docker, with connection properties wired automatically.

## Packaging and deployment
- The fat jar has `BOOT-INF/classes`, `BOOT-INF/lib` (nested jars) and a launcher (`JarLauncher`) with its own class loader.
- Layered jars for efficient Docker layers; `bootBuildImage`/`spring-boot:build-image` builds an OCI image with Cloud Native Buildpacks.
- `server.shutdown=graceful`: stop taking new requests and finish in-flight ones within `spring.lifecycle.timeout-per-shutdown-phase`.
- `spring.threads.virtual.enabled=true` (Boot 3.2+, Java 21): Tomcat and `@Async` on virtual threads.

## Building your own starter
- An `-autoconfigure` module: `@AutoConfiguration` classes with conditions, listed in the `AutoConfiguration.imports` file, with `@ConditionalOnMissingBean` so users can override, plus `@ConfigurationProperties` for settings.
- A `-starter` module that only pulls in the autoconfigure module and the required libraries.
