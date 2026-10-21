package com.rjgehan.notes.ai;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A {@link ClaudeGateway} that makes no network call ({@code notes.ai.fake=true}): it streams a canned Markdown answer
 * that cites the notes the prompt carried, so the panel, the streaming, the citations and the spend guard can be tried
 * in development without an API key. Token counts are estimated at four characters per token.
 */
public class FakeGateway implements ClaudeGateway {

	private static final Pattern LINK = Pattern.compile("<note path=\"[^\"]*\" link=\"([^\"]*)\"");

	private final long delayMillis;

	public FakeGateway(long delayMillis) {
		this.delayMillis = delayMillis;
	}

	@Override
	public Result stream(Request request, Listener listener) throws ClaudeException {
		Message last = request.messages().get(request.messages().size() - 1);
		String prompt = last.blocks().stream().map(Block::text).reduce("", String::concat);
		Set<String> links = new LinkedHashSet<>();
		Matcher matcher = LINK.matcher(prompt);
		while (matcher.find()) {
			links.add(matcher.group(1).replace("&quot;", "\"").replace("&amp;", "&"));
		}
		StringBuilder answer = new StringBuilder();
		answer.append("*Fake answer: this server runs with `notes.ai.fake=true`, so nothing was sent to Anthropic.*\n\n");
		if (links.isEmpty()) {
			answer.append((request.messages().size() > 1)
					? "No new note came with this question; the ones sent earlier still apply.\n"
					: "None of your notes matched, so this answer cites nothing.\n");
		}
		else {
			answer.append("Here is what your notes say:\n\n");
			int n = 0;
			for (String link : links) {
				if (n++ == 8) {
					break;
				}
				answer.append("- Something relevant is in [[").append(link).append("]].\n");
			}
		}
		answer.append("\nThe conversation so far has ").append(request.messages().size()).append(" message")
			.append((request.messages().size() == 1) ? "" : "s").append(".");
		for (String piece : pieces(answer.toString())) {
			listener.onText(piece);
			pause();
		}
		int inputChars = request.system().length()
				+ request.messages().stream().mapToInt(Message::chars).sum();
		AiModels.Usage usage = new AiModels.Usage(inputChars / 4, answer.length() / 4, 0, 0);
		return new Result(request.model(), "end_turn", null, List.of(new Hop(request.model(), usage)), false);
	}

	/** The answer in word-sized pieces, as a stream delivers it. */
	private static List<String> pieces(String text) {
		List<String> pieces = new ArrayList<>();
		int start = 0;
		for (int i = 1; i <= text.length(); i++) {
			if (i == text.length() || text.charAt(i) == ' ' || text.charAt(i) == '\n') {
				pieces.add(text.substring(start, i));
				start = i;
			}
		}
		return pieces;
	}

	private void pause() {
		if (this.delayMillis <= 0) {
			return;
		}
		try {
			Thread.sleep(this.delayMillis);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
		}
	}

}
