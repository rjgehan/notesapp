package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.AlertTestResult;
import com.rjgehan.notes.api.dto.AlertsState;
import com.rjgehan.notes.api.dto.AlertsStatus;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.ops.AppAlerts;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/** App-error alerts (API.md §6.6): {@code POST /api/alerts/test}. Their status is in {@code /api/status/details}. */
@RestController
public class AlertsController {

	private final AppAlerts alerts;

	public AlertsController(AppAlerts alerts) {
		this.alerts = alerts;
	}

	/** Sends a test alert to ntfy now and says whether it was accepted. */
	@PostMapping("/api/alerts/test")
	AlertTestResult test() {
		AlertsStatus status = this.alerts.status();
		if (status.state() != AlertsState.ON) {
			throw NotesException.badRequest("App alerts are off: " + status.reason());
		}
		return this.alerts.sendTest();
	}

}
