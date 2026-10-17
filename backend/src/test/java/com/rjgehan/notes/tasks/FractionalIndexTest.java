package com.rjgehan.notes.tasks;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The vectors of the {@code fractional-indexing} package, so a client using it makes compatible keys. */
class FractionalIndexTest {

	@ParameterizedTest
	@CsvSource(nullValues = "null", value = {
			"null, null, a0",
			"null, a0, Zz",
			"null, Zz, Zy",
			"a0, null, a1",
			"a1, null, a2",
			"a0, a1, a0V",
			"a1, a2, a1V",
			"a0V, a1, a0l",
			"Zz, a0, ZzV",
			"Zz, a1, a0",
			"null, Y00, Xzzz",
			"bzz, null, c000",
			"a0, a0V, a0G",
			"a0, a0G, a08",
			"b125, b129, b127",
			"a0, a1V, a1",
			"Zz, a01, a0",
			"null, a0V, a0",
			"null, b999, b99",
			"zzzzzzzzzzzzzzzzzzzzzzzzzzy, null, zzzzzzzzzzzzzzzzzzzzzzzzzzz",
			"zzzzzzzzzzzzzzzzzzzzzzzzzzz, null, zzzzzzzzzzzzzzzzzzzzzzzzzzzV" })
	void keyBetween(String a, String b, String expected) {
		assertThat(FractionalIndex.between(a, b)).isEqualTo(expected);
	}

	@Test
	void severalKeys() {
		assertThat(FractionalIndex.between(null, null, 5)).containsExactly("a0", "a1", "a2", "a3", "a4");
		assertThat(FractionalIndex.between("a4", null, 10)).containsExactly("a5", "a6", "a7", "a8", "a9", "aA", "aB",
				"aC", "aD", "aE");
		assertThat(FractionalIndex.between(null, "a0", 5)).containsExactly("Zv", "Zw", "Zx", "Zy", "Zz");
		List<String> keys = FractionalIndex.between("a0", "a2", 20);
		assertThat(keys).hasSize(20).isSorted().allMatch((k) -> k.compareTo("a0") > 0 && k.compareTo("a2") < 0);
		assertThat(keys).doesNotHaveDuplicates();
	}

	@Test
	void invalidKeysAreRejected() {
		assertThat(FractionalIndex.isValid("a0")).isTrue();
		assertThat(FractionalIndex.isValid("a0V")).isTrue();
		for (String invalid : new String[] { "", "a00", "0", "a", "b1", "A00000000000000000000000000", "a0-",
				"é0" }) {
			assertThat(FractionalIndex.isValid(invalid)).as(invalid).isFalse();
		}
		assertThatThrownBy(() -> FractionalIndex.between("a00", null)).isInstanceOf(IllegalArgumentException.class);
		assertThatThrownBy(() -> FractionalIndex.between("a1", "a0")).isInstanceOf(IllegalArgumentException.class);
		assertThatThrownBy(() -> FractionalIndex.between("a1", "a1")).isInstanceOf(IllegalArgumentException.class);
	}

	@Test
	void repeatedInsertsStayOrdered() {
		Random random = new Random(42);
		List<String> keys = new ArrayList<>(List.of(FractionalIndex.between(null, null)));
		for (int i = 0; i < 2000; i++) {
			int at = random.nextInt(keys.size() + 1);
			String before = (at > 0) ? keys.get(at - 1) : null;
			String after = (at < keys.size()) ? keys.get(at) : null;
			String key = FractionalIndex.between(before, after);
			assertThat(FractionalIndex.isValid(key)).as(key).isTrue();
			keys.add(at, key);
		}
		assertThat(keys).isSorted().doesNotHaveDuplicates();
	}

}
