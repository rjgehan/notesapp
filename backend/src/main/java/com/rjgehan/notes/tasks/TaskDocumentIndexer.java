package com.rjgehan.notes.tasks;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.config.JsonConfig;
import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.index.LinkTextGenerator;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectWriter;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Component;

/**
 * Indexes {@code .tasks} files for search, backlinks and tags (ROADMAP item 4): the list's name is a heading, and each
 * usable task contributes its title, its tags and related notes, and its notes, as separate blocks. A {@code [[Note]]}
 * or {@code #tag} written in a title therefore counts like one in a note, every path in {@code links} is a link to
 * that file, and every entry of {@code tags} is a tag. Malformed files are not content-indexed.
 * <p>
 * When a note moves, the move rewrites those links here as it does in notes ({@link #rewriteLinks}): the {@code [[links]]}
 * and Markdown links of titles and notes as a note's, and each path in {@code links} to where its file went.
 */
@Component
public class TaskDocumentIndexer implements DocumentIndexer {

	private final JsonMapper mapper;

	private final ObjectWriter writer;

	private final Clock clock;

	public TaskDocumentIndexer(JsonMapper mapper, Clock clock) {
		this.mapper = mapper;
		this.writer = JsonConfig.vaultFileWriter(mapper);
		this.clock = clock;
	}

	@Override
	public boolean supports(String path) {
		return TaskStore.isTaskFile(path);
	}

	@Override
	public @Nullable Document index(String path, String text) {
		TaskFile file;
		try {
			file = TaskFile.parse(text, false, this.mapper);
		}
		catch (TaskFile.MalformedException ex) {
			return null;
		}
		List<String> blocks = new ArrayList<>();
		blocks.add("# " + oneLine(file.listName()));
		for (ObjectNode node : file.tasks()) {
			Task task = TaskCodec.readTask(node, file.listId(), file.isArchive()).task();
			if (task == null) {
				continue;
			}
			blocks.add(oneLine(task.title()));
			StringBuilder related = new StringBuilder();
			for (String tag : task.tags()) {
				related.append('#').append(tag).append(' ');
			}
			for (String link : task.links()) {
				// A Markdown link with a forced-absolute, percent-encoded destination resolves to exactly this path,
				// whatever characters its name has.
				String label = PathNames.basenameOf(PathNames.nameOf(link)).replaceAll("[\\[\\]\\n]", " ");
				related.append('[')
					.append(label)
					.append("](/")
					.append(LinkTextGenerator.encodeMdPath(link))
					.append(") ");
			}
			if (!related.isEmpty()) {
				blocks.add(related.toString().strip());
			}
			if (task.notes() != null && !task.notes().isBlank()) {
				blocks.add(task.notes());
			}
		}
		return new Document(List.copyOf(blocks));
	}

	/**
	 * The file with the links in its tasks rewritten after a move; the tasks that changed get a new {@code updatedAt}.
	 * A file the task API would not write (malformed, or from a newer version), or a title or notes that the rewrite
	 * would make invalid, is not rewritten.
	 */
	@Override
	public @Nullable Rewritten rewriteLinks(String path, String text, LinkRewriter links) {
		TaskFile file;
		try {
			file = TaskFile.parse(text, false, this.mapper);
		}
		catch (TaskFile.MalformedException ex) {
			return null;
		}
		if (file.formatVersion() > TaskFile.FORMAT_VERSION) {
			return null;
		}
		String now = this.clock.instant().truncatedTo(ChronoUnit.MILLIS).toString();
		int count = 0;
		for (ObjectNode node : file.tasks()) {
			int before = count;
			for (String field : List.of("title", "notes")) {
				JsonNode value = node.get(field);
				if (value == null || !value.isString()) {
					continue;
				}
				Rewritten rewritten = links.markdown(value.stringValue());
				int limit = field.equals("title") ? TaskCodec.MAX_TITLE : TaskCodec.MAX_NOTES;
				if (rewritten == null || rewritten.text().length() > limit) {
					return null;
				}
				if (rewritten.links() > 0) {
					node.put(field, rewritten.text());
					count += rewritten.links();
				}
			}
			if (node.get("links") instanceof ArrayNode related) {
				for (int i = 0; i < related.size(); i++) {
					if (!related.get(i).isString()) {
						continue;
					}
					String old = related.get(i).stringValue();
					String moved = links.path(old);
					if (!moved.equals(old)) {
						related.set(i, moved);
						count++;
					}
				}
			}
			if (count > before) {
				node.put("updatedAt", now);
			}
		}
		if (count == 0) {
			return new Rewritten(text, 0);
		}
		return new Rewritten(new String(file.serialize(this.writer), StandardCharsets.UTF_8), count);
	}

	private static String oneLine(String text) {
		return text.replace('\r', ' ').replace('\n', ' ');
	}

}
