package com.rjgehan.notes.api;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.api.dto.GitState;
import com.rjgehan.notes.api.dto.StatusResponse;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.history.GitMirror;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.history.LargeFiles;
import com.rjgehan.notes.index.IndexBuilder;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.VaultFs;
import com.rjgehan.notes.watch.VaultReconciler;
import com.rjgehan.notes.watch.VaultWatcher;
import org.jspecify.annotations.Nullable;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.info.BuildProperties;
import org.springframework.context.ApplicationContext;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/status} (API.md §6.2). The event position is read before anything else, so an event that happened
 * after the snapshot is never skipped by a client that resumes from it.
 */
@RestController
public class StatusController {

	private final EventHub hub;

	private final VaultIndex index;

	private final IndexBuilder indexBuilder;

	private final GitStore git;

	private final CommitBatcher batcher;

	private final LargeFiles largeFiles;

	private final GitMirror mirror;

	private final VaultWatcher watcher;

	private final VaultReconciler reconciler;

	private final VaultFs fs;

	private final SettingsService settings;

	private final String buildSha;

	private final String appVersion;

	private final Instant startedAt;

	public StatusController(EventHub hub, VaultIndex index, IndexBuilder indexBuilder, GitStore git,
			CommitBatcher batcher, LargeFiles largeFiles, GitMirror mirror, VaultWatcher watcher,
			VaultReconciler reconciler, VaultFs fs, SettingsService settings, NotesProperties properties,
			ObjectProvider<BuildProperties> buildProperties, ApplicationContext context) {
		this.hub = hub;
		this.index = index;
		this.indexBuilder = indexBuilder;
		this.git = git;
		this.batcher = batcher;
		this.largeFiles = largeFiles;
		this.mirror = mirror;
		this.watcher = watcher;
		this.reconciler = reconciler;
		this.fs = fs;
		this.settings = settings;
		this.buildSha = properties.buildSha();
		BuildProperties build = buildProperties.getIfAvailable();
		this.appVersion = (build != null && build.getVersion() != null) ? build.getVersion() : "unknown";
		this.startedAt = Instant.ofEpochMilli(context.getStartupDate());
	}

	@GetMapping("/api/status")
	StatusResponse status() throws IOException {
		String eventId = this.hub.headEventId();
		VaultIndex.Stats stats = this.index.stats();
		VaultReconciler.RescanInfo rescan = this.reconciler.lastRescan();
		List<String> unwritable = (rescan != null) ? rescan.unwritableDirs() : List.of();
		StatusResponse.VaultStats vault = new StatusResponse.VaultStats(stats.notes(), stats.files(), stats.folders(),
				stats.bytes(), this.index.skipped(), unwritable);
		StatusResponse.IndexStats indexStats = new StatusResponse.IndexStats(
				this.indexBuilder.lastBuild().duration().toMillis(), (rescan != null) ? rescan.at() : null);
		return new StatusResponse(this.appVersion, this.buildSha, this.hub.bootId(), this.startedAt, eventId, vault,
				indexStats, gitStatus(), new StatusResponse.WatcherStatus(this.watcher.mode()),
				new StatusResponse.DiskStatus(this.fs.usableSpace(), (rescan != null) ? rescan.repoBytes() : null),
				new StatusResponse.SettingsStatus(this.settings.isReadOnly(), this.settings.readOnlyReason()),
				this.mirror.status());
	}

	private StatusResponse.GitStatus gitStatus() {
		CommitBatcher.Status status = this.batcher.status();
		boolean enabled = this.git.isEnabled();
		GitState state = !enabled ? GitState.DISABLED : status.importing() ? GitState.IMPORTING
				: (status.failingSince() != null) ? GitState.FAILING : GitState.READY;
		LargeFiles.Snapshot large = this.largeFiles.current();
		return new StatusResponse.GitStatus(enabled, state, enabled ? null : this.git.disabledReason(), head(),
				status.pendingPaths(), status.nextCommitAt(), status.lastCommitAt(), status.lastError(),
				status.failingSince(), new StatusResponse.LargeFilesStats(this.largeFiles.enabled() ? large.limit() : null,
						large.files().size(), large.bytes()));
	}

	private @Nullable String head() {
		try {
			return this.git.head();
		}
		catch (IOException ex) {
			return null;
		}
	}

}
