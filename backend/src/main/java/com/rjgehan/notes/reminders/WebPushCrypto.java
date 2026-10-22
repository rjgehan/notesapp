package com.rjgehan.notes.reminders;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The cryptography of Web Push with the JDK alone (DESIGN §5.26): P-256 keys in the uncompressed form browsers use,
 * message encryption by RFC 8291 in the {@code aes128gcm} content coding of RFC 8188 (one record), and the ES256
 * signature of a VAPID token (RFC 8292). Tested against the example of RFC 8291 Appendix A.
 */
public final class WebPushCrypto {

	/** The record size written in the header; a push message is always a single, shorter record. */
	static final int RECORD_SIZE = 4096;

	/** The most plaintext one message may carry: push services accept 4096 bytes of body. */
	public static final int MAX_PLAINTEXT = 3993;

	private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();

	private static final Base64.Decoder B64_DECODER = Base64.getUrlDecoder();

	private static final SecureRandom RANDOM = new SecureRandom();

	private static final ECParameterSpec P256 = p256();

	private WebPushCrypto() {
	}

	private static ECParameterSpec p256() {
		try {
			AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
			parameters.init(new ECGenParameterSpec("secp256r1"));
			return parameters.getParameterSpec(ECParameterSpec.class);
		}
		catch (GeneralSecurityException ex) {
			throw new IllegalStateException("P-256 is not available", ex);
		}
	}

	// ---------------------------------------------------------------- encoding

	public static String base64Url(byte[] bytes) {
		return B64.encodeToString(bytes);
	}

	/** Decodes base64url, with or without padding; also accepts the standard alphabet some clients send. */
	public static byte[] fromBase64Url(String text) {
		String normalized = text.strip().replace('+', '-').replace('/', '_');
		while (normalized.endsWith("=")) {
			normalized = normalized.substring(0, normalized.length() - 1);
		}
		return B64_DECODER.decode(normalized);
	}

	// ---------------------------------------------------------------- keys

	public static KeyPair generateKeyPair() {
		try {
			KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
			generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
			return generator.generateKeyPair();
		}
		catch (GeneralSecurityException ex) {
			throw new IllegalStateException("Cannot create a P-256 key pair", ex);
		}
	}

	/** The 65-byte uncompressed point {@code 0x04 || x || y}. */
	public static byte[] encodePublic(ECPublicKey key) {
		byte[] out = new byte[65];
		out[0] = 0x04;
		copyUnsigned(key.getW().getAffineX(), out, 1);
		copyUnsigned(key.getW().getAffineY(), out, 33);
		return out;
	}

	/** The 32-byte private scalar. */
	public static byte[] encodePrivate(ECPrivateKey key) {
		byte[] out = new byte[32];
		copyUnsigned(key.getS(), out, 0);
		return out;
	}

