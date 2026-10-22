package com.rjgehan.notes.vaults;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentSkipListMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import jakarta.servlet.ServletConfig;
import jakarta.servlet.ServletContext;
import jakarta.servlet.ServletException;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.boot.ApplicationContextFactory;
import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.context.logging.LoggingApplicationListener;
import org.springframework.boot.web.context.servlet.AnnotationConfigServletWebApplicationContext;
import org.springframework.boot.web.context.servlet.ApplicationServletEnvironment;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.PropertySource;
import org.springframework.stereotype.Component;
import org.springframework.util.ClassUtils;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.DispatcherServlet;

/**
 * The vaults this server serves (DESIGN §5.39, ROADMAP item 37). The default vault is the main application itself.
 * Every valid folder under {@code notes.vaults.dir} is an extra vault with an application context of its own, built
 * from the same components (its own vault file system, index, git repository, watcher, event stream, settings,
 * schedulers and controllers), so nothing one vault holds can reach another. Extra contexts are started one after
 * another on a background thread once the main application is ready; until then their requests get
 * {@code 503 vault-unavailable}. {@link ServerWide} beans are shared from the main context.
 */
@Component
@ServerWide
public class VaultRegistry implements DisposableBean {

	private static final Logger logger = LoggerFactory.getLogger(VaultRegistry.class);

	/** Names of property sources of the main environment that an extra context must not share. */
	private static final Set<String> OWN_SOURCES = Set.of("configurationProperties", "servletConfigInitParams",
			"servletContextInitParams", "notesVault");

	/** The life of an extra vault's context. */
	public enum State {

		STARTING, READY, FAILED;

		public String json() {
			return name().toLowerCase(java.util.Locale.ROOT);
		}

	}

	/** One vault as the vault list shows it. */
	public record Info(String name, boolean isDefault, State state, String url) {
	}

	private static final class Entry {

		final String name;

		final Path dir;

		volatile State state = State.STARTING;

		volatile @Nullable ConfigurableApplicationContext context;

		volatile @Nullable DispatcherServlet servlet;

		Entry(String name, Path dir) {
			this.name = name;
			this.dir = dir;
		}

	}

	private final NotesProperties properties;

	private final NotesProperties.Vaults config;

	private final ApplicationContext main;

	private final Map<String, Entry> extras = new ConcurrentSkipListMap<>();

	private final ExecutorService starter = Executors
		.newSingleThreadExecutor(Thread.ofPlatform().name("vault-start").daemon().factory());

	private volatile boolean enabled;

	private volatile boolean closed;

	public VaultRegistry(NotesProperties properties, ApplicationContext main) {
		this.properties = properties;
		this.config = properties.vaults();
		this.main = main;
	}

	public String defaultName() {
		return this.config.defaultName();
	}

	public boolean isDefault(String name) {
		return name.equals(this.config.defaultName());
	}

	/** True when new vaults can be created from the app. */
	public boolean canCreate() {
		return this.enabled && this.config.allowCreate();
	}

