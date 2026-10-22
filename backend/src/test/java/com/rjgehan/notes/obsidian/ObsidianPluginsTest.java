package com.rjgehan.notes.obsidian;

import static org.assertj.core.api.Assertions.assertThat;

import com.rjgehan.notes.api.dto.CompatPlugin;
import com.rjgehan.notes.api.dto.CompatPlugin.Support;
import org.junit.jupiter.api.Test;

/** The plugin table of the compatibility report follows the roadmap items that have been built. */
class ObsidianPluginsTest {

	@Test
	void noPluginIsStillPlannedOnceItsItemIsBuilt() {
		// Every roadmap item the table points at is built (properties 13, publish 26, calendar 14,
		// reminders 9, tables 10, tasks 4, math 3, ...): nothing says "planned" any more.
		ObsidianPlugins.CORE.forEach((id, known) -> {
			assertThat(known.support()).as(id).isNotEqualTo(Support.PLANNED);
			assertThat(known.note()).as(id).doesNotContainIgnoringCase("planned");
		});
		ObsidianPlugins.COMMUNITY.forEach((id, known) -> {
			assertThat(known.support()).as(id).isNotEqualTo(Support.PLANNED);
			assertThat(known.note()).as(id).doesNotContainIgnoringCase("planned");
		});
	}

	@Test
	void builtFeaturesAnswerForTheirPlugins() {
		assertThat(ObsidianPlugins.core("properties").status()).isEqualTo(Support.SUPPORTED);
		assertThat(ObsidianPlugins.core("properties").roadmapItem()).isEqualTo(13);
		assertThat(ObsidianPlugins.core("publish").status()).isEqualTo(Support.PARTIAL);
		assertThat(ObsidianPlugins.core("publish").note()).contains("NOTES_PUBLISH_ENABLED");
		CompatPlugin calendar = ObsidianPlugins.community("calendar", "Calendar");
		assertThat(calendar.status()).isEqualTo(Support.SUPPORTED);
		assertThat(ObsidianPlugins.community("table-editor-obsidian", "Advanced Tables").status())
			.isEqualTo(Support.SUPPORTED);
		assertThat(ObsidianPlugins.community("obsidian-reminder-plugin", "Reminder").status())
			.isEqualTo(Support.PARTIAL);
		assertThat(ObsidianPlugins.community("obsidian-full-calendar", "Full Calendar").status())
			.isEqualTo(Support.PARTIAL);
		assertThat(ObsidianPlugins.community("obsidian-latex", "Extended MathJax").status())
			.isEqualTo(Support.PARTIAL);
	}

}
