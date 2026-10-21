package com.rjgehan.notes.api.dto;

import java.util.List;

/** {@code GET /api/habits}: the habit notes, and the values that daily notes can check habits in with. */
public record HabitsResponse(String folder, String tag, List<HabitNote> habits, String dailyFolder,
		List<DailyNoteValues> daily) {
}
