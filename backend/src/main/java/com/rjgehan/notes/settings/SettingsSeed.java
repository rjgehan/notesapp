package com.rjgehan.notes.settings;

/**
 * Supplies the settings of a vault that has no settings file yet (DESIGN §5.12): an imported Obsidian vault starts
 * with the settings of its {@code .obsidian/} folder (ROADMAP item 24). Called once, at startup.
 */
@FunctionalInterface
public interface SettingsSeed {

	/** The first settings of this vault, starting from {@code defaults}; {@code defaults} when there is nothing to add. */
	Settings firstRun(Settings defaults);

}
