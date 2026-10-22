/**
 * Multiple vaults (DESIGN §5.39, ROADMAP item 37): the registry of extra vaults, each served by an application context
 * of its own, and the routing of {@code /api/v/<name>/...} requests to it.
 */
@NullMarked
package com.rjgehan.notes.vaults;

import org.jspecify.annotations.NullMarked;
