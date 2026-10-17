package com.rjgehan.notes.history;

import java.io.IOException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Nightly {@code autoGC} (DESIGN §5.8); JGit never gcs on commit by itself. */
@Component
public class GitHousekeeping {

	private static final Logger logger = LoggerFactory.getLogger(GitHousekeeping.class);

	private final GitStore git;

	public GitHousekeeping(GitStore git) {
		this.git = git;
	}

	@Scheduled(cron = "${notes.git.gc-cron:0 30 3 * * *}")
	public void gc() {
		try {
			this.git.gc();
		}
		catch (IOException | RuntimeException ex) {
			logger.warn("Git gc failed: {}", ex.toString());
		}
	}

}
