package com.rjgehan.notes.reminders;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.GeneralSecurityException;
import java.security.interfaces.ECPrivateKey;
import java.time.Duration;
import java.time.Instant;

import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * Sends one encrypted message to one push service endpoint (RFC 8030) with a VAPID {@code Authorization} header
 * (RFC 8292). Redirects are not followed. The endpoint's answer decides the outcome: 2xx delivered, 404 or 410 gone
 * (the subscription expired or was revoked, so it is dropped), anything else an error.
 */
@Component
public class WebPushSender {

	private static final Duration TIMEOUT = Duration.ofSeconds(15);

	/** How long a push service keeps an undelivered reminder (a phone that is off): one day. */
	static final int TTL_SECONDS = 24 * 60 * 60;

	/** What became of one message. {@code error} names the HTTP status or the exception, never the endpoint. */
	public record Result(boolean delivered, boolean gone, @Nullable String error) {

		static final Result DELIVERED = new Result(true, false, null);

	}

	private final HttpClient http;

	public WebPushSender() {
		this.http = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(10))
			.followRedirects(HttpClient.Redirect.NEVER)
			.build();
	}

	/**
	 * Encrypts {@code payload} for the subscription and posts it.
	 * @param subject the VAPID contact, a {@code mailto:} or {@code https:} URL
	 * @param topic replaces an undelivered earlier message with the same topic (up to 32 base64url characters), or null
	 */
	public Result send(PushStore.Subscription subscription, byte[] payload, PushStore.Vapid vapid, String subject,
			@Nullable String topic, Instant now) throws InterruptedException {
		URI endpoint;
		byte[] body;
		String token;
		try {
			endpoint = URI.create(subscription.endpoint());
			body = WebPushCrypto.encrypt(payload, WebPushCrypto.fromBase64Url(subscription.p256dh()),
					WebPushCrypto.fromBase64Url(subscription.auth()));
			String audience = endpoint.getScheme() + "://" + endpoint.getRawAuthority();
			token = WebPushCrypto.vapidToken(audience, now.plus(Duration.ofHours(12)).getEpochSecond(), subject,
					(ECPrivateKey) vapid.keyPair().getPrivate());
		}
		catch (GeneralSecurityException | IllegalArgumentException ex) {
			return new Result(false, false, "cannot encrypt for this device: " + ex.getMessage());
		}
		HttpRequest.Builder request = HttpRequest.newBuilder(endpoint)
			.timeout(TIMEOUT)
			.header("TTL", Integer.toString(TTL_SECONDS))
			.header("Urgency", "high")
			.header("Content-Encoding", "aes128gcm")
			.header("Content-Type", "application/octet-stream")
			.header("Authorization", "vapid t=" + token + ", k=" + vapid.publicKey())
			.POST(HttpRequest.BodyPublishers.ofByteArray(body));
		if (topic != null) {
			request.header("Topic", topic);
		}
		try {
			HttpResponse<Void> response = this.http.send(request.build(), HttpResponse.BodyHandlers.discarding());
			int status = response.statusCode();
			if (status / 100 == 2) {
				return Result.DELIVERED;
			}
			if (status == 404 || status == 410) {
				return new Result(false, true, "the push service answered HTTP " + status + " (subscription expired)");
			}
			return new Result(false, false, "the push service answered HTTP " + status);
		}
		catch (IOException ex) {
			return new Result(false, false, ex.getClass().getSimpleName()
					+ ((ex.getMessage() != null) ? ": " + ex.getMessage() : ""));
		}
	}

}
