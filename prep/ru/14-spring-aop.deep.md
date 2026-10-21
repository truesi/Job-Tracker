# Spring AOP: подробно

Здесь разделы краткого конспекта разобраны глубже. Понимание того, как работают прокси, объясняет почти любой вопрос "почему не сработал мой @Transactional/@Cacheable/@Async".

## Понятия

### Полный аспект
```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Audited {
    String action();
}

@Aspect
@Component
class AuditAspect {
    private final AuditLog auditLog;
    AuditAspect(AuditLog auditLog) { this.auditLog = auditLog; }

    @AfterReturning(pointcut = "@annotation(audited)", returning = "result")
    void audit(JoinPoint jp, Audited audited, Object result) {
        auditLog.record(audited.action(), jp.getSignature().toShortString(), jp.getArgs());
    }
}

@Service
class AccountService {
    @Audited(action = "CLOSE_ACCOUNT")
    public void close(long accountId) { ... }
}
```
Привязка аннотации как параметра (`@annotation(audited)` + `Audited audited`) даёт доступ к её атрибутам без кода на reflection.

### Термины на этом примере
| Термин | В примере |
|---|---|
| Aspect | `AuditAspect` |
| Pointcut | `@annotation(audited)` |
| Advice | метод `audit`, типа after-returning |
| Join point | выполнение `AccountService.close(...)` |
| Target | настоящий экземпляр `AccountService` |
| Proxy | то, на что на самом деле ссылаются другие бины |

