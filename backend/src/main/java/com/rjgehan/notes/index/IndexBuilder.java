package com.rjgehan.notes.index;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.vault.VaultFs;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Component;

/**
 * The startup walk (DESIGN §5.17 step 6): walks the vault, reads, hashes and parses text files in parallel on a fixed
 * pool sized to the CPU count, then swaps the result into the {@link VaultIndex}.
 */
@Component
public class IndexBuilder {

	private static final Logger logger = LoggerFactory.getLogger(IndexBuilder.class);

	/** Duration and counts of the last build. */
	public record BuildStats(Duration duration, int folders, int files, int notes, int skipped) {
	}

	private final VaultFs fs;

	private final FileIndexer indexer;

	private final VaultIndex index;

	private volatile BuildStats lastBuild = new BuildStats(Duration.ZERO, 0, 0, 0, 0);

	public IndexBuilder(VaultFs fs, FileIndexer indexer, VaultIndex index) {
		this.fs = fs;
		this.indexer = indexer;
		this.index = index;
	}

	public BuildStats build() throws IOException {
		long started = System.nanoTime();
		VaultWalk.Result walk = VaultWalk.walk(this.fs, "", "");
		List<IndexedFile> files = new ArrayList<>(walk.files().size());
		int threads = Math.max(1, Runtime.getRuntime().availableProcessors());
		ExecutorService pool = Executors.newFixedThreadPool(threads);
		try {
			List<Future<IndexedFile>> futures = new ArrayList<>(walk.files().size());
			for (VaultWalk.FoundFile found : walk.files()) {
				futures.add(pool.submit(() -> this.indexer.load(found.path(), found.disk())));
			}
			for (int i = 0; i < futures.size(); i++) {
				try {
					files.add(futures.get(i).get());
				}
				catch (ExecutionException ex) {
					logger.warn("Cannot index {}: {}", walk.files().get(i).disk(), ex.getCause().toString());
				}
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw new IOException("Interrupted while indexing the vault", ex);
		}
		finally {
			pool.shutdownNow();
		}
		this.index.replaceAll(walk.folders(), files, walk.skipped());
		int notes = (int) files.stream().filter((f) -> f.parse() != null && f.record().kind() == FileKind.NOTE).count();
		BuildStats stats = new BuildStats(Duration.ofNanos(System.nanoTime() - started), walk.folders().size(),
				files.size(), notes, walk.skipped().size());
		this.lastBuild = stats;
		logger.info("Indexed {} files ({} notes) in {} folders in {} ms; {} skipped", stats.files(), stats.notes(),
				stats.folders(), stats.duration().toMillis(), stats.skipped());
		return stats;
	}

	public BuildStats lastBuild() {
		return this.lastBuild;
	}

}
