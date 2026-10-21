# Spring Boot: deep dive

This page goes deeper on the short notes, section by section. The Spring Boot reference documentation is the source; the parts on auto-configuration and testing are especially worth reading in full.

## What Boot adds

### Boot vs plain Spring, in one example
Plain Spring MVC + JPA used to need: a servlet container to deploy into, a `DispatcherServlet` registration, a `DataSource`, an `EntityManagerFactory`, a `TransactionManager`, Jackson converters, and compatible versions of a dozen libraries. With Boot it's two starters, a `spring.datasource.url`, and a `main` method. Everything Boot configures is an ordinary bean you can inspect (`/actuator/beans`) and replace.

### Dependency management
The `spring-boot-dependencies` BOM pins versions for hundreds of libraries tested together. Override one with a property (`<postgresql.version>` in Maven, `ext['postgresql.version']` in Gradle) rather than an explicit version on the dependency, so the BOM stays consistent.

Read more: [Spring Boot reference: build systems and dependency management](https://docs.spring.io/spring-boot/reference/using/build-systems.html)

## Auto-configuration

### Anatomy of an auto-configuration
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
That's a simplified version of a real one. Every auto-configuration follows this shape: class-level conditions decide whether to look at all, bean-level conditions decide each bean, and properties customize it.

### Ordering matters
User configuration (component scan, `@Import`) is processed **before** auto-configuration, which is why `@ConditionalOnMissingBean` sees your beans. Auto-configurations order themselves with `before`/`after`. Using `@ConditionalOnMissingBean` in your *own* regular `@Configuration` is unreliable for the same reason: the other bean may not be registered yet.

### Reading the conditions report
```
DataSourceAutoConfiguration matched:
   - @ConditionalOnClass found required classes 'javax.sql.DataSource', 'EmbeddedDatabaseType' (OnClassCondition)

MongoAutoConfiguration:
   Did not match:
      - @ConditionalOnClass did not find required class 'com.mongodb.client.MongoClient' (OnClassCondition)
```

Read more: [Spring Boot: auto-configuration](https://docs.spring.io/spring-boot/reference/using/auto-configuration.html) · [Spring Boot: creating your own auto-configuration](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)

## Configuration

### Property sources, simplified order (later wins)
1. Defaults (`SpringApplication.setDefaultProperties`)
2. `@PropertySource` on configuration classes
3. `application.yml` inside the jar
4. `application-{profile}.yml` inside the jar
5. `application.yml` outside the jar (next to it, or in `./config`)
6. `application-{profile}.yml` outside the jar
7. OS environment variables
8. Java system properties (`-Dkey=value`)
9. Command-line arguments (`--key=value`)
10. Test properties (`@TestPropertySource`, `@SpringBootTest(properties = ...)`)

The full list in the docs has 15 entries; this subset answers nearly every interview question.

### Profiles done right
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
Profile groups (`spring.profiles.group.prod=proddb,prodmq`) combine fine-grained profiles. Secrets come from the environment, Vault or Kubernetes secrets (`spring.config.import=configtree:/etc/secrets/`), never from a committed file.

Read more: [Spring Boot: externalized configuration](https://docs.spring.io/spring-boot/reference/features/external-config.html) · [Spring Boot: profiles](https://docs.spring.io/spring-boot/reference/features/profiles.html)

## Startup

### What happens in SpringApplication.run
1. Determine the app type (servlet, reactive, none) from the classpath.
2. Load `ApplicationContextInitializer`s and `ApplicationListener`s.
3. Prepare the `Environment`: all property sources and active profiles.
4. Create the `ApplicationContext` and load bean definitions (your sources + auto-configuration imports).
5. `refresh()`: post-processors, create singletons, create and **start the embedded web server**.
6. Call `ApplicationRunner`/`CommandLineRunner` beans.
7. Publish `ApplicationReadyEvent`: readiness becomes `ACCEPTING_TRAFFIC`.

### Making startup faster
- Find slow beans with the `startup` Actuator endpoint (`BufferingApplicationStartup`), or with JFR.
- **CDS** (class data sharing): Boot 3.3 can extract the jar and create a CDS archive in a training run, often cutting startup by 30–40%.
- **AOT + native image**: Boot's AOT engine pre-computes bean definitions at build time; GraalVM compiles to a native binary with startup in tens of ms, at the cost of build time, peak throughput and reflection configuration.
- **CRaC**: checkpoint a warmed-up JVM and restore it (Linux, a supporting JDK).

Read more: [Spring Boot: SpringApplication](https://docs.spring.io/spring-boot/reference/features/spring-application.html) · [Spring Boot: GraalVM native images](https://docs.spring.io/spring-boot/reference/packaging/native-image/index.html) · [Spring Boot: efficient deployments and CDS](https://docs.spring.io/spring-boot/reference/packaging/efficient.html)

## Actuator and observability

### A sensible production setup
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

### Custom health indicator
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
Add it to the **readiness** group only if the app really can't serve without it; never to liveness.

### Custom metrics
```java
Counter.builder("orders.placed").tag("channel", channel).register(registry).increment();

@Observed(name = "payment.charge")   // timer + span in one annotation (needs ObservedAspect)
public Receipt charge(Payment p) { ... }
```

Read more: [Spring Boot Actuator: endpoints](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html) · [Spring Boot Actuator: observability](https://docs.spring.io/spring-boot/reference/actuator/observability.html) · [Micrometer documentation](https://docs.micrometer.io/micrometer/reference/)

## Testing

### Choosing the right test
| Test | Loads | Speed | Use for |
|---|---|---|---|
| Plain JUnit + Mockito | nothing | ms | business logic |
| `@WebMvcTest` | MVC layer | ~1 s | request mapping, validation, JSON, error handling |
| `@DataJpaTest` | JPA layer | ~2 s (+ container) | queries, mappings |
| `@SpringBootTest` | everything | seconds | wiring, end-to-end flows |

### A controller slice test
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

### Testcontainers with @ServiceConnection
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
Static containers are shared by all tests in the class; with a shared base class and the context cache, one container serves the whole suite.

Read more: [Spring Boot: testing](https://docs.spring.io/spring-boot/reference/testing/spring-boot-applications.html) · [Spring Boot: Testcontainers](https://docs.spring.io/spring-boot/reference/testing/testcontainers.html) · [Spring Framework: context caching](https://docs.spring.io/spring-framework/reference/testing/testcontext-framework/ctx-management/caching.html)

## Packaging and deployment

### Docker images
- Use layered jars so dependencies (which rarely change) are a separate cached layer from your classes: `java -Djarmode=tools -jar app.jar extract --layers --launcher` (Boot 3.3+), or simply `./gradlew bootBuildImage` with Buildpacks.
- Set memory via `-XX:MaxRAMPercentage` rather than a fixed `-Xmx`, so the same image works with different container limits.

### Zero-downtime rolling deploys on Kubernetes
1. Readiness probe on `/actuator/health/readiness`; liveness on `/actuator/health/liveness`.
2. On SIGTERM: Boot marks readiness `REFUSING_TRAFFIC`, and graceful shutdown waits for in-flight requests.
3. A `preStop` sleep of a few seconds lets the load balancer remove the pod before it stops accepting connections.

Read more: [Spring Boot: graceful shutdown](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html) · [Spring Boot: container images](https://docs.spring.io/spring-boot/reference/packaging/container-images/index.html) · [Spring Boot: executable jar format](https://docs.spring.io/spring-boot/specification/executable-jar/index.html)

## Building your own starter

### Module layout
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
Test it with `ApplicationContextRunner`, which starts tiny contexts with chosen properties and classpaths in milliseconds. Company-wide starters (logging, security, tracing defaults) are a common senior-level topic.

Read more: [Spring Boot: creating your own starter](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)

## Sources
- [Spring Boot reference documentation](https://docs.spring.io/spring-boot/reference/)
- [Spring Boot "How-to" guides](https://docs.spring.io/spring-boot/how-to/index.html): short answers to common practical questions.
- [Spring Boot source on GitHub](https://github.com/spring-projects/spring-boot): reading a couple of real auto-configurations is the best way to understand them.
