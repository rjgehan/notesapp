package com.rjgehan.notes.api.dto;

public record FailedUpdate(String path, FailedReason reason) {
}