	/** Finds the extra vaults once the main application is ready, and starts their contexts in the background. */
	@EventListener(ApplicationReadyEvent.class)
	public void onReady(ApplicationReadyEvent event) {
		if (event.getApplicationContext() != this.main) {
			return;
		}
		Path dir = vaultsDir();
		if (dir == null) {
			return;
		}
		this.enabled = true;
		if (!Files.isDirectory(dir)) {
			return;
		}
		List<Entry> found = new ArrayList<>();
		try (DirectoryStream<Path> children = Files.newDirectoryStream(dir)) {
			for (Path child : children) {
				String name = child.getFileName().toString();
				if (!Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS)) {
					continue;
				}
				if (!VaultNames.isValid(name)) {
					if (!name.startsWith(".")) {
						logger.warn("Vault folder {} skipped: a vault name is 1 to 32 lowercase letters, digits and dashes",
								child);
					}
					continue;
				}
				if (isDefault(name) || isMainVault(child)) {
					logger.warn("Vault folder {} skipped: it is the default vault's name or folder", child);
					continue;
				}
				found.add(new Entry(name, child));
			}
		}
		catch (IOException ex) {
			logger.error("VAULTS_UNREADABLE: the vaults folder {} cannot be listed; extra vaults are off", dir, ex);
			return;
		}
		found.stream().limit(Math.max(0, this.config.max() - 1)).forEach((entry) -> {
			this.extras.put(entry.name, entry);
			this.starter.execute(() -> start(entry));
		});
	}

	/** The folder of extra vaults, or null when they are off or it is unsafe. */
	private @Nullable Path vaultsDir() {
		Path dir = this.config.dirPath();
		if (dir == null) {
			return null;
		}
		Path vaults = dir.toAbsolutePath().normalize();
		Path vault = this.properties.vaultDir().toAbsolutePath().normalize();
		if (vaults.startsWith(vault) || realPath(vaults).startsWith(realPath(vault))) {
			logger.error("Extra vaults are off: notes.vaults.dir {} is inside the default vault {}", vaults, vault);
			return null;
		}
		return vaults;
	}

	private boolean isMainVault(Path folder) {
		return realPath(folder).equals(realPath(this.properties.vaultDir()));
	}

	private static Path realPath(Path path) {
		try {
			return path.toRealPath();
		}
		catch (IOException ex) {
			return path.toAbsolutePath().normalize();
		}
	}

	/** Every vault, the default one first, then the extra ones by name. */
	public List<Info> list() {
		List<Info> vaults = new ArrayList<>();
		vaults.add(new Info(this.config.defaultName(), true, State.READY, "/"));
		for (Entry entry : this.extras.values()) {
			vaults.add(info(entry));
		}
		return vaults;
	}

	private static Info info(Entry entry) {
		return new Info(entry.name, false, entry.state, "/v/" + entry.name + "/");
	}

	/** Creates a new, empty vault folder and starts its context (API.md §41.2). */
	public synchronized Info create(@Nullable String name) {
		Path dir = this.enabled ? vaultsDir() : null;
		if (dir == null || !this.config.allowCreate()) {
			throw new NotesException(ErrorCode.VAULTS_OFF,
					"Creating vaults is off on this server (notes.vaults.dir or notes.vaults.allow-create)");
		}
		if (!VaultNames.isValid(name)) {
			throw new NotesException(ErrorCode.INVALID_NAME,
					"A vault name is 1 to 32 lowercase letters, digits and dashes, starting and ending with a letter or digit",
					Map.of("path", (name != null) ? name : ""));
		}
		if (isDefault(name) || this.extras.containsKey(name)) {
			throw new NotesException(ErrorCode.ALREADY_EXISTS, "A vault with this name already exists",
					Map.of("path", name, "existingPath", name));
		}
		if (this.extras.size() + 1 >= this.config.max()) {
			throw NotesException.badRequest("This server has the most vaults it allows (" + this.config.max() + ")");
		}
		Path folder = dir.resolve(name);
		try {
			Files.createDirectories(dir);
			Files.createDirectory(folder);
		}
		catch (FileAlreadyExistsException ex) {
			throw new NotesException(ErrorCode.ALREADY_EXISTS,
					"A folder with this name already exists in the vaults folder; restart the server to serve it",
					Map.of("path", name, "existingPath", name));
		}
		catch (IOException ex) {
			throw new NotesException(ErrorCode.IO_ERROR, "The vault folder could not be created", Map.of(), ex);
		}
		Entry entry = new Entry(name, folder);
		this.extras.put(name, entry);
		logger.info("Vault {} created at {}", name, folder);
		this.starter.execute(() -> start(entry));
		return info(entry);
	}

	/**
	 * The dispatcher of a ready extra vault. Throws {@code 404 vault-not-found} for a name the server does not serve
	 * and {@code 503 vault-unavailable} while its context starts or after it failed to start.
	 */
	public DispatcherServlet dispatcher(String name) {
		Entry entry = this.extras.get(name);
		if (entry == null) {
			throw new NotesException(ErrorCode.VAULT_NOT_FOUND, "This server has no vault named " + name,
					Map.of("vault", name));
		}
		DispatcherServlet servlet = entry.servlet;
		if (entry.state != State.READY || servlet == null) {
			boolean starting = entry.state == State.STARTING;
			NotesException ex = new NotesException(ErrorCode.VAULT_UNAVAILABLE,
					starting ? "The vault is starting; retry shortly" : "The vault could not be started; see the server log",
					Map.of("vault", name, "reason", entry.state.json()));
			if (starting) {
				ex.getHeaders().set("Retry-After", "2");
			}
			throw ex;
		}
		return servlet;
	}

	/** An extra vault's context, for tests and diagnostics; null unless it is ready. */
	public @Nullable ConfigurableApplicationContext context(String name) {
		Entry entry = this.extras.get(name);
		return (entry != null && entry.state == State.READY) ? entry.context : null;
	}

	private void start(Entry entry) {
		if (this.closed) {
			return;
		}
		long started = System.nanoTime();
		try {
			ServletContext servletContext = ((WebApplicationContext) this.main).getServletContext();
			if (servletContext == null) {
				throw new IllegalStateException("The main application has no servlet context");
			}
			ConfigurableApplicationContext context = application(entry, servletContext).run();
			DispatcherServlet servlet = context.getBean(DispatcherServlet.class);
			servlet.init(new VaultServletConfig("notesapp-vault-" + entry.name, servletContext));
			synchronized (this) {
				if (this.closed) {
					servlet.destroy();
					context.close();
					return;
				}
				entry.context = context;
				entry.servlet = servlet;
				entry.state = State.READY;
			}
			logger.info("Vault {} ready in {} ms ({})", entry.name,
					TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started), entry.dir);
		}
		catch (RuntimeException | ServletException ex) {
			entry.state = State.FAILED;
			logger.error("VAULT_START_FAILED: vault {} at {} could not be started", entry.name, entry.dir, ex);
		}
	}

	private SpringApplication application(Entry entry, ServletContext servletContext) {
		SpringApplication application = new SpringApplication(VaultApplication.class);
		application.setWebApplicationType(WebApplicationType.SERVLET);
		application.setApplicationContextFactory(ApplicationContextFactory.of(() -> {
			AnnotationConfigServletWebApplicationContext context = new AnnotationConfigServletWebApplicationContext();
			context.setServletContext(servletContext);
			return context;
		}));
		application.setEnvironment(environment(entry));
		application.setBannerMode(Banner.Mode.OFF);
		application.setLogStartupInfo(false);
		application.setRegisterShutdownHook(false);
		// Logging is configured once, by the main application; re-initializing it would drop its appenders.
		application.setListeners(application.getListeners()
			.stream()
			.filter((listener) -> !(listener instanceof LoggingApplicationListener))
			.toList());
		application.addInitializers((context) -> shareServerWideBeans(context));
		return application;
	}

	/** The main environment's property sources, under the vault's own overrides. */
	private ConfigurableEnvironment environment(Entry entry) {
		ConfigurableEnvironment mainEnvironment = (ConfigurableEnvironment) this.main.getEnvironment();
		ApplicationServletEnvironment environment = new ApplicationServletEnvironment();
		MutablePropertySources sources = environment.getPropertySources();
		List<String> names = new ArrayList<>();
		sources.forEach((source) -> names.add(source.getName()));
		names.forEach(sources::remove);
		Map<String, Object> overrides = new LinkedHashMap<>();
		overrides.put("notes.vault-dir", entry.dir.toString());
		overrides.put("notes.vaults.current", entry.name);
		// Server-wide features stay with the default vault (DESIGN §5.39).
		overrides.put("notes.publish.enabled", "false");
		overrides.put("notes.mirror.url", "");
		overrides.put("notes.tailscale-watchdog.enabled", "false");
		overrides.put("notes.security.require-tailscale-interface", "false");
		overrides.put("spring.application.name", "notesapp-vault-" + entry.name);
		overrides.put("spring.jmx.enabled", "false");
		overrides.put("management.endpoints.access.default", "none");
		sources.addFirst(new MapPropertySource("notesVault", overrides));
		for (PropertySource<?> source : mainEnvironment.getPropertySources()) {
			if (!OWN_SOURCES.contains(source.getName())) {
				sources.addLast(source);
			}
		}
		environment.setActiveProfiles(mainEnvironment.getActiveProfiles());
		return environment;
	}

	/** Gives an extra context the main context's {@link ServerWide} beans to inject, without making them its beans. */
	private void shareServerWideBeans(ConfigurableApplicationContext context) {
		for (Object bean : this.main.getBeansWithAnnotation(ServerWide.class).values()) {
			context.getBeanFactory().registerResolvableDependency(ClassUtils.getUserClass(bean), bean);
		}
	}

	/**
	 * Closes the extra vaults when the main application starts to close, before its web server drains: their event
	 * streams end then, as the default vault's do, and their pending commits are flushed.
	 */
	@EventListener(ContextClosedEvent.class)
	public void onClosed(ContextClosedEvent event) {
		if (event.getApplicationContext() == this.main) {
			destroy();
		}
	}

	@Override
	public void destroy() {
		List<Entry> entries;
		synchronized (this) {
			if (this.closed) {
				return;
			}
			this.closed = true;
			entries = List.copyOf(this.extras.values());
		}
		this.starter.shutdownNow();
		for (Entry entry : entries) {
			DispatcherServlet servlet = entry.servlet;
			ConfigurableApplicationContext context = entry.context;
			entry.state = State.FAILED;
			entry.servlet = null;
			entry.context = null;
			try {
				if (servlet != null) {
					servlet.destroy();
				}
				if (context != null) {
					context.close();
				}
			}
			catch (RuntimeException ex) {
				logger.warn("Vault {} did not close cleanly", entry.name, ex);
			}
		}
	}

	/** The servlet configuration of an extra vault's dispatcher: a name and the shared servlet context. */
	private record VaultServletConfig(String name, ServletContext context) implements ServletConfig {

		@Override
		public String getServletName() {
			return this.name;
		}

		@Override
		public ServletContext getServletContext() {
			return this.context;
		}

		@Override
		public @Nullable String getInitParameter(String parameter) {
			return null;
		}

		@Override
		public Enumeration<String> getInitParameterNames() {
			return java.util.Collections.emptyEnumeration();
		}

	}

}
