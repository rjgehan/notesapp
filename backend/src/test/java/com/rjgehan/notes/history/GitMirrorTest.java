package com.rjgehan.notes.history;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

import com.rjgehan.notes.api.dto.MirrorState;
import com.rjgehan.notes.api.dto.MirrorStatus;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.events.StatusChangedEvent;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.support.TestVault;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.RefUpdate;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;

import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The git mirror (ROADMAP item 2, DESIGN §5.8) against a local bare repository as the remote: the delay, the
 * fast-forward-only rule, failures with backoff, and that the token never shows.
 */
@ExtendWith(OutputCaptureExtension.class)
class GitMirrorTest {

	@TempDir
	Path dir;

	@TempDir
	Path remotes;

	private TestVault vault;

	private Path bare;

	@BeforeEach
	void setUp() throws Exception {
		this.vault = TestVault.start(this.dir);
		this.bare = this.remotes.resolve("mirror.git");
		Git.init().setBare(true).setDirectory(this.bare.toFile()).setInitialBranch("main").call().close();
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private GitMirror mirror(String url, String... settings) {
		Map<String, String> overrides = new HashMap<>();
		overrides.put("notes.mirror.url", url);
		for (int i = 0; i < settings.length; i += 2) {
			overrides.put(settings[i], settings[i + 1]);
		}
		return new GitMirror(this.vault.git, this.vault.hub, this.vault.clock,
				TestProperties.forVault(this.dir, overrides));
	}

	private GitMirror mirror() {
		return mirror(this.bare.toUri().toString());
	}

	private String commit(String name) throws Exception {
		this.vault.files.createText(name, name, OnConflict.FAIL, TestVault.ALICE, "client-a1");
		return this.vault.flush().id();
	}

	private @Nullable String remoteHead() throws Exception {
		try (Repository remote = new FileRepositoryBuilder().setGitDir(this.bare.toFile()).build()) {
			ObjectId id = remote.resolve("refs/heads/main");
			return (id != null) ? id.name() : null;
		}
	}

	private long mirrorEvents() {
		return this.vault.hub.published.stream()
			.filter((event) -> event instanceof StatusChangedEvent changed
					&& changed.reason() == StatusChangedEvent.Reason.MIRROR)
			.count();
	}

	private void advance(Duration duration) {
		this.vault.clock.advance(duration);
	}

	@Test
	void isOffUntilConfigured() throws Exception {
		GitMirror mirror = mirror("");
		commit("a.md");
		mirror.tick();
		MirrorStatus status = mirror.status();
		assertThat(status.state()).isEqualTo(MirrorState.DISABLED);
		assertThat(status.reason()).isEqualTo("not configured");
		assertThat(status.remote()).isNull();
		assertThat(mirror.requestPush().state()).isEqualTo(MirrorState.DISABLED);
		assertThat(remoteHead()).isNull();
	}

	@Test
	void isOffWhileHistoryIsDisabled() throws Exception {
		try (TestVault noGit = TestVault.start(this.remotes.resolve("v2"), Map.of("notes.git.enabled", "false"))) {
			GitMirror mirror = new GitMirror(noGit.git, noGit.hub, noGit.clock,
					TestProperties.forVault(noGit.root, Map.of("notes.mirror.url", this.bare.toUri().toString())));
			assertThat(mirror.status().reason()).isEqualTo("history is disabled");
		}
	}

	@Test
	void onlyPlainHttpsUrlsWithATokenFileAreAccepted() {
		assertThat(GitMirror.configurationError("", "")).isEqualTo("not configured");
		assertThat(GitMirror.configurationError("https://github.com/me/vault.git", "/run/secrets/mirror_token"))
			.isNull();
		assertThat(GitMirror.configurationError("https://github.com/me/vault.git", "")).contains("token file");
		assertThat(GitMirror.configurationError("http://github.com/me/vault.git", "/t")).contains("https://");
		assertThat(GitMirror.configurationError("git@github.com:me/vault.git", "/t")).isNotNull();
		assertThat(GitMirror.configurationError("ssh://git@github.com/me/vault.git", "/t")).contains("https://");
		assertThat(GitMirror.configurationError("https://me:ghp_secret@github.com/me/vault.git", "/t"))
			.contains("without credentials")
			.doesNotContain("ghp_secret");
		assertThat(GitMirror.configurationError("https://github.com/me/vault.git?x=1", "/t")).isNotNull();
		assertThat(GitMirror.configurationError("file:///srv/mirror.git", "")).isNull();
	}

	@Test
	void aUrlWithCredentialsIsRefusedAndNeverShown() {
		GitMirror mirror = mirror("https://me:ghp_secret@github.com/me/vault.git", "notes.mirror.token-file", "/t");
		MirrorStatus status = mirror.status();
		assertThat(status.state()).isEqualTo(MirrorState.DISABLED);
		assertThat(status.remote()).isEqualTo("https://github.com/me/vault.git");
	}

	@Test
	void pushesTenMinutesAfterTheLastCommit() throws Exception {
		GitMirror mirror = mirror();
		String head = commit("a.md");
		mirror.tick();
		assertThat(mirror.status().nextPushAt()).isEqualTo(this.vault.clock.instant().plus(Duration.ofMinutes(10)));
		advance(Duration.ofMinutes(10).minusSeconds(1));
		mirror.tick();
		assertThat(remoteHead()).isNull();
		advance(Duration.ofSeconds(1));
		mirror.tick();
		assertThat(remoteHead()).isEqualTo(head);
		MirrorStatus status = mirror.status();
		assertThat(status.state()).isEqualTo(MirrorState.READY);
		assertThat(status.pushedCommit()).isEqualTo(head);
		assertThat(status.lastPushAt()).isEqualTo(this.vault.clock.instant());
		assertThat(status.nextPushAt()).isNull();
		assertThat(status.branch()).isEqualTo("main");
		assertThat(status.pushing()).isFalse();
		// Nothing new: no further pushes are due.
		advance(Duration.ofHours(2));
		mirror.tick();
		assertThat(mirror.status().nextPushAt()).isNull();
	}

	@Test
	void aLongSessionIsStillMirroredWithinTheMaximumDelay() throws Exception {
		GitMirror mirror = mirror();
		commit("n0.md");
		mirror.tick();
		for (int i = 1; i <= 11; i++) {
			advance(Duration.ofMinutes(5));
			commit("n" + i + ".md");
			mirror.tick();
			assertThat(remoteHead()).as("after %d minutes", i * 5).isNull();
		}
		advance(Duration.ofMinutes(5));
		mirror.tick();
		assertThat(remoteHead()).isEqualTo(this.vault.git.head());
	}

	@Test
	void neverForcePushesAndStopsWhenTheMirrorHasDiverged() throws Exception {
		GitMirror mirror = mirror();
		String first = commit("a.md");
		mirror.requestPush();
		mirror.tick();
		assertThat(remoteHead()).isEqualTo(first);

		// Someone else pushes to the mirror: it now has a commit the vault does not.
		Path other = this.remotes.resolve("other");
		try (Git clone = Git.cloneRepository().setURI(this.bare.toUri().toString()).setDirectory(other.toFile()).call()) {
			Files.writeString(other.resolve("elsewhere.md"), "x");
			clone.add().addFilepattern("elsewhere.md").call();
			PersonIdent someone = new PersonIdent("Someone", "someone@example.com");
			clone.commit().setMessage("Elsewhere").setAuthor(someone).setCommitter(someone).call();
			clone.push().call();
		}
		String foreign = remoteHead();
		assertThat(foreign).isNotEqualTo(first);

		commit("b.md");
		long before = mirrorEvents();
		mirror.tick();
		advance(Duration.ofMinutes(10));
		mirror.tick();
		MirrorStatus status = mirror.status();
		assertThat(status.state()).isEqualTo(MirrorState.DIVERGED);
		assertThat(status.lastError()).contains("not in the vault's history");
		assertThat(status.failingSince()).isNotNull();
		assertThat(status.nextPushAt()).isNull();
		assertThat(remoteHead()).isEqualTo(foreign);
		assertThat(mirrorEvents()).isEqualTo(before + 1);

		// Pushing has stopped: new commits and time change nothing.
		commit("c.md");
		mirror.tick();
		advance(Duration.ofHours(3));
		mirror.tick();
		assertThat(remoteHead()).isEqualTo(foreign);
		assertThat(mirrorEvents()).isEqualTo(before + 1);

		// A requested push tries again, and reports again.
		mirror.requestPush();
		mirror.tick();
		assertThat(mirror.status().state()).isEqualTo(MirrorState.DIVERGED);
		assertThat(remoteHead()).isEqualTo(foreign);
		assertThat(mirrorEvents()).isEqualTo(before + 2);

		// Once the mirror is fixed (here: its branch reset to a commit the vault has), a requested push resumes.
		try (Repository remote = new FileRepositoryBuilder().setGitDir(this.bare.toFile()).build()) {
			RefUpdate reset = remote.updateRef("refs/heads/main");
			reset.setNewObjectId(ObjectId.fromString(first));
			reset.setForceUpdate(true);
			assertThat(reset.update()).isEqualTo(RefUpdate.Result.FORCED);
		}
		mirror.requestPush();
		mirror.tick();
		status = mirror.status();
		assertThat(status.state()).isEqualTo(MirrorState.READY);
		assertThat(status.lastError()).isNull();
		assertThat(status.failingSince()).isNull();
		assertThat(remoteHead()).isEqualTo(this.vault.git.head());
	}

	@Test
	void failuresAreRetriedWithBackoffAndRecover() throws Exception {
		Path missing = this.remotes.resolve("later.git");
		GitMirror mirror = mirror(missing.toUri().toString());
		commit("a.md");
		mirror.requestPush();
		mirror.tick();
		MirrorStatus failing = mirror.status();
		assertThat(failing.state()).isEqualTo(MirrorState.FAILING);
		assertThat(failing.lastError()).isNotBlank();
		assertThat(failing.failingSince()).isEqualTo(this.vault.clock.instant());
		assertThat(failing.nextPushAt()).isEqualTo(this.vault.clock.instant().plus(Duration.ofMinutes(1)));
		assertThat(mirrorEvents()).isEqualTo(1);

		// The backoff grows: 1, 5, 15, then every 30 minutes.
		for (Duration step : new Duration[] { Duration.ofMinutes(1), Duration.ofMinutes(5), Duration.ofMinutes(15),
				Duration.ofMinutes(30) }) {
			advance(step);
			mirror.tick();
		}
		assertThat(mirror.status().nextPushAt()).isEqualTo(this.vault.clock.instant().plus(Duration.ofMinutes(30)));
		assertThat(mirrorEvents()).as("one event per failure streak").isEqualTo(1);

		// The remote appears; nothing is retried before the backoff ends, then the push works.
		Git.init().setBare(true).setDirectory(missing.toFile()).setInitialBranch("main").call().close();
		advance(Duration.ofMinutes(29));
		mirror.tick();
		assertThat(mirror.status().state()).isEqualTo(MirrorState.FAILING);
		advance(Duration.ofMinutes(1));
		mirror.tick();
		MirrorStatus recovered = mirror.status();
		assertThat(recovered.state()).isEqualTo(MirrorState.READY);
		assertThat(recovered.lastError()).isNull();
		assertThat(recovered.pushedCommit()).isEqualTo(this.vault.git.head());
		assertThat(mirrorEvents()).isEqualTo(2);
	}

	@Test
	void theTokenNeverAppearsInTheStatusOrTheLogs(CapturedOutput output) throws Exception {
		Path token = this.remotes.resolve("mirror_token");
		Files.writeString(token, "github_pat_s3cr3tT0kenValue\n");
		// Nothing listens on port 1: the push fails at once, after the token has been read.
		GitMirror mirror = mirror("https://127.0.0.1:1/me/vault.git", "notes.mirror.token-file", token.toString(),
				"notes.mirror.timeout", "5s");
		commit("a.md");
		mirror.requestPush();
		mirror.tick();
		MirrorStatus status = mirror.status();
		assertThat(status.state()).isEqualTo(MirrorState.FAILING);
		assertThat(status.lastError()).isNotBlank().doesNotContain("s3cr3t");
		assertThat(status.remote()).isEqualTo("https://127.0.0.1:1/me/vault.git");
		assertThat(output.getAll()).contains("GIT_MIRROR_FAILED").doesNotContain("s3cr3t");
	}

	@Test
	void aMissingOrEmptyTokenFileIsReportedAsAFailure() throws Exception {
		Path token = this.remotes.resolve("absent_token");
		GitMirror mirror = mirror("https://github.com/me/vault.git", "notes.mirror.token-file", token.toString());
		commit("a.md");
		mirror.requestPush();
		mirror.tick();
		assertThat(mirror.status().lastError()).startsWith("cannot read the token file");
		Files.writeString(token, "  \n");
		mirror.requestPush();
		mirror.tick();
		assertThat(mirror.status().lastError()).endsWith("is empty");
	}

	@Test
	void errorTextsAreScrubbed() {
		assertThat(GitMirror.sanitize("https://x:abc123@github.com/me/v.git: not authorized (abc123)", "abc123"))
			.isEqualTo("https://github.com/me/v.git: not authorized (***)");
		assertThat(GitMirror.sanitize("  ", null)).isEqualTo("unknown error");
		assertThat(GitMirror.sanitize("e".repeat(400), null)).hasSize(300).endsWith("…");
		assertThat(GitMirror.redact("https://user@host/x")).isEqualTo("https://host/x");
	}

}
