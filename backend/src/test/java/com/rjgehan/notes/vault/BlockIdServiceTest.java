package com.rjgehan.notes.vault;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.vault.BlockIdService.Placement;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Where a block id goes (API.md §37); the client's {@code planBlockId} follows the same rules. */
class BlockIdServiceTest {

	private final BlockIdService service = new BlockIdService(null, null, null);

	@Test
	void appendsToTheLineKeepingCrlfAndTrailingSpaceOut() {
		BlockIdService.Plan plan = this.service.plan("a\r\nPara text  \r\nb", 1, "Para text  ", Placement.END, "k2");
		assertThat(plan.text()).isEqualTo("a\r\nPara text ^k2\r\nb");
		assertThat(plan.line()).isEqualTo(1);
		assertThat(this.service.plan("\nx", 0, "", Placement.END, "e").text()).isEqualTo("^e\nx");
	}

	@Test
	void keepsAnIdTheBlockAlreadyHas() {
		BlockIdService.Plan plan = this.service.plan("x ^old\n", 0, "x ^old", Placement.END, "new");
		assertThat(plan.id()).isEqualTo("old");
		assertThat(plan.text()).isNull();
		BlockIdService.Plan after = this.service.plan("| a |\n\n^had\n", 0, "| a |", Placement.AFTER, "new");
		assertThat(after.id()).isEqualTo("had");
		assertThat(after.line()).isEqualTo(2);
	}

	@Test
	void putsAStructuredBlocksIdOnALineOfItsOwn() {
		assertThat(this.service.plan("| a |\r\n|---|\r\nnext", 1, "|---|", Placement.AFTER, "tb").text())
			.isEqualTo("| a |\r\n|---|\r\n\r\n^tb\r\n\r\nnext");
		assertThat(this.service.plan("> q\n", 0, "> q", Placement.AFTER, "q").text()).isEqualTo("> q\n\n^q\n");
	}

	@Test
	void findsTheLineByItsTextOrRefuses() {
		assertThat(this.service.plan("new\nfirst\nTarget", 1, "Target", Placement.END, "id").text())
			.isEqualTo("new\nfirst\nTarget ^id");
		assertThatThrownBy(() -> this.service.plan("t\nt\nx", 2, "t", Placement.END, null))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.BLOCK_NOT_FOUND));
		assertThatThrownBy(() -> this.service.plan("a", 0, "b", Placement.END, null))
			.isInstanceOf(NotesException.class);
	}

	@Test
	void neverReusesAnIdOfAnotherBlock() {
		BlockIdService.Plan plan = this.service.plan("a ^Taken\nb", 1, "b", Placement.END, "taken");
		assertThat(plan.id()).matches("[a-z0-9]{6}").isNotEqualTo("taken");
	}

}
