package com.rjgehan.notes.vault;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Path;

import com.rjgehan.notes.api.dto.AttachmentResult;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;

/** Attachment folder choice, name sanitizing and de-duplication, and the returned embed (API.md §9.3). */
class AttachmentServiceTest {

	@TempDir
	Path dir;

	private TestVault vault;

	@BeforeEach
	void setUp() throws IOException {
		this.vault = TestVault.start(this.dir);
		this.vault.settings.load();
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private AttachmentResult upload(String name, String source) throws IOException {
		byte[] bytes = { 1, 2, 3 };
		return this.vault.attachments.upload(name, source, new ByteArrayInputStream(bytes), bytes.length,
				TestVault.ALICE, "client-a1");
	}

	private void setFiles(String field, Object value) throws IOException {
		ObjectNode tree = TestVault.JSON.valueToTree(this.vault.settings.current());
		((ObjectNode) tree.get("files")).set(field, TestVault.JSON.valueToTree(value));
		this.vault.settings.update(tree, this.vault.settings.get().version(), TestVault.ALICE, "client-a1");
	}

	@Test
	void defaultsToTheAttachmentsFolderWithAWikiEmbed() throws Exception {
		AttachmentResult result = upload("Pasted image 20261016140322.png", "Daily/2026-10-16.md");
		assertThat(result.file().path()).isEqualTo("Attachments/Pasted image 20261016140322.png");
		assertThat(result.created()).isTrue();
		assertThat(result.createdFolders()).containsExactly("Attachments");
		assertThat(result.linkText()).isEqualTo("Pasted image 20261016140322.png");
		assertThat(result.markdown()).isEqualTo("![[Pasted image 20261016140322.png]]");
	}

	@Test
	void namesAreSanitizedAndDeDuplicatedIgnoringCase() throws Exception {
		assertThat(upload("../a:b?.png", null).file().path()).isEqualTo("Attachments/a-b-.png");
		assertThat(upload("A-B-.PNG", null).file().path()).isEqualTo("Attachments/A-B- 1.PNG");
		assertThat(upload("a-b-.png", null).file().path()).isEqualTo("Attachments/a-b- 2.png");
	}

	@Test
	void anExistingFolderThatDiffersByCaseIsReused() throws Exception {
		this.vault.folders.create("attachments", TestVault.ALICE, "client-a1");
		AttachmentResult result = upload("x.png", null);
		assertThat(result.file().path()).isEqualTo("attachments/x.png");
		assertThat(result.createdFolders()).isEmpty();
	}

	@Test
	void theLocationFollowsTheSettings() throws Exception {
		this.vault.files.createText("Projects/Plan.md", "", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		setFiles("attachmentLocation", "current");
		assertThat(upload("c.png", "Projects/Plan.md").file().path()).isEqualTo("Projects/c.png");
		setFiles("attachmentLocation", "subfolder");
		assertThat(upload("s.png", "Projects/Plan.md").file().path()).isEqualTo("Projects/attachments/s.png");
		setFiles("attachmentLocation", "root");
		assertThat(upload("r.png", "Projects/Plan.md").file().path()).isEqualTo("r.png");
		setFiles("attachmentLocation", "subfolder");
		assertThat(upload("n.png", null).file().path()).isEqualTo("attachments/n.png");
	}

	@Test
	void markdownStyleEmbedsArePercentEncoded() throws Exception {
		setFiles("useWikilinks", false);
		AttachmentResult result = upload("Pasted image 1.png", "Notes/Day.md");
		assertThat(result.linkText()).isEqualTo("Pasted image 1.png");
		assertThat(result.markdown()).isEqualTo("![](Pasted%20image%201.png)");
		assertThat(this.vault.settings.current()).isNotEqualTo(Settings.defaults());
	}

}
