package com.rjgehan.notes;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.RunningApp;
import com.rjgehan.notes.support.SseRecorder;
import com.rjgehan.notes.watch.VaultReconciler;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The performance targets of DESIGN §5.19 on a generated vault of 10,000 notes and about 50 MB of Markdown, with links
 * and tags, asserted with a 3× margin for CI hardware. Excluded from the default build; run it with
 * {@code ./mvnw test -Dtest=VaultPerformanceTest -DexcludedGroups=}.
 */
@Tag("perf")
class VaultPerformanceTest {

	private static final int NOTES = 10_000;

	private static final int FOLDERS = 100;

	private static final int MARGIN = 3;

	private static final String[] WORDS = ("garden river lantern orbit meadow copper signal harbor velvet thunder "
			+ "compass ember fable glacier hollow island juniper kettle ledger marble nectar oasis pepper quartz "
			+ "ribbon saffron timber umbra vessel willow yonder zephyr anchor beacon cobalt drift echo falcon granite")
		.split(" ");

	@TempDir
	Path vault;

	private static String noteName(int i) {
		return "Note " + i;
	}

	private static String notePath(int i) {
		return "Area " + (i % FOLDERS) + "/" + noteName(i) + ".md";
	}

	/** About 5 KB per note: frontmatter, headings, prose, five links and tags; 200 notes link to the hub. */
	private void generate() throws IOException {
		Random random = new Random(42);
		for (int f = 0; f < FOLDERS; f++) {
			Files.createDirectories(this.vault.resolve("Area " + f));
		}
		Files.writeString(this.vault.resolve("Hub.md"), "# Hub\n\nEverything starts here.\n");
		Files.writeString(this.vault.resolve("Quantum Ledger.md"), "# Quantum Ledger\n");
		for (int i = 0; i < NOTES; i++) {
			StringBuilder text = new StringBuilder(5200);
			text.append("---\ntags: [area").append(i % FOLDERS).append(", perf]\naliases: [N").append(i)
				.append("]\n---\n# ").append(noteName(i)).append("\n\n");
			for (int section = 0; section < 4; section++) {
				text.append("## Section ").append(section).append("\n\n");
				for (int line = 0; line < 4; line++) {
					for (int w = 0; w < 12; w++) {
						text.append(WORDS[random.nextInt(WORDS.length)]).append(' ');
					}
					if (line == 1) {
						text.append("[[").append(noteName(random.nextInt(NOTES))).append("]] ");
					}
					if (line == 2) {
						text.append("#topic/").append(WORDS[random.nextInt(WORDS.length)]).append(' ');
					}
					text.append("Quantum").append(' ');
					text.append(WORDS[random.nextInt(WORDS.length)]).append(".\n");
				}
				text.append('\n');
			}
			if (i < 200) {
				text.append("Back to [[Hub]].\n");
			}
			if (i < 300) {
				text.append("We discussed the quantum ledger again.\n");
			}
			while (text.length() < 5000) {
				text.append(WORDS[random.nextInt(WORDS.length)]).append(' ');
			}
			text.append('\n');
			Files.writeString(this.vault.resolve(notePath(i)), text, StandardCharsets.UTF_8);
		}
	}

	private static long millis(Runnable action) {
		long start = System.nanoTime();
		action.run();
		return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
	}

	private static long p95(List<Long> samples) {
		List<Long> sorted = samples.stream().sorted().toList();
		return sorted.get((int) Math.ceil(sorted.size() * 0.95) - 1);
	}

	private static long median(List<Long> samples) {
		List<Long> sorted = samples.stream().sorted().toList();
		return sorted.get(sorted.size() / 2);
	}

	private static List<Long> sample(int warmup, int runs, Runnable action) {
		for (int i = 0; i < warmup; i++) {
			action.run();
		}
		List<Long> samples = new ArrayList<>();
		for (int i = 0; i < runs; i++) {
			samples.add(millis(action));
		}
		return samples;
	}

