package com.rjgehan.notes.index;

import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Tag counts and nested totals (DESIGN §5.5.11). */
class TagIndexTest {

	@Test
	void parentsGetTheirOwnCountAndTheTotalOfTheirDescendants() {
		TagIndex tags = new TagIndex();
		tags.setNote("a.md", List.of("Project/Alpha", "project"));
		tags.setNote("b.md", List.of("project/alpha/x"));
		assertThat(tags.stats()).containsExactly(new TagIndex.TagStat("project", 1, 2),
				new TagIndex.TagStat("Project/Alpha", 1, 2), new TagIndex.TagStat("project/alpha/x", 1, 1));
	}

	@Test
	void nestedTagsWhoseLowerCaseIsLongerKeepTheirParents() {
		// U+0130 lower-cases to two chars, so offsets in the key do not apply to the display form.
		TagIndex tags = new TagIndex();
		tags.setNote("a.md", List.of("BİLGİLİ/a"));
		tags.setNote("b.md", List.of("İZMİR/2"));
		assertThat(tags.stats()).containsExactlyInAnyOrder(new TagIndex.TagStat("BİLGİLİ", 0, 1),
				new TagIndex.TagStat("BİLGİLİ/a", 1, 1), new TagIndex.TagStat("İZMİR", 0, 1),
				new TagIndex.TagStat("İZMİR/2", 1, 1));
	}

}
