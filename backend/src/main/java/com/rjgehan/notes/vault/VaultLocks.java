package com.rjgehan.notes.vault;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Deque;
import java.util.List;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

import com.rjgehan.notes.api.error.NotesException;

import org.springframework.stereotype.Component;

/**
 * The global fair vault lock and 256 striped per-path locks (DESIGN §5.4). Every acquisition is a {@code tryLock}
 * with a 5 s timeout that fails the request with {@code 503 busy}, so request threads never pile up behind a queued
 * writer. Order: vault lock, then path stripes in ascending index, each stripe at most once.
 */
@Component
public class VaultLocks {

	static final int STRIPES = 256;

	private final ReentrantReadWriteLock vault = new ReentrantReadWriteLock(true);

	private final ReentrantLock[] stripes = new ReentrantLock[STRIPES];

	private final long timeoutNanos;

	public VaultLocks() {
		this(Duration.ofSeconds(5));
	}

	public VaultLocks(Duration timeout) {
		for (int i = 0; i < STRIPES; i++) {
			this.stripes[i] = new ReentrantLock();
		}
		this.timeoutNanos = timeout.toNanos();
	}

	/** Releases everything it holds, in reverse order. */
	public interface Held extends AutoCloseable {

		@Override
		void close();

	}

	/** Vault read lock plus the stripes of the given NFC paths. */
	public Held read(String... paths) {
		return read(List.of(paths));
	}

	public Held read(Collection<String> paths) {
		return acquire(this.vault.readLock(), paths);
	}

	/** Vault write lock (structural operations). */
	public Held write() {
		return acquire(this.vault.writeLock(), List.of());
	}

	public boolean isWriteLockedByCurrentThread() {
		return this.vault.isWriteLockedByCurrentThread();
	}

	static int stripe(String path) {
		int h = PathNames.lower(path).hashCode();
		return (h ^ (h >>> 16)) & (STRIPES - 1);
	}

	private Held acquire(Lock vaultLock, Collection<String> paths) {
		Deque<Lock> held = new ArrayDeque<>();
		try {
			lock(vaultLock, held);
			TreeSet<Integer> indexes = new TreeSet<>();
			for (String path : paths) {
				indexes.add(stripe(path));
			}
			for (int index : indexes) {
				lock(this.stripes[index], held);
			}
		}
		catch (RuntimeException ex) {
			release(held);
			throw ex;
		}
		return () -> release(held);
	}

	private void lock(Lock lock, Deque<Lock> held) {
		try {
			if (!lock.tryLock(this.timeoutNanos, TimeUnit.NANOSECONDS)) {
				throw NotesException.busy();
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw NotesException.busy();
		}
		held.push(lock);
	}

	private static void release(Deque<Lock> held) {
		while (!held.isEmpty()) {
			held.pop().unlock();
		}
	}

}
