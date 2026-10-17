package com.rjgehan.notes.api;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;

import com.rjgehan.notes.api.dto.CreateFileRequest;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.SaveFileRequest;
import com.rjgehan.notes.api.dto.TextFile;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.api.dto.WriteResult;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.vault.FileService;
import com.rjgehan.notes.vault.TrashService;
import org.jspecify.annotations.Nullable;

import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.UriUtils;

/** Text files (API.md §8) and raw files (§9.1, §9.2). */
@RestController
public class FileController {

	private final FileService files;

	private final RawResponses raw;

	private final IdempotencyCache idempotency;

	private final TrashService trash;

	public FileController(FileService files, RawResponses raw, IdempotencyCache idempotency, TrashService trash) {
		this.files = files;
		this.raw = raw;
		this.idempotency = idempotency;
		this.trash = trash;
	}

	@GetMapping("/api/files")
	TextFile read(@RequestParam String path) throws IOException {
		return this.files.readText(path);
	}

	@PostMapping("/api/files")
	ResponseEntity<WriteResult> create(@Valid @RequestBody CreateFileRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http, () -> {
			WriteResult result = this.files.createText(request.path(),
					(request.content() != null) ? request.content() : "",
					(request.onConflict() != null) ? request.onConflict() : OnConflict.FAIL, identity, origin);
			return ResponseEntity.created(location(result.file().path())).body(result);
		});
	}

	@PutMapping("/api/files")
	ResponseEntity<WriteResult> save(@RequestParam String path, @Valid @RequestBody SaveFileRequest request,
			Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		FileService.Saved saved = this.files.saveText(path, request.content(), request.baseVersion(),
				Boolean.TRUE.equals(request.flushHistory()), identity, origin);
		return ResponseEntity.status(saved.created() ? HttpStatus.CREATED : HttpStatus.OK).body(saved.result());
	}

	@DeleteMapping("/api/files")
	TrashEntry delete(@RequestParam String path, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.trash.deleteFile(path, identity, origin);
	}

	@GetMapping("/api/files/raw")
	ResponseEntity<Resource> raw(@RequestParam String path, @RequestParam(required = false) @Nullable String v,
			@RequestParam(defaultValue = "false") boolean download) {
		return this.raw.file(this.files.openRaw(path), v, download);
	}

	@PutMapping("/api/files/raw")
	ResponseEntity<WriteResult> upload(@RequestParam String path,
			@RequestParam(defaultValue = "fail") String onConflict, InputStream body, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		FileService.UploadConflict mode = uploadConflict(onConflict);
		return this.idempotency.execute(idempotencyKey, http, () -> {
			FileService.Saved saved = this.files.upload(path, mode, body, http.getContentLengthLong(), identity,
					origin);
			return ResponseEntity.status(saved.created() ? HttpStatus.CREATED : HttpStatus.OK).body(saved.result());
		});
	}

	static URI location(String path) {
		return URI.create("/api/files?path=" + UriUtils.encode(path, StandardCharsets.UTF_8));
	}

	private static FileService.UploadConflict uploadConflict(String value) {
		try {
			return FileService.UploadConflict.valueOf(value.toUpperCase(Locale.ROOT));
		}
		catch (IllegalArgumentException ex) {
			throw NotesException.badRequest("onConflict must be fail, rename or overwrite");
		}
	}

}
