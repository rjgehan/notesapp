/**
 * Spreadsheets on the server (ROADMAP item 6): reading {@code .sheet} files so that their cell text and cached values
 * feed search, backlinks and tags through the {@link com.rjgehan.notes.index.DocumentIndexer} extension point (DESIGN
 * §6.21.7). The grid, the formula engine and the file format's owner are the frontend's.
 */
@NullMarked
package com.rjgehan.notes.sheets;

import org.jspecify.annotations.NullMarked;
