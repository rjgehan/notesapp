package com.rjgehan.notes.reminders;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

import com.rjgehan.notes.api.dto.CompleteTaskRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskReminder;
import com.rjgehan.notes.api.dto.TaskStatus;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.settings.DailyNotesSettings;
import com.rjgehan.notes.settings.RemindersSettings;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.support.TestVault.MutableClock;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/** The reminder scheduler: what is due, when it is delivered, and what it remembers (DESIGN §5.26). */
class ReminderSchedulerTest {

	private static final JsonMapper MAPPER = JsonMapper.builder().build();

	private static final Identity OWNER = new Identity("owner@notes", "Owner", null, Identity.Source.DEFAULT);

	@TempDir
	Path dir;

	/** Starts 2026-10-16T12:00:00Z. */
	private final MutableClock clock = TestVault.newClock();

	private final List<Task> tasks = new ArrayList<>();

	private final Set<String> files = new HashSet<>();

	private RemindersSettings reminders = new RemindersSettings(false, false, true, true, false, "09:00");

	private DailyNotesSettings daily = new DailyNotesSettings("YYYY-MM-DD", "Daily", "", false);

	private final List<CompleteTaskRequest> completed = new CopyOnWriteArrayList<>();

	/** A route that records what it is given and accepts while {@code accept} is true. */
	static final class FakeRoute implements ReminderRoute {

		final List<ReminderMessage> received = new CopyOnWriteArrayList<>();

		volatile boolean accept = true;

		@Override
		public String id() {
			return "inApp";
		}

		@Override
		public boolean enabled(RemindersSettings settings) {
			return settings.inApp();
		}

		@Override
		public Delivery deliver(ReminderMessage message, RemindersSettings settings) {
			this.received.add(message);
			return this.accept ? Delivery.ACCEPTED : Delivery.failed("no tab");
		}

	}

	private final FakeRoute route = new FakeRoute();

	private ReminderScheduler scheduler() {
		ReminderScheduler.Sources sources = new ReminderScheduler.Sources() {

			@Override
			public Settings settings() {
				Settings d = Settings.defaults();
				return new Settings(d.schemaVersion(), d.files(), daily, d.templates(), d.editor(), d.ai(), reminders);
			}

			@Override
			public List<Task> tasks() {
				return tasks.stream().filter((t) -> !t.status().isClosed()).toList();
			}

			@Override
			public @Nullable Task task(String id) {
				return tasks.stream().filter((t) -> t.id().equals(id)).findFirst().orElse(null);
			}

			@Override
			public boolean exists(String path) {
				return files.contains(path);
			}

		};
		return new ReminderScheduler(sources, (id, request, identity, origin) -> this.completed.add(request),
				List.of(this.route), this.clock, MAPPER, this.dir.resolve(".notesapp/reminders.json"),
				Duration.ofSeconds(15));
	}

	private static Task task(String id, String title, @Nullable String due, String... reminders) {
		return new Task(id, "list", null, null, title, "Bring the receipt", TaskStatus.OPEN, 0, due, null, null,
				List.of(reminders).stream().map(TaskReminder::new).toList(), List.of(), List.of(), "a", null, null, null,
				false);
	}

	@Test
	void aDueReminderIsDeliveredOnceEvenAfterARestart() throws Exception {
		ReminderScheduler scheduler = scheduler();
		this.tasks.add(task("t1", "Pay rent", "2026-10-16", "2026-10-16T12:05"));
		scheduler.tick();
		assertThat(this.route.received).isEmpty();

		this.clock.advance(Duration.ofMinutes(5));
		scheduler.tick();
		assertThat(this.route.received).singleElement().satisfies((m) -> {
			assertThat(m.key()).isEqualTo("task:t1:2026-10-16T12:05");
			assertThat(m.title()).isEqualTo("Pay rent");
			assertThat(m.body()).isEqualTo("Due 2026-10-16\nBring the receipt");
			assertThat(m.url()).isEqualTo("/x/tasks/today?task=t1");
			assertThat(m.taskId()).isEqualTo("t1");
			assertThat(m.at()).isEqualTo("2026-10-16T12:05");
		});
		scheduler.tick();
		assertThat(this.route.received).hasSize(1);

		JsonNode saved = MAPPER.readTree(Files.readAllBytes(this.dir.resolve(".notesapp/reminders.json")));
		assertThat(saved.get("delivered").has("task:t1:2026-10-16T12:05")).isTrue();

		this.clock.advance(Duration.ofMinutes(1));
		scheduler().tick();
		assertThat(this.route.received).hasSize(1);
	}