	/**
	 * A public key from its uncompressed point.
	 * @throws GeneralSecurityException when the bytes are not a point of P-256
	 */
	public static ECPublicKey decodePublic(byte[] point) throws GeneralSecurityException {
		if (point.length != 65 || point[0] != 0x04) {
			throw new GeneralSecurityException("not an uncompressed P-256 point");
		}
		BigInteger x = new BigInteger(1, Arrays.copyOfRange(point, 1, 33));
		BigInteger y = new BigInteger(1, Arrays.copyOfRange(point, 33, 65));
		if (!onCurve(x, y)) {
			throw new GeneralSecurityException("the point is not on P-256");
		}
		return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), P256));
	}

	public static ECPrivateKey decodePrivate(byte[] scalar) throws GeneralSecurityException {
		if (scalar.length != 32) {
			throw new GeneralSecurityException("not a P-256 private key");
		}
		return (ECPrivateKey) KeyFactory.getInstance("EC")
			.generatePrivate(new ECPrivateKeySpec(new BigInteger(1, scalar), P256));
	}

	/** The key pair of a stored private scalar and public point. */
	public static KeyPair keyPair(byte[] publicPoint, byte[] privateScalar) throws GeneralSecurityException {
		return new KeyPair(decodePublic(publicPoint), decodePrivate(privateScalar));
	}

	private static boolean onCurve(BigInteger x, BigInteger y) {
		BigInteger p = ((java.security.spec.ECFieldFp) P256.getCurve().getField()).getP();
		if (x.signum() < 0 || y.signum() < 0 || x.compareTo(p) >= 0 || y.compareTo(p) >= 0) {
			return false;
		}
		BigInteger left = y.multiply(y).mod(p);
		BigInteger right = x.pow(3).add(P256.getCurve().getA().multiply(x)).add(P256.getCurve().getB()).mod(p);
		return left.equals(right);
	}

	private static void copyUnsigned(BigInteger value, byte[] out, int offset) {
		byte[] bytes = value.toByteArray();
		int length = Math.min(bytes.length, 32);
		System.arraycopy(bytes, bytes.length - length, out, offset + 32 - length, length);
	}

	// ---------------------------------------------------------------- RFC 8291

	/**
	 * Encrypts one push message for a subscription with a new sender key pair and salt.
	 * @param userAgentPublic the subscription's {@code p256dh} key (65 bytes)
	 * @param authSecret the subscription's {@code auth} secret (16 bytes)
	 */
	public static byte[] encrypt(byte[] plaintext, byte[] userAgentPublic, byte[] authSecret)
			throws GeneralSecurityException {
		byte[] salt = new byte[16];
		RANDOM.nextBytes(salt);
		return encrypt(plaintext, userAgentPublic, authSecret, generateKeyPair(), salt);
	}

	/** {@link #encrypt(byte[], byte[], byte[])} with a given sender key pair and salt (for the RFC's test vector). */
	static byte[] encrypt(byte[] plaintext, byte[] userAgentPublic, byte[] authSecret, KeyPair sender, byte[] salt)
			throws GeneralSecurityException {
		if (plaintext.length > MAX_PLAINTEXT) {
			throw new GeneralSecurityException("the message is longer than " + MAX_PLAINTEXT + " bytes");
		}
		if (authSecret.length != 16) {
			throw new GeneralSecurityException("the auth secret must be 16 bytes");
		}
		if (salt.length != 16) {
			throw new GeneralSecurityException("the salt must be 16 bytes");
		}
		ECPublicKey uaKey = decodePublic(userAgentPublic);
		byte[] senderPublic = encodePublic((ECPublicKey) sender.getPublic());
		KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
		agreement.init(sender.getPrivate());
		agreement.doPhase(uaKey, true);
		byte[] ecdhSecret = agreement.generateSecret();

		// RFC 8291 §3.3: the input keying material, then RFC 8188 §2.2: the content key and nonce.
		byte[] keyInfo = concat("WebPush: info".getBytes(StandardCharsets.US_ASCII), new byte[] { 0 },
				userAgentPublic, senderPublic);
		byte[] ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
		byte[] cek = hkdf(salt, ikm, info("Content-Encoding: aes128gcm"), 16);
		byte[] nonce = hkdf(salt, ikm, info("Content-Encoding: nonce"), 12);

		// One record, the last: the plaintext and the 0x02 delimiter, no padding.
		byte[] padded = Arrays.copyOf(plaintext, plaintext.length + 1);
		padded[plaintext.length] = 0x02;
		Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
		cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
		byte[] ciphertext = cipher.doFinal(padded);

		ByteBuffer header = ByteBuffer.allocate(16 + 4 + 1 + senderPublic.length);
		header.put(salt).putInt(RECORD_SIZE).put((byte) senderPublic.length).put(senderPublic);
		return concat(header.array(), ciphertext);
	}

	/**
	 * Decrypts an {@code aes128gcm} push message with the subscription's private key: what a browser does, for tests
	 * and for checking a message before it is sent.
	 */
	static byte[] decrypt(byte[] body, KeyPair userAgent, byte[] authSecret) throws GeneralSecurityException {
		ByteBuffer in = ByteBuffer.wrap(body);
		byte[] salt = new byte[16];
		in.get(salt);
		in.getInt();
		byte[] senderPublic = new byte[in.get() & 0xFF];
		in.get(senderPublic);
		byte[] ciphertext = new byte[in.remaining()];
		in.get(ciphertext);
		byte[] uaPublic = encodePublic((ECPublicKey) userAgent.getPublic());
		KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
		agreement.init(userAgent.getPrivate());
		agreement.doPhase(decodePublic(senderPublic), true);
		byte[] keyInfo = concat("WebPush: info".getBytes(StandardCharsets.US_ASCII), new byte[] { 0 }, uaPublic,
				senderPublic);
		byte[] ikm = hkdf(authSecret, agreement.generateSecret(), keyInfo, 32);
		byte[] cek = hkdf(salt, ikm, info("Content-Encoding: aes128gcm"), 16);
		byte[] nonce = hkdf(salt, ikm, info("Content-Encoding: nonce"), 12);
		Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
		cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, nonce));
		byte[] padded = cipher.doFinal(ciphertext);
		int end = padded.length - 1;
		while (end >= 0 && padded[end] == 0) {
			end--;
		}
		if (end < 0 || padded[end] != 0x02) {
			throw new GeneralSecurityException("not a last record");
		}
		return Arrays.copyOf(padded, end);
	}

	private static byte[] info(String label) {
		return concat(label.getBytes(StandardCharsets.US_ASCII), new byte[] { 0 });
	}

	/** HKDF-SHA256 (RFC 5869) for outputs of at most 32 bytes: one expansion block. */
	static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int length) throws GeneralSecurityException {
		byte[] prk = hmac(salt, ikm);
		byte[] okm = hmac(prk, concat(info, new byte[] { 1 }));
		return Arrays.copyOf(okm, length);
	}

	private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
		Mac mac = Mac.getInstance("HmacSHA256");
		mac.init(new SecretKeySpec(key, "HmacSHA256"));
		return mac.doFinal(data);
	}

	private static byte[] concat(byte[]... parts) {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		for (byte[] part : parts) {
			out.writeBytes(part);
		}
		return out.toByteArray();
	}

	// ---------------------------------------------------------------- RFC 8292

	/**
	 * A VAPID token: a JWT signed with ES256 that names the push service ({@code aud}), when it expires and who to
	 * contact ({@code sub}, a {@code mailto:} or {@code https:} URL).
	 */
	public static String vapidToken(String audience, long expiresEpochSecond, String subject, ECPrivateKey key)
			throws GeneralSecurityException {
		String header = B64.encodeToString("{\"typ\":\"JWT\",\"alg\":\"ES256\"}".getBytes(StandardCharsets.UTF_8));
		String claims = B64.encodeToString(("{\"aud\":\"" + jsonEscape(audience) + "\",\"exp\":" + expiresEpochSecond
				+ ",\"sub\":\"" + jsonEscape(subject) + "\"}")
			.getBytes(StandardCharsets.UTF_8));
		String signingInput = header + "." + claims;
		Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
		signature.initSign(key);
		signature.update(signingInput.getBytes(StandardCharsets.US_ASCII));
		return signingInput + "." + B64.encodeToString(signature.sign());
	}

	private static String jsonEscape(String text) {
		StringBuilder out = new StringBuilder();
		for (char c : text.toCharArray()) {
			if (c == '"' || c == '\\') {
				out.append('\\').append(c);
			}
			else if (c < 0x20) {
				out.append(String.format("\\u%04x", (int) c));
			}
			else {
				out.append(c);
			}
		}
		return out.toString();
	}

}
