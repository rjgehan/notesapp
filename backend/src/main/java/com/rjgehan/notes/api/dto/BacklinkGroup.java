package com.rjgehan.notes.api.dto;

import java.util.List;

public record BacklinkGroup(String source, String sourceVersion, List<Mention> mentions) {
}
