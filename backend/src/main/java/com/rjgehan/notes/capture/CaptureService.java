package com.rjgehan.notes.capture;

import java.io.IOException;
import java.io.InputStream;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.AttachmentResult;
import com.rjgehan.notes.api.dto.CaptureRequest;
import com.rjgehan.notes.api.dto.CaptureResult;
import com.rjgehan.notes.api.dto.CaptureTarget;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.AttachmentService;
import com.rjgehan.notes.vault.FileService;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.VaultPaths;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Service;

/**
 * Quick capture (ROADMAP item 7, API.md §8.5): appends a thought, a link or a file to {@code Inbox.md} or to today's
 * daily note, creating the note when needed (a daily note from its template). "Today" comes from the device: the
 * date and time it sends, or its time zone; the server's own zone ({@code TZ}, UTC by default) is only a fallback.
 */
@Service
public class CaptureService {

	/** The inbox note, at the vault root. */
	public static final String INBOX = "Inbox.md";

	static final int MAX_URL_LENGTH = 4096;

	static final int MAX_TITLE_LENGTH = 1000;

	private final FileService files;

	private final AttachmentService attachments;

	private final SettingsService settings;

	private final VaultIndex index;

	private final VaultPaths paths;

	private final Clock clock;

	public CaptureService(FileService files, AttachmentService attachments, SettingsService settings, VaultIndex index,
			VaultPaths paths, Clock clock) {
		this.files = files;
		this.attachments = attachments;
		this.settings = settings;
		this.index = index;
		this.paths = paths;
		this.clock = clock;
	}

	/** {@code POST /api/capture}. */
	public CaptureResult capture(CaptureRequest request, Identity identity, @Nullable String origin)
			throws IOException {
		if (request.url() != null && request.url().length() > MAX_URL_LENGTH) {
			throw invalid("url", "must be at most " + MAX_URL_LENGTH + " characters");
		}
		if (request.title() != null && request.title().length() > MAX_TITLE_LENGTH) {
			throw invalid("title", "must be at most " + MAX_TITLE_LENGTH + " characters");
		}
		CaptureTarget target = (request.target() != null) ? request.target() : CaptureTarget.INBOX;
		ZonedDateTime when = when(request.date(), request.time(), request.tz());
		Settings s = this.settings.current();
		String entry = CaptureText.entry(stamp(target, when, s), request.text(), request.url(), request.title(), null);
		if (entry == null) {
			throw invalid("text", "text or url is required");
		}
		return append(target, notePath(target, when, s), entry, when, s, identity, origin, null);
	}

	/**
	 * {@code POST /api/capture/file}: stores the body as an attachment of the target note (the attachment settings
	 * decide its folder) and appends its embed, with {@code text} as the caption.
	 */
	public CaptureResult captureFile(String name, @Nullable String text, @Nullable CaptureTarget target,
			@Nullable String date, @Nullable String time, @Nullable String tz, InputStream body, long contentLength,
			Identity identity, @Nullable String origin) throws IOException {
		CaptureTarget t = (target != null) ? target : CaptureTarget.INBOX;
		ZonedDateTime when = when(date, time, tz);
		Settings s = this.settings.current();
		String notePath = notePath(t, when, s);
		String existing = this.index.fileIgnoreCase(this.paths.normalize(notePath));
		AttachmentResult attachment = this.attachments.upload(name, (existing != null) ? existing : notePath, body,
				contentLength, identity, origin);
		String entry = CaptureText.entry(stamp(t, when, s), text, null, null, attachment.markdown());
		return append(t, notePath, entry, when, s, identity, origin, attachment);
	}

	private CaptureResult append(CaptureTarget target, String notePath, @Nullable String entry, ZonedDateTime when,
			Settings s, Identity identity, @Nullable String origin, @Nullable AttachmentResult attachment)
			throws IOException {
		if (entry == null) {
			throw invalid("text", "text or url is required");
		}
		FileService.Saved saved = this.files.appendText(notePath, entry, () -> initialContent(target, notePath, when, s),
				identity, origin);
		return new CaptureResult(saved.result().file(), saved.created(), saved.result().createdFolders(), target,
				(attachment != null) ? attachment.file() : null);
	}

	/** {@code Inbox.md}, or today's daily note: {@code dailyNotes.folder} + the formatted date + {@code .md}. */
	static String notePath(CaptureTarget target, ZonedDateTime when, Settings s) {
		if (target == CaptureTarget.INBOX) {
			return INBOX;
		}
		return PathNames.join(s.dailyNotes().folder(), MomentFormat.format(s.dailyNotes().format(), when) + ".md");
	}

	/** The time stamp of an entry: date and time in the inbox, the time alone in a daily note. */
	static String stamp(CaptureTarget target, ZonedDateTime when, Settings s) {
		String time = MomentFormat.format(s.templates().timeFormat(), when);
		return (target == CaptureTarget.INBOX) ? MomentFormat.format(s.templates().dateFormat(), when) + " " + time
				: time;
	}

	/** A new daily note starts from its template, like one created in the app (API.md §15.2). */
	private String initialContent(CaptureTarget target, String notePath, ZonedDateTime when, Settings s) {
		String template = s.dailyNotes().template();
		if (target != CaptureTarget.DAILY || template.isEmpty()) {
			return "";
		}
		String text;
		try {
			text = this.files.readText(template).content();
		}
		catch (NotesException | IOException ex) {
			// A missing or unreadable template: the note starts empty, as the app does after its warning.
			return "";
		}
		String title = PathNames.basenameOf(PathNames.nameOf(notePath));
		String rendered = CaptureText.renderTemplate(text.replace("\r\n", "\n"), title, when, s.templates());
		return (rendered.isEmpty() || rendered.endsWith("\n")) ? rendered : rendered + "\n";
	}

	/** The device's local date and time of the capture. */
	ZonedDateTime when(@Nullable String date, @Nullable String time, @Nullable String tz) {
		ZoneId zone;
		try {
			zone = (tz != null && !tz.isBlank()) ? ZoneId.of(tz.strip()) : ZoneId.systemDefault();
		}
		catch (DateTimeException ex) {
			throw invalid("tz", "must be an IANA time zone such as America/New_York");
		}
		ZonedDateTime now = ZonedDateTime.ofInstant(this.clock.instant(), zone);
		LocalDate day;
		LocalTime at;
		try {
			day = (date != null && !date.isBlank()) ? LocalDate.parse(date.strip()) : now.toLocalDate();
		}
		catch (DateTimeParseException ex) {
			throw invalid("date", "must be YYYY-MM-DD");
		}
		try {
			at = (time != null && !time.isBlank()) ? LocalTime.parse(time.strip())
					: now.toLocalTime().truncatedTo(ChronoUnit.SECONDS);
		}
		catch (DateTimeParseException ex) {
			throw invalid("time", "must be HH:mm");
		}
		return ZonedDateTime.of(day, at, zone);
	}

	private static NotesException invalid(String field, String message) {
		return new NotesException(ErrorCode.BAD_REQUEST, field + " " + message,
				Map.of("errors", List.of(new FieldError(field, message))));
	}

}
