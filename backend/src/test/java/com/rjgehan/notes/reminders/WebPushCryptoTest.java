package com.rjgehan.notes.reminders;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;

import org.junit.jupiter.api.Test;

import static com.rjgehan.notes.reminders.WebPushCrypto.base64Url;
import static com.rjgehan.notes.reminders.WebPushCrypto.fromBase64Url;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WebPushCryptoTest {

	// RFC 8291 Appendix A.
	private static final String PLAINTEXT = "When I grow up, I want to be a watermelon";

	private static final String AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

	private static final String AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";

	private static final String UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

	private static final String UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";

	private static final String AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";

	private static final String SALT = "DGv6ra1nlYgDCS1FRnbzlw";

	private static final String BODY = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

	@Test
	void encryptsTheExampleOfRfc8291AppendixA() throws GeneralSecurityException {
		KeyPair sender = WebPushCrypto.keyPair(fromBase64Url(AS_PUBLIC), fromBase64Url(AS_PRIVATE));
		byte[] body = WebPushCrypto.encrypt(PLAINTEXT.getBytes(StandardCharsets.UTF_8), fromBase64Url(UA_PUBLIC),
				fromBase64Url(AUTH_SECRET), sender, fromBase64Url(SALT));
		assertThat(base64Url(body)).isEqualTo(BODY);
	}

	@Test
	void decryptsTheExampleOfRfc8291AppendixA() throws GeneralSecurityException {
		KeyPair userAgent = WebPushCrypto.keyPair(fromBase64Url(UA_PUBLIC), fromBase64Url(UA_PRIVATE));
		byte[] plaintext = WebPushCrypto.decrypt(fromBase64Url(BODY), userAgent, fromBase64Url(AUTH_SECRET));
		assertThat(new String(plaintext, StandardCharsets.UTF_8)).isEqualTo(PLAINTEXT);
	}

	@Test
	void aFreshMessageRoundTripsWithANewSenderKeyAndSalt() throws GeneralSecurityException {
		KeyPair userAgent = WebPushCrypto.generateKeyPair();
		byte[] auth = new byte[16];
		auth[3] = 7;
		byte[] uaPublic = WebPushCrypto.encodePublic((ECPublicKey) userAgent.getPublic());
		byte[] first = WebPushCrypto.encrypt("{\"title\":\"Pay rent\"}".getBytes(StandardCharsets.UTF_8), uaPublic, auth);
		byte[] second = WebPushCrypto.encrypt("{\"title\":\"Pay rent\"}".getBytes(StandardCharsets.UTF_8), uaPublic,
				auth);
		assertThat(first).isNotEqualTo(second);
		assertThat(new String(WebPushCrypto.decrypt(first, userAgent, auth), StandardCharsets.UTF_8))
			.isEqualTo("{\"title\":\"Pay rent\"}");
		// The header: salt, record size 4096, the 65-byte sender key.
		assertThat(first[16]).isZero();
		assertThat(first[18]).isEqualTo((byte) 0x10);
		assertThat(first[20]).isEqualTo((byte) 65);
		assertThat(first[21]).isEqualTo((byte) 0x04);
	}

	@Test
	void keysSurviveTheirEncoding() throws GeneralSecurityException {
		KeyPair pair = WebPushCrypto.generateKeyPair();
		byte[] publicPoint = WebPushCrypto.encodePublic((ECPublicKey) pair.getPublic());
		byte[] privateScalar = WebPushCrypto.encodePrivate((ECPrivateKey) pair.getPrivate());
		assertThat(publicPoint).hasSize(65);
		assertThat(privateScalar).hasSize(32);
		KeyPair again = WebPushCrypto.keyPair(publicPoint, privateScalar);
		assertThat(WebPushCrypto.encodePublic((ECPublicKey) again.getPublic())).isEqualTo(publicPoint);
		assertThat(WebPushCrypto.encodePrivate((ECPrivateKey) again.getPrivate())).isEqualTo(privateScalar);
	}

	@Test
	void refusesKeysThatAreNotP256Points() {
		byte[] point = fromBase64Url(UA_PUBLIC);
		point[64] ^= 1;
		assertThatThrownBy(() -> WebPushCrypto.decodePublic(point)).isInstanceOf(GeneralSecurityException.class);
		assertThatThrownBy(() -> WebPushCrypto.decodePublic(new byte[33]))
			.isInstanceOf(GeneralSecurityException.class);
		assertThatThrownBy(() -> WebPushCrypto.encrypt(new byte[4000], fromBase64Url(UA_PUBLIC), new byte[16]))
			.isInstanceOf(GeneralSecurityException.class);
	}

	@Test
	void aVapidTokenIsAnEs256JwtTheKeyVerifies() throws Exception {
		KeyPair pair = WebPushCrypto.generateKeyPair();
		String token = WebPushCrypto.vapidToken("https://web.push.apple.com", 1_800_000_000L,
				"mailto:owner@example.com", (ECPrivateKey) pair.getPrivate());
		String[] parts = token.split("\\.");
		assertThat(parts).hasSize(3);
		assertThat(new String(fromBase64Url(parts[0]), StandardCharsets.UTF_8))
			.isEqualTo("{\"typ\":\"JWT\",\"alg\":\"ES256\"}");
		assertThat(new String(fromBase64Url(parts[1]), StandardCharsets.UTF_8)).isEqualTo(
				"{\"aud\":\"https://web.push.apple.com\",\"exp\":1800000000,\"sub\":\"mailto:owner@example.com\"}");
		byte[] signature = fromBase64Url(parts[2]);
		assertThat(signature).hasSize(64);
		Signature verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
		verifier.initVerify(pair.getPublic());
		verifier.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
		assertThat(verifier.verify(signature)).isTrue();
	}

}
