package com.rjgehan.notes.index;

/**
 * One tag occurrence, without {@code #}. Frontmatter tags carry their key's line and span.
 */
public record TagOcc(String tag, int line, int from, int to, boolean inFrontmatter) {
}
