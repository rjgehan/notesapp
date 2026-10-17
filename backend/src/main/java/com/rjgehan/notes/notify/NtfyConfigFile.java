package com.rjgehan.notes.notify;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.Locale;
import java.util.regex.Pattern;

import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Reads {@code ntfy.json} from the secrets directory ({@code notes.secrets-dir}, {@code /data/secrets}; DESIGN §4.1),
 * outside the vault, so the token never reaches git, the trash or a mirror. The file is read again whenever its size
 * or modification time changes, so editing it needs no restart. Its shape:
 *
 * <pre>
 * {
 *   "server": "https://ntfy.sh",          // optional, ntfy.sh by default
 *   "topic": "notes-6f1c…",               // required: the default topic
 *   "token": "tk_…",                      // optional access token
 *   "alerts": { "enabled": true, "topic": "notes-ops-…" }   // optional (ROADMAP item 38)
 * }
 * </pre>
 *
 * Other members (the reminders of ROADMAP item 9) are ignored here. Problems are described without the topic or the
 * token. A token is sent only over {@code https}, or over {@code http} to a loopback or tailnet host, where WireGuard
 * encrypts it.
 */
@Component
public class NtfyConfigFile {

	public static final String FILE_NAME = "ntfy.json";

	static final URI DEFAULT_SERVER = URI.create("https://ntfy.sh");

	private static final int MAX_SIZE = 64 * 1024;

	/** ntfy's topic rule. */
	private static final Pattern TOPIC = Pattern.compile("[A-Za-z0-9_-]{1,64}");

	/** Printable ASCII without spaces, so a token can never break out of its header. */
	private static final Pattern TOKEN = Pattern.compile("[\\x21-\\x7E]{1,512}");

	/** What reading the file gave: a configuration, or none, with the reason when the file exists but is unusable. */
	public record Loaded(@Nullable NtfyConfig config, @Nullable String problem) {

		static final Loaded ABSENT = new Loaded(null, null);

		static Loaded problem(String problem) {
			return new Loaded(null, FILE_NAME + " " + problem);
		}

	}

	private record Cached(FileTime modified, long size, Loaded loaded) {
	}

	private final Path file;

	private final JsonMapper mapper;

	private volatile @Nullable Cached cached;

	@Autowired
	public NtfyConfigFile(NotesProperties properties, JsonMapper mapper) {
		this(properties.secretsDir().resolve(FILE_NAME), mapper);
	}

	NtfyConfigFile(Path file, JsonMapper mapper) {
		this.file = file;
		this.mapper = mapper;
	}

	public Path path() {
		return this.file;
	}

	/** The current configuration; never throws. A missing file means "not configured". */
	public Loaded load() {
		BasicFileAttributes attributes;
		try {
			attributes = Files.readAttributes(this.file, BasicFileAttributes.class);
		}
		catch (NoSuchFileException ex) {
			this.cached = null;
			return Loaded.ABSENT;
		}
		catch (IOException ex) {
			return Loaded.problem("cannot be read (" + ex.getClass().getSimpleName() + ")");
		}
		Cached current = this.cached;
		if (current != null && current.modified().equals(attributes.lastModifiedTime())
				&& current.size() == attributes.size()) {
			return current.loaded();
		}
		Loaded loaded = read(attributes);
		this.cached = new Cached(attributes.lastModifiedTime(), attributes.size(), loaded);
		return loaded;
	}

	private Loaded read(BasicFileAttributes attributes) {
		if (!attributes.isRegularFile()) {
			return Loaded.problem("is not a file");
		}
		if (attributes.size() > MAX_SIZE) {
			return Loaded.problem("is larger than 64 KB");
		}
		try {
			return parse(Files.readAllBytes(this.file), this.mapper);
		}
		catch (IOException ex) {
			return Loaded.problem("cannot be read (" + ex.getClass().getSimpleName() + ")");
		}
	}

