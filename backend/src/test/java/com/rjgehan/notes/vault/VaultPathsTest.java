package com.rjgehan.notes.vault;

import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.IndexedFile;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class VaultPathsTest {

	@TempDir
	Path vault;

	private VaultIndex index;

	private VaultFs fs;

	private VaultPaths paths;

	@BeforeEach
	void setUp() {
		this.index = new VaultIndex();
		this.fs = new VaultFs(TestProperties.forVault(this.vault));
		this.paths = new VaultPaths(this.index, this.fs, false);
	}

	private static ErrorCode codeOf(Runnable action) {
		try {
			action.run();
		}
		catch (NotesException ex) {
			return ex.code();
		}
		throw new AssertionError("expected a NotesException");
	}

	@ParameterizedTest
	@ValueSource(strings = { "../x", "a/../../x", "/abs", "a//b", "a/", "a\\b", "a/./b", "", "  ", "tab\there",
			"nul\u0000x", "del\u007fx" })
	void rejectsUnsafePaths(String path) {
		for (Mode mode : Mode.values()) {
			assertThat(codeOf(() -> this.paths.resolve(path, mode))).as(path).isEqualTo(ErrorCode.INVALID_PATH);
		}
	}

	@ParameterizedTest
	@ValueSource(strings = { ".git/config", ".notesapp/settings.json", ".trash/x", "a/.hidden/b", ".obsidian/app.json" })
	void rejectsReservedPaths(String path) {
		for (Mode mode : Mode.values()) {
			assertThat(codeOf(() -> this.paths.resolve(path, mode))).as(path).isEqualTo(ErrorCode.RESERVED_PATH);
		}
	}

	@Test
	void normalizesNfdInputToNfc() {
		String nfd = Normalizer.normalize("Café/Résumé.md", Normalizer.Form.NFD);
		assertThat(nfd).isNotEqualTo("Café/Résumé.md");
		assertThat(this.paths.resolve(nfd, Mode.NEW).nfc()).isEqualTo("Café/Résumé.md");
		assertThat(this.paths.resolve(nfd, Mode.EXISTING).nfc()).isEqualTo("Café/Résumé.md");
	}

	@Test
	void enforcesLengthLimits() {
		String longPath = "a/".repeat(512) + "x";
		assertThat(longPath.length()).isGreaterThan(1024);
		assertThat(codeOf(() -> this.paths.resolve(longPath, Mode.EXISTING))).isEqualTo(ErrorCode.INVALID_PATH);
		assertThat(codeOf(() -> this.paths.resolve("b".repeat(256), Mode.EXISTING))).isEqualTo(ErrorCode.INVALID_PATH);
		// A 250-byte segment exists legally on disk but is too long to be introduced by the app.
		String name250 = "c".repeat(247) + ".md";
		assertThat(this.paths.resolve(name250, Mode.EXISTING).nfc()).isEqualTo(name250);
		assertThat(codeOf(() -> this.paths.resolve(name250, Mode.NEW))).isEqualTo(ErrorCode.INVALID_NAME);
	}

	@EnabledOnOs({ OS.LINUX, OS.MAC })
	@ParameterizedTest
	@ValueSource(strings = { "Meeting 10:30.md", "What?.md", "con.md", "LPT1.txt", "a:b", "trailing.", "trailing ",
			"x.tmp" })
	void portabilityRulesApplyOnlyToNewNamesOnLinux(String name) {
		assertThat(this.paths.resolve(name, Mode.EXISTING).nfc()).isEqualTo(name);
		assertThat(codeOf(() -> this.paths.resolve(name, Mode.NEW))).isEqualTo(ErrorCode.INVALID_NAME);
	}

	@ParameterizedTest
	@ValueSource(strings = { "Meeting 10:30.md", "What?.md", "con.md", "LPT1.txt", "a:b", "trailing.", "trailing " })
	void windowsRulesApplyInBothModesOnWindows(String name) {
		VaultPaths windows = new VaultPaths(this.index, this.fs, true);
		for (Mode mode : Mode.values()) {
			assertThat(codeOf(() -> windows.resolve(name, mode))).as(name).isEqualTo(ErrorCode.INVALID_NAME);
		}
	}

	@EnabledOnOs(OS.WINDOWS)
	@Test
	void windowsHostEnablesWindowsRules() {
		assertThat(VaultPaths.isWindows()).isTrue();
		VaultPaths host = new VaultPaths(this.index, this.fs);
		assertThat(codeOf(() -> host.resolve("What?.md", Mode.EXISTING))).isEqualTo(ErrorCode.INVALID_NAME);
	}

	@ParameterizedTest
	@ValueSource(strings = { "Plan #2.md", "a[b].md", "x^y.md", "p%%q.md" })
	void linkBreakingCharactersAreAllowedForExistingNames(String name) {
		assertThat(this.paths.resolve(name, Mode.EXISTING).nfc()).isEqualTo(name);
		assertThat(codeOf(() -> this.paths.resolve(name, Mode.NEW))).isEqualTo(ErrorCode.INVALID_NAME);
	}

	@Test
	void newFolderSegmentsMustBeValidNewNames() {
		assertThat(codeOf(() -> this.paths.resolve("Bad#folder/x.md", Mode.NEW))).isEqualTo(ErrorCode.INVALID_NAME);
	}

	@Test
	void implicitParentsResolveCaseInsensitively() {
		this.index.addFolder("Daily", "Daily");
		ApiPath path = this.paths.resolve("daily/2026-10-16.md", Mode.NEW);
		assertThat(path.nfc()).isEqualTo("Daily/2026-10-16.md");
		assertThat(path.disk()).isEqualTo("Daily/2026-10-16.md");
	}

	@Test
	void existingPathsUseTheIndexedOnDiskName() {
		String nfd = Normalizer.normalize("Café.md", Normalizer.Form.NFD);
		this.index.put(new IndexedFile(new FileRecord("Café.md", FileKind.NOTE, 0, Instant.EPOCH, null, List.of()),
				nfd, null, null));
		ApiPath path = this.paths.resolve("Café.md", Mode.EXISTING);
		assertThat(path.nfc()).isEqualTo("Café.md");
		assertThat(path.disk()).isEqualTo(nfd);
	}

	@EnabledOnOs(OS.LINUX)
	@ParameterizedTest
	@EnumSource(Mode.class)
	void rejectsSymlinksInsideTheVault(Mode mode) throws Exception {
		Path outside = Files.createTempDirectory("outside");
		Files.createSymbolicLink(this.vault.resolve("link"), outside);
		assertThat(codeOf(() -> this.paths.resolve("link/x.md", mode))).isEqualTo(ErrorCode.INVALID_PATH);
		Files.writeString(outside.resolve("target.md"), "secret");
		Files.createSymbolicLink(this.vault.resolve("file.md"), outside.resolve("target.md"));
		assertThatThrownBy(() -> this.paths.resolve("file.md", mode)).isInstanceOf(NotesException.class);
	}

	@EnabledOnOs(OS.LINUX)
	@Test
	void readsReportASymlinkedFileAsMissing() throws Exception {
		Path outside = Files.createTempDirectory("outside");
		Files.writeString(outside.resolve("target.md"), "secret");
		Files.createSymbolicLink(this.vault.resolve("file.md"), outside.resolve("target.md"));
		Files.createSymbolicLink(this.vault.resolve("link"), outside);
		assertThat(codeOf(() -> this.paths.resolveForRead("file.md"))).isEqualTo(ErrorCode.NOT_FOUND);
		assertThat(codeOf(() -> this.paths.resolveForRead("link/target.md"))).isEqualTo(ErrorCode.INVALID_PATH);
		assertThat(codeOf(() -> this.paths.resolve("file.md", Mode.EXISTING))).isEqualTo(ErrorCode.INVALID_PATH);
	}

}
