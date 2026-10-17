package com.rjgehan.notes.tasks;

import java.util.ArrayList;
import java.util.List;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.index.LinkTextGenerator;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Component;

/**
 * Indexes {@code .tasks} files for search, backlinks and tags (ROADMAP item 4): the list's name is a heading, and each
 * usable task contributes its title, its tags and related notes, and its notes, as separate blocks. A {@code [[Note]]}
 * or {@code #tag} written in a title therefore counts like one in a note, every path in {@code links} is a link to
 * that file, and every entry of {@code tags} is a tag. Malformed files are not content-indexed.
 */
@Component
public class TaskDocumentIndexer implements DocumentIndexer {

	private final JsonMapper mapper;

	public TaskDocumentIndexer(JsonMapper mapper) {
		this.mapper = mapper;
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

	private static String oneLine(String text) {
		return text.replace('\r', ' ').replace('\n', ' ');
	}

}
