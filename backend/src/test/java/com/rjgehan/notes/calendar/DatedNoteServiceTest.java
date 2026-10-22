package com.rjgehan.notes.calendar;

import com.rjgehan.notes.api.error.NotesException;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The values that date a note, and the property list of {@code GET /api/notes/by-date} (API.md §25.1). */
class DatedNoteServiceTest {

	@Test
	void datesDateTimesAndLinksToDays() {
		assertThat(DatedNoteService.dayOf("2026-10-21")).isEqualTo("2026-10-21");
		assertThat(DatedNoteService.dayOf(" 2026-10-21 ")).isEqualTo("2026-10-21");
		assertThat(DatedNoteService.dayOf("2026-10-21T09:30")).isEqualTo("2026-10-21");
		assertThat(DatedNoteService.dayOf("2026-10-21 09:30:15")).isEqualTo("2026-10-21");
		assertThat(DatedNoteService.dayOf("2026-10-21T09:30:15.250+02:00")).isEqualTo("2026-10-21");
		assertThat(DatedNoteService.dayOf("2026-10-21T09:30Z")).isEqualTo("2026-10-21");
		assertThat(DatedNoteService.dayOf("[[2026-10-21]]")).isEqualTo("2026-10-21");
		assertThat(DatedNoteService.dayOf("[[2026-10-21|Wednesday]]")).isEqualTo("2026-10-21");
	}

	@Test
	void otherValuesDateNothing() {
		assertThat(DatedNoteService.dayOf("")).isNull();
		assertThat(DatedNoteService.dayOf("tomorrow")).isNull();
		assertThat(DatedNoteService.dayOf("2026-02-30")).isNull();
		assertThat(DatedNoteService.dayOf("2026-10-21 and later")).isNull();
		assertThat(DatedNoteService.dayOf("21/10/2026")).isNull();
		assertThat(DatedNoteService.dayOf("[[Daily/2026-10-21]]")).isNull();
		assertThat(DatedNoteService.dayOf("2026-1-2")).isNull();
	}

	@Test
	void propertiesDefaultToDateAndDropRepeats() {
		assertThat(DatedNoteService.properties(null)).containsExactly("date");
		assertThat(DatedNoteService.properties(" , ")).containsExactly("date");
		assertThat(DatedNoteService.properties("due, Date,date ,DUE")).containsExactly("due", "Date");
		assertThatThrownBy(() -> DatedNoteService.properties("a,b,c,d,e,f")).isInstanceOf(NotesException.class);
		assertThatThrownBy(() -> DatedNoteService.properties("x".repeat(65))).isInstanceOf(NotesException.class);
	}

}
