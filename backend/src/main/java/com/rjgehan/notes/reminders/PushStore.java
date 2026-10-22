package com.rjgehan.notes.reminders;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.vaults.ServerWide;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * The Web Push secrets in {@code <secrets-dir>/push.json} (DESIGN §5.26, ROADMAP item 9): the server's VAPID key pair
 * and every subscribed device. Outside the vault, so neither the private key nor the subscriptions (each one is a
 * capability to notify that device) reach git, the trash or a mirror. The key pair is created on first use. Writes
 * go to a temporary file that replaces the old one, readable by the owner only where the file system supports it.
 *
 * <pre>
 * {
 *   "vapid": { "publicKey": "B…", "privateKey": "…" },
 *   "subscriptions": [ { "id", "endpoint", "p256dh", "auth", "name", "createdAt", "lastSuccessAt", "lastError",
 *                        "lastErrorAt" } ]
 * }
 * </pre>
 */
@Component
@ServerWide
public class PushStore {

	public static final String FILE_NAME = "push.json";

	static final int MAX_SUBSCRIPTIONS = 50;

	static final int MAX_NAME = 80;

	static final int MAX_ENDPOINT = 2048;

	/** One subscribed device. */
	public record Subscription(String id, String endpoint, String p256dh, String auth, String name, Instant createdAt,
			@Nullable Instant lastSuccessAt, @Nullable String lastError, @Nullable Instant lastErrorAt) {

		Subscription withSuccess(Instant at) {
			return new Subscription(this.id, this.endpoint, this.p256dh, this.auth, this.name, this.createdAt, at, null,
					null);
		}

		Subscription withError(String error, Instant at) {
			return new Subscription(this.id, this.endpoint, this.p256dh, this.auth, this.name, this.createdAt,
					this.lastSuccessAt, error, at);
		}

		@Override
		public String toString() {
			return "Subscription[id=" + this.id + ", name=" + this.name + "]";
		}

	}

	/** The VAPID key pair: the public key as browsers want it, and the pair for signing. */
	public record Vapid(String publicKey, KeyPair keyPair) {

		@Override
		public String toString() {
			return "Vapid[" + this.publicKey + "]";
		}

	}

	/** Why a subscription was refused. */
	public static final class InvalidSubscriptionException extends Exception {

		private static final long serialVersionUID = 1L;

		InvalidSubscriptionException(String message) {
			super(message);
		}

	}

	private final Path file;

	private final JsonMapper mapper;

	private final Object lock = new Object();

	private @Nullable Vapid vapid;

	private List<Subscription> subscriptions = new ArrayList<>();

	private boolean loaded;

	private @Nullable String problem;

	@Autowired
	public PushStore(NotesProperties properties, JsonMapper mapper) {
		this(properties.secretsDir().resolve(FILE_NAME), mapper);
	}

	PushStore(Path file, JsonMapper mapper) {
		this.file = file;
		this.mapper = mapper;
	}

	public Path path() {
		return this.file;
	}

	/** Why the file cannot be used (unreadable or malformed), or null. Web Push is unavailable while there is one. */
	public @Nullable String problem() {
		synchronized (this.lock) {
			load();
			return this.problem;
		}
	}

	/** The key pair, or null before the first device subscribed. */
	public @Nullable Vapid vapid() {
		synchronized (this.lock) {
			load();
			return this.vapid;
		}
	}

	/** The key pair, created (and saved) when there is none yet. */
	public Vapid ensureVapid() throws IOException {
		synchronized (this.lock) {
			load();
			if (this.problem != null) {
				throw new IOException(this.problem);
			}
			if (this.vapid == null) {
				KeyPair pair = WebPushCrypto.generateKeyPair();
				Vapid created = new Vapid(
						WebPushCrypto.base64Url(WebPushCrypto.encodePublic((ECPublicKey) pair.getPublic())), pair);
				this.vapid = created;
				try {
					save();
				}
				catch (IOException ex) {
					this.vapid = null;
					throw ex;
				}
			}
			return this.vapid;
		}
	}

	public List<Subscription> subscriptions() {
		synchronized (this.lock) {
			load();
			return List.copyOf(this.subscriptions);
		}
	}

