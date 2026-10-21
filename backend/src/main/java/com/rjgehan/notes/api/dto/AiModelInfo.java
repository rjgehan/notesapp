package com.rjgehan.notes.api.dto;

/** A model Settings offers, with its list prices in USD per million input and output tokens (API.md §20.4). */
public record AiModelInfo(String id, String label, double inputUsdPerMTok, double outputUsdPerMTok) {
}
