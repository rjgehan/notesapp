package com.rjgehan.notes.vault;

import java.io.IOException;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.StatusChangedEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Watches the free space on the vault's filesystem and publishes {@code status.changed} whenever it crosses
 * {@code notes.limits.min-free-space} (1 GiB) in either direction, logging {@code STORAGE_LOW} when it drops below.
 */
@Component
public class DiskSpaceMonitor {

	private static final Logger logger = LoggerFactory.getLogger(DiskSpaceMonitor.class);

	private final VaultFs fs;

	private final EventHub hub;

	private final long minFreeSpace;

	private volatile boolean low;

	public DiskSpaceMonitor(VaultFs fs, EventHub hub, NotesProperties properties) {
		this.fs = fs;
		this.hub = hub;
		this.minFreeSpace = properties.limits().minFreeSpace().toBytes();
	}

	@Scheduled(fixedDelayString = "30s", initialDelayString = "10s")
	public void check() {
		long free;
		try {
			free = this.fs.usableSpace();
		}
		catch (IOException ex) {
			logger.debug("Cannot read the free space of the vault's filesystem: {}", ex.toString());
			return;
		}
		boolean nowLow = free < this.minFreeSpace;
		if (nowLow == this.low) {
			return;
		}
		this.low = nowLow;
		if (nowLow) {
			logger.error("STORAGE_LOW only {} bytes are free on the vault's filesystem (minimum {}); uploads are refused",
					free, this.minFreeSpace);
		}
		else {
			logger.info("Free space on the vault's filesystem is back above {} bytes", this.minFreeSpace);
		}
		this.hub.publish(new StatusChangedEvent(StatusChangedEvent.Reason.DISK));
	}

	public boolean isLow() {
		return this.low;
	}

}