	/**
	 * Adds a device, or updates the one with the same endpoint (a browser re-subscribing keeps its id).
	 * @throws InvalidSubscriptionException when the endpoint is not an https URL or the keys are not valid
	 */
	public Subscription subscribe(String endpoint, String p256dh, String auth, @Nullable String name, Instant now)
			throws InvalidSubscriptionException, IOException {
		String endpointError = endpointError(endpoint);
		if (endpointError != null) {
			throw new InvalidSubscriptionException(endpointError);
		}
		try {
			WebPushCrypto.decodePublic(WebPushCrypto.fromBase64Url(p256dh));
		}
		catch (GeneralSecurityException | IllegalArgumentException ex) {
			throw new InvalidSubscriptionException("keys.p256dh is not a P-256 public key");
		}
		byte[] secret;
		try {
			secret = WebPushCrypto.fromBase64Url(auth);
		}
		catch (IllegalArgumentException ex) {
			secret = new byte[0];
		}
		if (secret.length != 16) {
			throw new InvalidSubscriptionException("keys.auth is not a 16-byte secret");
		}
		String label = cleanName(name);
		synchronized (this.lock) {
			ensureVapid();
			String id = idOf(endpoint);
			List<Subscription> next = new ArrayList<>(this.subscriptions);
			Subscription existing = null;
			for (int i = 0; i < next.size(); i++) {
				if (next.get(i).id().equals(id)) {
					existing = next.remove(i);
					break;
				}
			}
			if (existing == null && next.size() >= MAX_SUBSCRIPTIONS) {
				throw new InvalidSubscriptionException(
						"At most " + MAX_SUBSCRIPTIONS + " devices can be subscribed; remove one first");
			}
			Subscription subscription = new Subscription(id, endpoint, p256dh, auth, label,
					(existing != null) ? existing.createdAt() : now,
					(existing != null) ? existing.lastSuccessAt() : null, null, null);
			next.add(subscription);
			List<Subscription> before = this.subscriptions;
			this.subscriptions = next;
			try {
				save();
			}
			catch (IOException ex) {
				this.subscriptions = before;
				throw ex;
			}
			return subscription;
		}
	}

	/** Removes a device; false when there was none with this id. */
	public boolean remove(String id) throws IOException {
		synchronized (this.lock) {
			load();
			List<Subscription> next = new ArrayList<>(this.subscriptions);
			if (!next.removeIf((s) -> s.id().equals(id))) {
				return false;
			}
			this.subscriptions = next;
			save();
			return true;
		}
	}

	/** Records the outcome of a send; never throws (a failed write is retried with the next change). */
	void record(String id, @Nullable String error, Instant at) {
		synchronized (this.lock) {
			List<Subscription> next = new ArrayList<>();
			boolean changed = false;
			for (Subscription s : this.subscriptions) {
				if (s.id().equals(id)) {
					next.add((error == null) ? s.withSuccess(at) : s.withError(error, at));
					changed = true;
				}
				else {
					next.add(s);
				}
			}
			if (changed) {
				this.subscriptions = next;
				try {
					save();
				}
				catch (IOException ex) {
					// The state stays in memory; the next write carries it.
				}
			}
		}
	}

	/** The id of a subscription: the first 16 characters of the base64url SHA-256 of its endpoint. */
	static String idOf(String endpoint) {
		try {
			byte[] digest = MessageDigest.getInstance("SHA-256").digest(endpoint.getBytes(StandardCharsets.UTF_8));
			return WebPushCrypto.base64Url(digest).substring(0, 16);
		}
		catch (NoSuchAlgorithmException ex) {
			throw new IllegalStateException(ex);
		}
	}