	@Test
	void remindersMissedWhileTheServerWasDownAreDeliveredWhenItStarts() {
		scheduler().tick();
		this.tasks.add(task("t1", "Call mum", null, "2026-10-16T15:00"));
		this.clock.advance(Duration.ofHours(5));
		scheduler().tick();
		assertThat(this.route.received).extracting(ReminderMessage::key).containsExactly("task:t1:2026-10-16T15:00");
		assertThat(this.route.received.get(0).body()).startsWith("Reminder");
	}

	@Test
	void remindersOlderThanADayAreNotDelivered() {
		ReminderScheduler scheduler = scheduler();
		scheduler.tick();
		this.tasks.add(task("t1", "Old", null, "2026-10-16T13:00"));
		this.clock.advance(Duration.ofHours(26));
		// A fresh state file would start from now; this one keeps the old baseline.
		scheduler().tick();
		assertThat(this.route.received).isEmpty();
	}

	@Test
	void withEveryRouteOffTheBaselineFollowsTheClockSoSwitchingOnDoesNotFlood() {
		this.reminders = RemindersSettings.defaults();
		ReminderScheduler scheduler = scheduler();
		this.tasks.add(task("t1", "Missed", null, "2026-10-16T13:00"));
		this.clock.advance(Duration.ofHours(2));
		scheduler.tick();
		this.reminders = new RemindersSettings(false, false, true, true, false, "09:00");
		this.clock.advance(Duration.ofSeconds(15));
		scheduler.tick();
		assertThat(this.route.received).isEmpty();

		this.tasks.add(task("t2", "Next", null, "2026-10-16T14:05"));
		this.clock.advance(Duration.ofMinutes(5));
		scheduler.tick();
		assertThat(this.route.received).extracting(ReminderMessage::key).containsExactly("task:t2:2026-10-16T14:05");
	}

	@Test
	void aReminderNoRouteAcceptedIsRetriedWithBackoff() {
		ReminderScheduler scheduler = scheduler();
		scheduler.tick();
		this.tasks.add(task("t1", "Retry", null, "2026-10-16T12:01"));
		this.clock.advance(Duration.ofMinutes(1));
		this.route.accept = false;
		scheduler.tick();
		scheduler.tick();
		assertThat(this.route.received).hasSize(1);
		assertThat(scheduler.lastError()).isEqualTo("inApp: no tab");

		this.clock.advance(Duration.ofSeconds(31));
		scheduler.tick();
		assertThat(this.route.received).hasSize(2);
		this.clock.advance(Duration.ofSeconds(31));
		scheduler.tick();
		assertThat(this.route.received).hasSize(2);

		this.route.accept = true;
		this.clock.advance(Duration.ofSeconds(30));
		scheduler.tick();
		assertThat(this.route.received).hasSize(3);
		assertThat(scheduler.lastDeliveredAt()).isEqualTo(this.clock.instant());
		this.clock.advance(Duration.ofMinutes(20));
		scheduler.tick();
		assertThat(this.route.received).hasSize(3);
	}

	@Test
	void localTimesAreReadInTheReportedZoneAndDstGapsMoveForward() {
		ReminderScheduler scheduler = scheduler();
		scheduler.setZone(ZoneId.of("Europe/Berlin"));
		assertThat(scheduler.zoneReported()).isTrue();
		// 14:30 in Berlin (CEST, +02:00) is 12:30Z.
		this.tasks.add(task("t1", "Berlin", null, "2026-10-16T14:30"));
		this.clock.advance(Duration.ofMinutes(29));
		scheduler.tick();
		assertThat(this.route.received).isEmpty();
		this.clock.advance(Duration.ofMinutes(1));
		scheduler.tick();
		assertThat(this.route.received).hasSize(1);

		assertThat(ReminderScheduler.instant("2026-03-29T02:30", ZoneId.of("Europe/Berlin")))
			.isEqualTo(Instant.parse("2026-03-29T01:30:00Z"));
		assertThat(ReminderScheduler.instant("2026-10-25T02:30", ZoneId.of("Europe/Berlin")))
			.isEqualTo(Instant.parse("2026-10-25T00:30:00Z"));
		assertThat(ReminderScheduler.instant("not a time", ZoneId.of("UTC"))).isNull();
	}