	static Loaded parse(byte[] bytes, JsonMapper mapper) {
		JsonNode root;
		try {
			root = mapper.readTree(bytes);
		}
		catch (JacksonException ex) {
			return Loaded.problem("is not valid JSON");
		}
		if (root == null || !root.isObject()) {
			return Loaded.problem("must hold a JSON object");
		}
		URI server = DEFAULT_SERVER;
		JsonNode serverNode = root.get("server");
		if (serverNode != null && !serverNode.isNull()) {
			if (!serverNode.isString()) {
				return Loaded.problem("has a \"server\" that is not a string");
			}
			String error = serverError(serverNode.stringValue());
			if (error != null) {
				return Loaded.problem("has an invalid \"server\": " + error);
			}
			server = normalize(URI.create(serverNode.stringValue().strip()));
		}
		String topic = string(root, "topic");
		if (topic == null || !TOPIC.matcher(topic).matches()) {
			return Loaded.problem("needs a \"topic\" of 1 to 64 letters, digits, '-' or '_'");
		}
		String token = string(root, "token");
		if (token != null && !TOKEN.matcher(token).matches()) {
			return Loaded.problem("has a \"token\" that is not a single word of printable ASCII");
		}
		if (token != null && !"https".equals(server.getScheme()) && !isLocalHost(server.getHost())) {
			return Loaded.problem("has a token, which is sent only over https (or http to a tailnet host)");
		}
		boolean alertsEnabled = true;
		String alertsTopic = topic;
		JsonNode alerts = root.get("alerts");
		if (alerts != null && !alerts.isNull()) {
			if (alerts.isBoolean()) {
				alertsEnabled = alerts.booleanValue();
			}
			else if (alerts.isObject()) {
				JsonNode enabled = alerts.get("enabled");
				if (enabled != null && !enabled.isNull()) {
					if (!enabled.isBoolean()) {
						return Loaded.problem("has an \"alerts.enabled\" that is not true or false");
					}
					alertsEnabled = enabled.booleanValue();
				}
				String own = string(alerts, "topic");
				if (own != null) {
					if (!TOPIC.matcher(own).matches()) {
						return Loaded.problem("needs an \"alerts.topic\" of 1 to 64 letters, digits, '-' or '_'");
					}
					alertsTopic = own;
				}
			}
			else {
				return Loaded.problem("has an \"alerts\" that is neither an object nor true or false");
			}
		}
		return new Loaded(new NtfyConfig(server, topic, token, new NtfyConfig.Alerts(alertsEnabled, alertsTopic)),
				null);
	}

	/** A string member, stripped; null when missing, null, blank or not a string. */
	private static @Nullable String string(JsonNode node, String name) {
		JsonNode value = node.get(name);
		if (value == null || !value.isString()) {
			return null;
		}
		String text = value.stringValue().strip();
		return text.isEmpty() ? null : text;
	}

	/** Why {@code value} is not a usable server URL, or null. The URL itself is never part of the message. */
	static @Nullable String serverError(String value) {
		URI uri;
		try {
			uri = new URI(value.strip());
		}
		catch (URISyntaxException ex) {
			return "not a URL";
		}
		String scheme = (uri.getScheme() != null) ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
		if (!scheme.equals("https") && !scheme.equals("http")) {
			return "use an https:// URL";
		}
		if (uri.getHost() == null || uri.getHost().isEmpty()) {
			return "the URL has no host";
		}
		if (uri.getRawUserInfo() != null) {
			return "the URL must not contain credentials; put the token in \"token\"";
		}
		if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
			return "the URL must not have a query or a fragment";
		}
		return null;
	}

	/** The URL without a trailing slash, with a lower-case scheme. */
	private static URI normalize(URI uri) {
		String text = uri.toString();
		while (text.endsWith("/")) {
			text = text.substring(0, text.length() - 1);
		}
		String scheme = uri.getScheme();
		return URI.create(scheme.toLowerCase(Locale.ROOT) + text.substring(scheme.length()));
	}

	/**
	 * Loopback and tailnet hosts, judged by name only: {@code localhost}, a name without dots (MagicDNS), a
	 * {@code *.ts.net} name, 127.0.0.0/8, {@code ::1}, Tailscale's 100.64.0.0/10 and {@code fd7a:115c:a1e0::/48}.
	 */
	static boolean isLocalHost(@Nullable String host) {
		if (host == null || host.isEmpty()) {
			return false;
		}
		String name = host.toLowerCase(Locale.ROOT);
		if (name.startsWith("[") && name.endsWith("]")) {
			name = name.substring(1, name.length() - 1);
		}
		if (name.equals("localhost") || name.endsWith(".ts.net") || name.equals("::1")
				|| name.startsWith("fd7a:115c:a1e0:")) {
			return true;
		}
		if (name.matches("\\d{1,3}(\\.\\d{1,3}){3}")) {
			String[] parts = name.split("\\.");
			int first = Integer.parseInt(parts[0]);
			int second = Integer.parseInt(parts[1]);
			return first == 127 || (first == 100 && second >= 64 && second <= 127);
		}
		return !name.contains(".") && !name.contains(":");
	}

}
