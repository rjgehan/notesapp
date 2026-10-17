package com.rjgehan.notes.api.dto;

import com.rjgehan.notes.identity.Identity;
import org.jspecify.annotations.Nullable;

public record MeResponse(String login, String name, @Nullable String profilePicUrl, Identity.Source source) {
}
