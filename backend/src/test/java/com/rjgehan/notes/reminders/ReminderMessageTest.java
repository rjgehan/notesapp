package com.rjgehan.notes.reminders;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** A reminder of an extra vault opens that vault (ROADMAP item 37, DESIGN §5.38). */
class ReminderMessageTest {

	@Test
	void anExtraVaultsRemindersCarryItsUrlPrefix() {
		ReminderMessage message = new ReminderMessage("task:1:at", "task", "1", "2026-10-16T12:05", "Pay", "Due",
				"/x/tasks/today?task=1");
		assertThat(message.withUrlPrefix("")).isSameAs(message);
		ReminderMessage work = message.withUrlPrefix("/v/work");
		assertThat(work.url()).isEqualTo("/v/work/x/tasks/today?task=1");
		assertThat(work.key()).isEqualTo(message.key());
		assertThat(work.titleOnly().url()).isEqualTo("/v/work/x/tasks/today?task=1");
	}

}
