/**
 * Canvases on the server (ROADMAP item 25): reading JSON Canvas files ({@code .canvas}) so that their cards, group
 * names, edge labels and file nodes feed search, backlinks and tags through the
 * {@link com.rjgehan.notes.index.DocumentIndexer} extension point, and rewriting their links after a move (DESIGN
 * §6.8.2). The board, its file format and its merge are the frontend's.
 */
@NullMarked
package com.rjgehan.notes.canvas;

import org.jspecify.annotations.NullMarked;
