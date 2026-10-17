package com.rjgehan.notes.identity;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class Rfc2047Test {

	@Test
	void plainValuesAreUnchanged() {
		assertThat(Rfc2047.decode("R. J. Gehan")).isEqualTo("R. J. Gehan");
	}

	@Test
	void decodesQEncoding() {
		assertThat(Rfc2047.decode("=?utf-8?q?Ren=C3=A9_Gehan?=")).isEqualTo("René Gehan");
		assertThat(Rfc2047.decode("=?UTF-8?Q?Ren=c3=a9?=")).isEqualTo("René");
	}

	@Test
	void decodesBEncoding() {
		assertThat(Rfc2047.decode("=?utf-8?b?UmVuw6k=?=")).isEqualTo("René");
	}

	@Test
	void joinsAdjacentEncodedWordsAndKeepsSurroundingText() {
		assertThat(Rfc2047.decode("=?utf-8?q?Jos=C3=A9?= =?utf-8?q?_Mar=C3=ADa?=")).isEqualTo("José María");
		assertThat(Rfc2047.decode("Dr. =?utf-8?q?Jos=C3=A9?= Smith")).isEqualTo("Dr. José Smith");
	}

	@Test
	void invalidInputIsKeptAsWritten() {
		assertThat(Rfc2047.decode("=?nope-charset?q?abc?=")).isEqualTo("=?nope-charset?q?abc?=");
		assertThat(Rfc2047.decode("=?utf-8?q?bad=ZZ?=")).isEqualTo("=?utf-8?q?bad=ZZ?=");
		assertThat(Rfc2047.decode("=?utf-8?b?***?=")).isEqualTo("=?utf-8?b?***?=");
		assertThat(Rfc2047.decode("=?utf-8?q?unterminated")).isEqualTo("=?utf-8?q?unterminated");
	}

}