	/** Why {@code endpoint} cannot be a push endpoint, or null. */
	static @Nullable String endpointError(@Nullable String endpoint) {
		if (endpoint == null || endpoint.isBlank()) {
			return "endpoint is required";
		}
		if (endpoint.length() > MAX_ENDPOINT) {
			return "endpoint is longer than " + MAX_ENDPOINT + " characters";
		}
		URI uri;
		try {
			uri = new URI(endpoint);
		}
		catch (URISyntaxException ex) {
			return "endpoint is not a URL";
		}
		if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty()) {
			return "endpoint must be an https URL";
		}
		if (uri.getRawUserInfo() != null || uri.getRawFragment() != null) {
			return "endpoint must not contain credentials or a fragment";
		}
		return null;
	}

	private static String cleanName(@Nullable String name) {
		String text = (name == null) ? "" : name.replaceAll("\\p{Cntrl}", " ").strip();
		if (text.isEmpty()) {
			return "Device";
		}
		return (text.length() > MAX_NAME) ? text.substring(0, MAX_NAME) : text;
	}

	// ---------------------------------------------------------------- file

	/** Reads the file once; holds {@code lock}. */
	private void load() {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		byte[] bytes;
		try {
			bytes = Files.readAllBytes(this.file);
		}
		catch (NoSuchFileException ex) {
			return;
		}
		catch (IOException ex) {
			this.problem = FILE_NAME + " cannot be read (" + ex.getClass().getSimpleName() + ")";
			return;
		}
		try {
			JsonNode root = this.mapper.readTree(bytes);
			if (root == null || !root.isObject()) {
				this.problem = FILE_NAME + " must hold a JSON object";
				return;
			}
			JsonNode vapidNode = root.get("vapid");
			if (vapidNode != null && vapidNode.isObject()) {
				String publicKey = vapidNode.path("publicKey").stringValue("");
				String privateKey = vapidNode.path("privateKey").stringValue("");
				this.vapid = new Vapid(publicKey, WebPushCrypto.keyPair(WebPushCrypto.fromBase64Url(publicKey),
						WebPushCrypto.fromBase64Url(privateKey)));
			}
			List<Subscription> read = new ArrayList<>();
			for (JsonNode s : root.path("subscriptions").values()) {
				String endpoint = s.path("endpoint").stringValue("");
				if (endpoint.isBlank()) {
					continue;
				}
				read.add(new Subscription(idOf(endpoint), endpoint, s.path("p256dh").stringValue(""),
						s.path("auth").stringValue(""), s.path("name").stringValue("Device"),
						instant(s.get("createdAt"), Instant.EPOCH), instant(s.get("lastSuccessAt"), null),
						s.path("lastError").stringValue(null), instant(s.get("lastErrorAt"), null)));
			}
			this.subscriptions = read;
		}
		catch (JacksonException ex) {
			this.problem = FILE_NAME + " is not valid JSON";
		}
		catch (GeneralSecurityException | IllegalArgumentException ex) {
			this.problem = FILE_NAME + " has an invalid VAPID key pair";
		}
	}

	private static @Nullable Instant instant(@Nullable JsonNode node, @Nullable Instant fallback) {
		if (node == null || !node.isString()) {
			return fallback;
		}
		try {
			return Instant.parse(node.stringValue());
		}
		catch (RuntimeException ex) {
			return fallback;
		}
	}

	/** Writes the file; holds {@code lock}. */
	private void save() throws IOException {
		ObjectNode root = this.mapper.createObjectNode();
		Vapid current = this.vapid;
		if (current != null) {
			ObjectNode v = root.putObject("vapid");
			v.put("publicKey", current.publicKey());
			v.put("privateKey", WebPushCrypto
				.base64Url(WebPushCrypto.encodePrivate((ECPrivateKey) current.keyPair().getPrivate())));
		}
		ArrayNode list = root.putArray("subscriptions");
		for (Subscription s : this.subscriptions) {
			ObjectNode o = list.addObject();
			o.put("id", s.id());
			o.put("endpoint", s.endpoint());
			o.put("p256dh", s.p256dh());
			o.put("auth", s.auth());
			o.put("name", s.name());
			o.put("createdAt", s.createdAt().toString());
			o.put("lastSuccessAt", (s.lastSuccessAt() != null) ? s.lastSuccessAt().toString() : null);
			o.put("lastError", s.lastError());
			o.put("lastErrorAt", (s.lastErrorAt() != null) ? s.lastErrorAt().toString() : null);
		}
		byte[] bytes = this.mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(root);
		Path dir = this.file.toAbsolutePath().getParent();
		Files.createDirectories(dir);
		Path tmp = dir.resolve("." + FILE_NAME + ".tmp");
		Files.write(tmp, bytes);
		ownerOnly(tmp);
		try {
			Files.move(tmp, this.file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		}
		catch (AtomicMoveNotSupportedException ex) {
			Files.move(tmp, this.file, StandardCopyOption.REPLACE_EXISTING);
		}
	}

	private static void ownerOnly(Path path) {
		if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("windows")) {
			try {
				Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
			}
			catch (IOException | UnsupportedOperationException ex) {
				// Best effort: the secrets directory itself should not be readable by others.
			}
		}
	}

}
