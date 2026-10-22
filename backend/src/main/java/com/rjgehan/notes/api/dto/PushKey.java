package com.rjgehan.notes.api.dto;

/** {@code POST /api/push/key} (API.md §25.2): the VAPID public key a browser subscribes with (base64url). */
public record PushKey(String publicKey) {
}