Подробнее: [Spring: AOP concepts](https://docs.spring.io/spring-framework/reference/core/aop/introduction-defn.html) · [Spring: declaring an aspect](https://docs.spring.io/spring-framework/reference/core/aop/ataspectj/at-aspectj.html)

## Прокси

### Как выглядит вызов через прокси
```
caller ──> proxy.close(42)
             ├─ interceptor 1 (e.g. security)  ── before
             ├─ interceptor 2 (e.g. transaction) ── begin
             │    └─> target.close(42)          ── real method; `this` here is the TARGET
             ├─ interceptor 2                   ── commit/rollback
             └─ interceptor 1                   ── after
```
Внутри `target.close` вызов `this.helper()` это обычный вызов на целевом объекте: никаких interceptor-ов. В этом вся проблема self-invocation.

### JDK и CGLIB подробнее
| | JDK dynamic proxy | CGLIB |
|---|---|---|
| Механизм | `java.lang.reflect.Proxy`, реализует интерфейсы | сгенерированный наследник (через Objenesis, поэтому конструкторы не вызываются дважды) |
| Требует | хотя бы один интерфейс | не-final класс |
| Перехватывает | методы интерфейсов | public/protected/package-private не-final методы |
| Внедрять как | только интерфейс | интерфейс или класс |

### Сравнение способов обойти self-invocation
```java
// 1. Best: split responsibilities into two beans
@Service class ReportService {
    private final ReportWriter writer;           // writer.save() is @Transactional
    void generate() { writer.save(build()); }
}

// 2. Self-injection through the proxy
@Service class ReportService {
    @Lazy @Autowired private ReportService self;
    void generate() { self.save(build()); }
}

// 3. Programmatic transaction, no proxy needed
@Service class ReportService {
    private final TransactionTemplate tx;
    void generate() { tx.executeWithoutResult(status -> save(build())); }
}
```
Вариант 3 часто самый понятный для "транзакции вокруг части метода".

Подробнее: [Spring: proxying mechanisms](https://docs.spring.io/spring-framework/reference/core/aop/proxying.html) · [Spring: programmatic transaction management](https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html)

## Выражения pointcut

### Повторно используемые, комбинированные pointcut-ы
```java
@Aspect
@Component
class Pointcuts {
    @Pointcut("within(com.shop..web..*)")
    void webLayer() { }

    @Pointcut("execution(public * *(..))")
    void publicMethod() { }

    @Pointcut("@within(org.springframework.stereotype.Service) || @annotation(com.shop.Monitored)")
    void monitored() { }

    @Around("webLayer() && publicMethod()")
    Object logRequests(ProceedingJoinPoint pjp) throws Throwable { ... }
}
```

### Грамматика execution()
```
execution( [modifiers] return-type [declaring-type.]method-name(params) [throws] )

execution(public * *(..))                          any public method
execution(* set*(..))                              any method starting with "set"
execution(* com.shop.OrderService.*(..))           any method of OrderService
execution(* com.shop..*Repository.find*(Long))     find* methods taking one Long, in any *Repository
execution(java.util.List *(..))                    methods returning List
```

### Подсказка по производительности
`within` и `@within` можно вычислить один раз на класс при старте ("статическое" сопоставление); `args(..)` и `@args` могут требовать проверки на каждый вызов. Сначала сужай pointcut через `within`, чтобы создание прокси и вызовы оставались дешёвыми.

Подробнее: [Spring: declaring pointcuts](https://docs.spring.io/spring-framework/reference/core/aop/ataspectj/pointcuts.html)

## Типы advice и @Around

### Правильный аспект с замером и повтором
```java
@Aspect
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)              // outermost: wraps transactions
class RetryOnConflictAspect {

    @Around("@annotation(retry)")
    Object retry(ProceedingJoinPoint pjp, RetryOnConflict retry) throws Throwable {
        for (int attempt = 1; ; attempt++) {
            long start = System.nanoTime();
            try {
                return pjp.proceed();
            } catch (OptimisticLockingFailureException e) {
                if (attempt >= retry.maxAttempts()) throw e;
            } finally {
                metrics.record(pjp.getSignature().toShortString(), System.nanoTime() - start);
            }
        }
    }
}
```
Правила для `@Around`: объявляй `throws Throwable`, возвращай то, что вернул `proceed()` (или осознанную замену), используй `proceed(newArgs)`, чтобы поменять аргументы, и клади очистку в `finally`.

### Порядок advice внутри одного аспекта
С Spring 5.2.7 advice-методы одного аспекта на одном join point выполняются в таком приоритете: `@Around`, `@Before`, `@After`, `@AfterReturning`, `@AfterThrowing`. Когда порядок важен, раздели логику на отдельные аспекты с `@Order` или используй один `@Around`.

Подробнее: [Spring: declaring advice](https://docs.spring.io/spring-framework/reference/core/aop/ataspectj/advice.html)

## Возможности Spring на основе AOP

### Кто сидит в цепочке interceptor-ов
Каждая из этих возможностей это advisor со своим порядком:

| Возможность | Включается через | Порядок по умолчанию |
|---|---|---|
| `@Transactional` | `@EnableTransactionManagement` (в Boot автоматически) | самый низкий приоритет (самый внутренний) |
| `@Cacheable` | `@EnableCaching` | самый низкий приоритет |
| `@Async` | `@EnableAsync` | по умолчанию ставится самым внешним advisor-ом прокси |
| `@PreAuthorize` | `@EnableMethodSecurity` | упорядоченные interceptor-ы безопасности методов |
| `@Retryable` | `@EnableRetry` | сразу перед самым низким приоритетом (снаружи транзакций) |

Порядок меняется атрибутом `order` у аннотаций `@Enable...`.

### Почему важен порядок @Cacheable + @Transactional
Если advice кэша выполняется внутри транзакции (у обоих самый низкий приоритет: порядок по объявлению, фактически не определён), значение может попасть в кэш до коммита транзакции, а потом она откатится. Задавай порядок явно, когда обе аннотации стоят на одном методе, или держи кэширование на другом слое.

Подробнее: [Spring: declarative transaction implementation](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-decl-explained.html) · [Spring: cache abstraction](https://docs.spring.io/spring-framework/reference/integration/cache.html)

## Spring AOP vs AspectJ

### Когда AspectJ того стоит
- Нужен advice на объектах, которыми не управляет Spring (доменные сущности, объекты, созданные библиотекой).
- Self-invocation должен проходить через advice (`@Transactional` на внутренних вызовах), а рефакторинг невозможен.
- Нужны join point-ы на уровне полей или конструкторов.
- Очень горячие пути, где накладные расходы на диспетчеризацию через прокси видны в профиле.

### Режимы
- **Сплетение при компиляции**: плагин AspectJ для Maven/Gradle запускает `ajc`; сплетённые классы это обычный байткод, агент в рантайме не нужен.
- **Load-time weaving**: `-javaagent` (aspectjweaver) переписывает классы при загрузке, настраивается через `META-INF/aop.xml`.
- `@EnableTransactionManagement(mode = AdviceMode.ASPECTJ)` переключает поддержку транзакций Spring на сплетение AspectJ.

Подробнее: [Spring: using AspectJ with Spring applications](https://docs.spring.io/spring-framework/reference/core/aop/using-aspectj.html) · [Spring: choosing which AOP style to use](https://docs.spring.io/spring-framework/reference/core/aop/choosing.html) · [AspectJ documentation](https://eclipse.dev/aspectj/docs.php)

## Подводные камни

### Чеклист отладки: "моя аннотация ничего не делает"
1. Объект это Spring-бин? (`new` или объект из библиотеки → нет прокси)
2. Вызов приходит из другого бина? (self-invocation → нет прокси)
3. Метод public (или хотя бы не private) и не final? Класс не final? (Kotlin: подключён ли плагин `kotlin-spring`?)
4. Возможность включена? (`@EnableAsync`, `@EnableCaching`, `@EnableRetry`, `@EnableMethodSecurity`)
5. Бин действительно проксирован? `AopUtils.isAopProxy(bean)` или отладчик покажет `$$SpringCGLIB$$` в имени класса.
6. Pointcut совпадает? Retention аннотации `RUNTIME`, правильное имя пакета, правильные типы параметров.

### Сюрпризы, связанные с прокси
- `getClass()` у бина возвращает класс прокси; используй `AopUtils.getTargetClass(bean)` или `ClassUtils.getUserClass`.
- Собственные поля экземпляра CGLIB-прокси никогда не инициализируются (Objenesis пропускает конструктор). `final` метод, вызванный на прокси, выполняется на самом прокси и видит `null` в полях: классический NPE в Kotlin или после добавления `final` "для надёжности".

Подробнее: [Spring: AOP API and ProxyFactory](https://docs.spring.io/spring-framework/reference/core/aop-api.html)

## Источники
- [Spring Framework: Aspect Oriented Programming](https://docs.spring.io/spring-framework/reference/core/aop.html): полная глава.
- [AspectJ Programming Guide](https://eclipse.dev/aspectj/docs.php): полный язык pointcut-ов.
- [Исходники Spring Framework: модуль spring-aop](https://github.com/spring-projects/spring-framework/tree/main/spring-aop): `ProxyFactory`, `JdkDynamicAopProxy` и `CglibAopProxy` читаются легко.
