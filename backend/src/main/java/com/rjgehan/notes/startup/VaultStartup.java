package com.rjgehan.notes.startup;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.history.GitBootstrap;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.index.IndexBuilder;
import com.rjgehan.notes.index.VaultWalk;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.VaultFs;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * The ordered startup sequence (DESIGN §5.17), run synchronously before Tomcat starts listening, so the port stays
 * closed until the index is ready:
 * <ol>
 * <li>prepare the vault and empty {@code .notesapp/tmp};</li>
 * <li>outside the dev profile, the kernel-mode Tailscale and Host allowlist checks;</li>
 * <li>load the settings;</li>
 * <li>open or initialize the git repository;</li>
 * <li>write {@code Welcome.md} on a first run;</li>
 * <li>build the index, then write the large-file section of {@code info/exclude} from it.</li>
 * </ol>
 * The watcher and the commit batcher then start as lifecycle beans, and the git bootstrap commit runs after readiness.
 */
@Component
public class VaultStartup implements SmartInitializingSingleton {

	private static final Logger logger = LoggerFactory.getLogger(VaultStartup.class);

	private final NotesProperties properties;

	private final Environment environment;

	private final VaultFs fs;

	private final TailscaleInterfaceCheck tailscaleCheck;

	private final SettingsService settings;

	private final GitStore git;

	private final WelcomeContent welcome;

	private final IndexBuilder indexBuilder;

	private final GitBootstrap gitBootstrap;

	public VaultStartup(NotesProperties properties, Environment environment, VaultFs fs,
			TailscaleInterfaceCheck tailscaleCheck, SettingsService settings, GitStore git, WelcomeContent welcome,
			IndexBuilder indexBuilder, GitBootstrap gitBootstrap) {
		this.properties = properties;
		this.environment = environment;
		this.fs = fs;
		this.tailscaleCheck = tailscaleCheck;
		this.settings = settings;
		this.git = git;
		this.welcome = welcome;
		this.indexBuilder = indexBuilder;
		this.gitBootstrap = gitBootstrap;
	}

	@Override
	public void afterSingletonsInstantiated() {
		try {
			boolean emptyDirectory = prepareVault();
			checkDeployment();
			this.settings.load();
			this.git.openOrInit();
			boolean firstRun = isFirstRun(emptyDirectory);
			boolean noVisibleFiles = firstRun && VaultWalk.walk(this.fs, "", "").files().isEmpty();
			if (noVisibleFiles && this.properties.welcomeNote()) {
				writeWelcome();
			}
			this.indexBuilder.build();
			this.git.syncLargeFiles();
			this.gitBootstrap.setFreshVault(noVisibleFiles);
		}
		catch (IOException ex) {
			throw new UncheckedIOException("Cannot start on vault " + this.fs.root() + ": " + ex.getMessage(), ex);
		}
	}

	/**
	 * Step 1: the vault exists and is writable, and {@code .notesapp/tmp} is empty. Returns true when the vault folder
	 * had no entries at all before this step.
	 */
	private boolean prepareVault() throws IOException {
		Path root = this.fs.root();
		Files.createDirectories(root);
		if (!Files.isDirectory(root) || !Files.isWritable(root)) {
			throw new IOException("The vault directory is not a writable directory");
		}
		boolean empty;
		try (Stream<Path> entries = Files.list(root)) {
			empty = entries.findAny().isEmpty();
		}
		this.fs.prepareTmp();
		logger.info("Vault: {}", root);
		return empty;
	}

	/** Step 2: outside the dev profile, a kernel-mode Tailscale interface and a non-empty Host allowlist. */
	private void checkDeployment() {
		if (this.environment.matchesProfiles("dev")) {
			return;
		}
		this.tailscaleCheck.check();
		if (this.properties.allowedHosts().isEmpty()) {
			throw new IllegalStateException(
					"notes.allowed-hosts (NOTES_ALLOWED_HOSTS) must list the host names the app answers to");
		}
	}

	/**
	 * A first run has a repository created in this boot (or one without commits). With history disabled by
	 * configuration there is no repository to tell, so the vault folder having been empty decides. A user who later
	 * deletes everything therefore never gets the welcome note back.
	 */
	private boolean isFirstRun(boolean emptyDirectory) throws IOException {
		if (this.git.isDisabledByConfiguration()) {
			return emptyDirectory;
		}
		return this.git.createdThisBoot() || !this.git.hasCommits();
	}

	/** Step 5. */
	private void writeWelcome() throws IOException {
		try {
			this.fs.createExclusive(WelcomeContent.FILE_NAME, this.welcome.bytes());
			logger.info("Wrote {} for the first run", WelcomeContent.FILE_NAME);
		}
		catch (FileAlreadyExistsException ex) {
			logger.debug("{} already exists", WelcomeContent.FILE_NAME);
		}
	}

}