	@Test
	void aSnoozedReminderFiresAgainAndDoneCompletesOnlyTheReminderItBelongsTo() throws Exception {
		ReminderScheduler scheduler = scheduler();
		scheduler.tick();
		this.tasks.add(task("t1", "Water plants", "2026-10-16", "2026-10-16T12:01"));
		this.clock.advance(Duration.ofMinutes(1));
		scheduler.tick();
		assertThat(this.route.received).hasSize(1);

		Instant until = scheduler.snooze("t1", "2026-10-16T12:01", 10);
		assertThat(until).isEqualTo(this.clock.instant().plus(Duration.ofMinutes(10)));
		assertThat(scheduler.snooze("missing", "2026-10-16T12:01", 10)).isNull();
		this.clock.advance(Duration.ofMinutes(9));
		scheduler.tick();
		assertThat(this.route.received).hasSize(1);
		this.clock.advance(Duration.ofMinutes(1));
		scheduler.tick();
		assertThat(this.route.received).hasSize(2);
		assertThat(this.route.received.get(1).key()).startsWith("snooze:t1:2026-10-16T12:01:");
		assertThat(this.route.received.get(1).body()).contains("(snoozed)");
		scheduler.tick();
		assertThat(this.route.received).hasSize(2);

		assertThat(scheduler.done("t1", "2026-10-16T09:00", OWNER, null)).isFalse();
		assertThat(this.completed).isEmpty();
		assertThat(scheduler.done("t1", "2026-10-16T12:01", OWNER, "client-1")).isTrue();
		assertThat(this.completed).singleElement().satisfies((request) -> {
			assertThat(request.tz()).isEqualTo("Z");
			assertThat(request.base().get("due").asString()).isEqualTo("2026-10-16");
			assertThat(request.base().get("start").isNull()).isTrue();
		});
	}

	@Test
	void theDailyNoteNudgeComesOnlyWhenTodaysNoteIsMissing() {
		this.reminders = new RemindersSettings(false, false, true, true, true, "12:10");
		ReminderScheduler scheduler = scheduler();
		scheduler.tick();
		this.clock.advance(Duration.ofMinutes(10));
		scheduler.tick();
		assertThat(this.route.received).singleElement().satisfies((m) -> {
			assertThat(m.key()).isEqualTo("daily:2026-10-16");
			assertThat(m.kind()).isEqualTo("daily");
			assertThat(m.url()).isEqualTo("/?open=daily");
		});

		this.files.add("Daily/2026-10-17.md");
		this.clock.advance(Duration.ofDays(1));
		scheduler.tick();
		assertThat(this.route.received).hasSize(1);
	}

	@Test
	void upcomingListsTheNextRemindersSoonestFirst() {
		ReminderScheduler scheduler = scheduler();
		this.tasks.add(task("t1", "Later", null, "2026-10-18T09:00", "2026-10-15T09:00"));
		this.tasks.add(task("t2", "Sooner", null, "2026-10-17T09:00"));
		assertThat(scheduler.upcoming(5)).extracting((u) -> u.taskId() + "@" + u.at())
			.containsExactly("t2@2026-10-17T09:00", "t1@2026-10-18T09:00");
	}

	@Test
	void anUnreadableStateFileStartsFromNow() throws Exception {
		Files.createDirectories(this.dir.resolve(".notesapp"));
		Files.writeString(this.dir.resolve(".notesapp/reminders.json"), "{not json");
		this.tasks.add(task("t1", "Before", null, "2026-10-16T11:00"));
		scheduler().tick();
		assertThat(this.route.received).isEmpty();
		assertThat(MAPPER.readTree(Files.readAllBytes(this.dir.resolve(".notesapp/reminders.json")))
			.get("baseline")
			.asString()).isEqualTo("2026-10-16T12:00:00Z");
	}

}
