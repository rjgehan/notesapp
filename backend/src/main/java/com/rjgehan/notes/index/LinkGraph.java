package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * Outgoing resolved links, incoming backlinks, and name-key buckets for re-resolution (DESIGN §5.5.6, §5.5.8). Not
 * thread-safe: {@link VaultIndex} guards it with its lock, and resolution happens inside that lock at swap time.
 */
public final class LinkGraph {

	/** A link occurrence and the path it resolves to, or null when unresolved. */
	public record Resolved(LinkOcc occ, @Nullable String target) {
	}

	private final Map<String, List<Resolved>> outgoing = new HashMap<>();

	private final Map<String, Set<String>> incoming = new HashMap<>();

	private final Map<String, Set<String>> buckets = new HashMap<>();

	private final Map<String, Set<String>> sourceKeys = new HashMap<>();

	private final Set<String> unresolvedSources = new HashSet<>();

	/** Replaces a note's outgoing links, resolving them now. */
	public void setNote(String source, List<LinkOcc> links, LinkResolver.Lookup lookup) {
		removeNote(source);
		Set<String> keys = new HashSet<>();
		for (LinkOcc occ : links) {
			keys.add(LinkResolver.nameKey(occ.target()));
		}
		for (String key : keys) {
			this.buckets.computeIfAbsent(key, (k) -> new LinkedHashSet<>()).add(source);
		}
		this.sourceKeys.put(source, keys);
		resolveInto(source, links, lookup);
	}

	public void removeNote(String source) {
		List<Resolved> previous = this.outgoing.remove(source);
		if (previous != null) {
			unlinkIncoming(source, previous);
		}
		Set<String> keys = this.sourceKeys.remove(source);
		if (keys != null) {
			for (String key : keys) {
				Set<String> bucket = this.buckets.get(key);
				if (bucket != null) {
					bucket.remove(source);
					if (bucket.isEmpty()) {
						this.buckets.remove(key);
					}
				}
			}
		}
		this.unresolvedSources.remove(source);
	}

	/** Re-resolves every note that has a link in one of the buckets, after files with these keys appeared or left. */
	public void reresolveKeys(Collection<String> keys, LinkResolver.Lookup lookup) {
		Set<String> sources = new LinkedHashSet<>();
		for (String key : keys) {
			Set<String> bucket = this.buckets.get(key);
			if (bucket != null) {
				sources.addAll(bucket);
			}
		}
		reresolveSources(sources, lookup);
	}

	public void reresolveSources(Collection<String> sources, LinkResolver.Lookup lookup) {
		for (String source : sources) {
			List<Resolved> previous = this.outgoing.get(source);
			if (previous == null) {
				continue;
			}
			unlinkIncoming(source, previous);
			List<LinkOcc> links = new ArrayList<>(previous.size());
			for (Resolved resolved : previous) {
				links.add(resolved.occ());
			}
			resolveInto(source, links, lookup);
		}
	}

	public List<Resolved> outgoing(String source) {
		return this.outgoing.getOrDefault(source, List.of());
	}

	/** The notes with at least one link resolving to {@code targetPath}. */
	public Set<String> sourcesLinkingTo(String targetPath) {
		Set<String> sources = this.incoming.get(PathNames.lower(targetPath));
		return (sources == null) ? Set.of() : Set.copyOf(sources);
	}

	/** The notes with a link in the bucket {@code key}. */
	public Set<String> sourcesInBucket(String key) {
		Set<String> sources = this.buckets.get(key);
		return (sources == null) ? Set.of() : Set.copyOf(sources);
	}

	/** The notes with at least one unresolved link. */
	public Set<String> sourcesWithUnresolvedLinks() {
		return Set.copyOf(this.unresolvedSources);
	}

	public void clear() {
		this.outgoing.clear();
		this.incoming.clear();
		this.buckets.clear();
		this.sourceKeys.clear();
		this.unresolvedSources.clear();
	}

	private void resolveInto(String source, List<LinkOcc> links, LinkResolver.Lookup lookup) {
		List<Resolved> resolved = new ArrayList<>(links.size());
		boolean unresolved = false;
		for (LinkOcc occ : links) {
			String target = LinkResolver.resolve(occ.target(), source, lookup);
			resolved.add(new Resolved(occ, target));
			if (target == null) {
				unresolved = true;
			}
			else {
				this.incoming.computeIfAbsent(PathNames.lower(target), (k) -> new HashSet<>()).add(source);
			}
		}
		this.outgoing.put(source, List.copyOf(resolved));
		if (unresolved) {
			this.unresolvedSources.add(source);
		}
		else {
			this.unresolvedSources.remove(source);
		}
	}

	private void unlinkIncoming(String source, List<Resolved> previous) {
		for (Resolved resolved : previous) {
			if (resolved.target() == null) {
				continue;
			}
			String key = PathNames.lower(resolved.target());
			Set<String> sources = this.incoming.get(key);
			if (sources != null) {
				sources.remove(source);
				if (sources.isEmpty()) {
					this.incoming.remove(key);
				}
			}
		}
	}

}