	@Test
	void meetsTheTargetsOnTenThousandNotes() throws Exception {
		generate();
		long started = System.nanoTime();
		try (RunningApp app = RunningApp.start(this.vault, Map.of("notes.welcome-note", "false"))) {
			long coldStart = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
			report("cold start to ready", coldStart, 10_000);
			Api api = app.api();
			app.awaitGitBootstrap();

			JsonNode status = api.get("/api/status").ok(200);
			assertThat(status.get("vault").get("notes").asInt()).isEqualTo(NOTES + 2);
			assertThat(status.get("vault").get("bytes").asLong()).isGreaterThan(45L * 1024 * 1024);

			report("GET /api/tree (median)", median(sample(3, 9, () -> api.get("/api/tree").ok(200))), 150);

			// The graph view (ROADMAP item 16): the whole graph, and the "nothing changed" answer of a refresh.
			JsonNode graph = api.get("/api/graph").ok(200);
			assertThat(graph.get("nodes").size()).isGreaterThan(NOTES);
			report("GET /api/graph (median)", median(sample(3, 9, () -> api.get("/api/graph").ok(200))), 150);
			String graphVersion = graph.get("version").asString();
			report("GET /api/graph?since= unchanged (median)",
					median(sample(3, 9, () -> api.get("/api/graph?since=" + Api.enc(graphVersion)).ok(200))), 10);

			String path = notePath(4242);
			String[] version = { api.get("/api/files?path=" + Api.enc(path)).ok(200).get("version").asString() };
			int[] n = { 0 };
			Supplier<String> edit = () -> "# Edited\n\nRevision " + (n[0]++) + "\n";
			List<Long> saves = sample(5, 60, () -> version[0] = api
				.putJson("/api/files?path=" + Api.enc(path), Map.of("content", edit.get(), "baseVersion", version[0]))
				.ok(200)
				.get("file")
				.get("version")
				.asString());
			report("save p95", p95(saves), 30);

			String[] queries = { "garden river", "\"copper signal\"", "lantern -orbit", "tag:topic/ember", "harb",
					"path:area 7 quartz", "zephyr anchor beacon", "file:note 99", "velvet", "tag:perf glacier",
					// item 22: OR and groups, typo tolerance, scopes, and a regular expression narrowed by words
					"garden OR river", "(velvet OR thunder) -compass", "lanturn", "line:(garden river)",
					"section:(\"copper signal\" ember)", "quartz /quart[sz] ledg/", "file:/^Note 42\\d\\d\\.md$/" };
			List<Long> searches = new ArrayList<>();
			for (String query : queries) {
				List<Long> times = sample(2, 6, () -> api.get("/api/search?q=" + Api.enc(query)).ok(200));
				System.out.printf("PERF   search %-30s median %4d ms, total %d%n", query, median(times),
						api.get("/api/search?q=" + Api.enc(query)).ok(200).get("total").asInt());
				searches.addAll(times);
			}
			report("search p95", p95(searches), 100);

			// A regular expression alone reads every note (about 50 MB): bounded, not instant.
			List<Long> scans = sample(1, 5, () -> api.get("/api/search?q=" + Api.enc("/quantum l[e]dger/")).ok(200));
			System.out.printf("PERF   search %-30s median %4d ms, total %d%n", "/quantum l[e]dger/", median(scans),
					api.get("/api/search?q=" + Api.enc("/quantum l[e]dger/")).ok(200).get("total").asInt());
			report("full-text regular expression (median)", median(scans), 1_000);

			JsonNode hub = api.get("/api/notes/backlinks?path=Hub.md").ok(200);
			assertThat(hub.get("linked").size()).isEqualTo(200);
			report("backlinks, linked (median)",
					median(sample(3, 9, () -> api.get("/api/notes/backlinks?path=Hub.md").ok(200))), 20);

			JsonNode mentions = api.get("/api/notes/backlinks?unlinked=true&path=" + Api.enc("Quantum Ledger.md"))
				.ok(200);
			assertThat(mentions.get("unlinked").size()).isEqualTo(200);
			report("unlinked mentions (median)", median(sample(1, 5,
					() -> api.get("/api/notes/backlinks?unlinked=true&path=" + Api.enc("Quantum Ledger.md")).ok(200))),
					300);

			JsonNode[] moved = new JsonNode[1];
			long rename = millis(() -> moved[0] = api.postJson("/api/move", Map.of("from", "Hub.md", "to", "Hub 2.md"))
				.ok(200));
			assertThat(moved[0].get("linkUpdates").size()).isEqualTo(200);
			report("rename touching 200 notes", rename, 2_000);

			List<SseRecorder> streams = new ArrayList<>();
			try {
				for (int i = 0; i < 5; i++) {
					streams.add(SseRecorder.open(app.port(), "perf-listener-" + i, null));
				}
				List<Long> fanOuts = new ArrayList<>();
				for (int round = 0; round < 10; round++) {
					long sent = System.nanoTime();
					version[0] = api.putJson("/api/files?path=" + Api.enc(path),
							Map.of("content", edit.get(), "baseVersion", version[0]))
						.ok(200)
						.get("file")
						.get("version")
						.asString();
					String expected = version[0];
					long last = 0;
					for (SseRecorder stream : streams) {
						SseRecorder.Frame frame = awaitChange(stream, expected);
						last = Math.max(last, frame.receivedNanos());
					}
					fanOuts.add(TimeUnit.NANOSECONDS.toMillis(last - sent));
				}
				report("save to SSE fan-out to 5 clients (median)", median(fanOuts), 50);
			}
			finally {
				streams.forEach(SseRecorder::close);
			}

			VaultReconciler reconciler = app.bean(VaultReconciler.class);
			reconciler.fullRescan(false);
			report("rescan of an unchanged vault (median)", median(sample(0, 3, () -> reconciler.fullRescan(false))), 2_000);

			System.gc();
			Thread.sleep(500);
			System.gc();
			Runtime runtime = Runtime.getRuntime();
			long heapMb = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024);
			report("heap in steady state (MB)", heapMb, 400);
		}
	}

	private static SseRecorder.Frame awaitChange(SseRecorder stream, String version) throws InterruptedException {
		long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
		while (System.nanoTime() < deadline) {
			for (SseRecorder.Frame frame : stream.frames()) {
				if (frame.event().equals("file.changed") && frame.data().get("file").get("version").asString().equals(version)) {
					return frame;
				}
			}
			Thread.sleep(1);
		}
		throw new AssertionError("no file.changed for " + version);
	}

	private static void report(String what, long measured, long target) {
		System.out.printf("PERF %-45s %6d (target %d, limit %d)%n", what, measured, target, target * MARGIN);
		assertThat(measured).as("%s (target %d)", what, target).isLessThanOrEqualTo(target * MARGIN);
	}

}
