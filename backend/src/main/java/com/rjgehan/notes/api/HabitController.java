package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.HabitsResponse;
import com.rjgehan.notes.habits.HabitService;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Habit notes and daily-note check-ins (API.md §35). */
@RestController
public class HabitController {

	private final HabitService habits;

	public HabitController(HabitService habits) {
		this.habits = habits;
	}

	@GetMapping("/api/habits")
	HabitsResponse habits() {
		return this.habits.habits();
	}

}
