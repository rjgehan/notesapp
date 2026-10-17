package com.rjgehan.notes.api.error;

import java.io.IOException;
import java.nio.file.AccessDeniedException;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletResponse;

import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.TypeMismatchException;
import org.springframework.context.MessageSourceResolvable;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.method.ParameterValidationResult;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.ServletWebRequest;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import org.springframework.web.util.DisconnectedClientHelper;

/**
 * Turns every failure into an RFC 9457 problem with a stable {@code code} (DESIGN §5.15, API.md §3).
 */
@RestControllerAdvice
public class ApiExceptionHandler extends ResponseEntityExceptionHandler {

	private static final Logger logger = LoggerFactory.getLogger(ApiExceptionHandler.class);

	private final VaultFs fs;

	public ApiExceptionHandler(VaultFs fs) {
		this.fs = fs;
	}

	@ExceptionHandler(NoSuchFileException.class)
	@Nullable ResponseEntity<Object> noSuchFile(NoSuchFileException ex, WebRequest request) {
		String path = vaultPath(ex.getFile());
		NotesException notFound = (path != null) ? NotesException.notFound(path)
				: new NotesException(ErrorCode.NOT_FOUND, "No such file or folder");
		return render(notFound, request);
	}

	@ExceptionHandler(AccessDeniedException.class)
	@Nullable ResponseEntity<Object> accessDenied(AccessDeniedException ex, WebRequest request) {
		String incident = Problems.newIncidentId();
		logger.error("Permission denied [{}]: {}", incident, ex.getMessage());
		String path = vaultPath(ex.getFile());
		Map<String, @Nullable Object> extra = new LinkedHashMap<>();
		extra.put("path", (path != null) ? path : "");
		extra.put("incidentId", incident);
		return render(new NotesException(ErrorCode.PERMISSION_DENIED,
				"The server may not write there; check the folder's owner", extra), request);
	}

	@ExceptionHandler(IOException.class)
	@Nullable ResponseEntity<Object> io(IOException ex, WebRequest request) {
		if (DisconnectedClientHelper.isClientDisconnectedException(ex)) {
			return null;
		}
		String incident = Problems.newIncidentId();
		logger.error("Storage error [{}]", incident, ex);
		return render(new NotesException(ErrorCode.IO_ERROR, "A storage error occurred", Map.of("incidentId", incident)),
				request);
	}

	@ExceptionHandler(Exception.class)
	@Nullable ResponseEntity<Object> unexpected(Exception ex, WebRequest request) {
		if (DisconnectedClientHelper.isClientDisconnectedException(ex)) {
			return null;
		}
		String incident = Problems.newIncidentId();
		logger.error("Internal error [{}]", incident, ex);
		return render(new NotesException(ErrorCode.INTERNAL_ERROR, "An internal error occurred",
				Map.of("incidentId", incident)), request);
	}

	private @Nullable ResponseEntity<Object> render(NotesException ex, WebRequest request) {
		return handleExceptionInternal(ex, null, ex.getHeaders(), ex.getStatusCode(), request);
	}

	@Override
	protected @Nullable ResponseEntity<Object> handleExceptionInternal(Exception ex, @Nullable Object body,
			HttpHeaders headers, HttpStatusCode statusCode, WebRequest request) {
		if (request instanceof ServletWebRequest servlet) {
			HttpServletResponse response = servlet.getResponse();
			if (response != null && response.isCommitted()) {
				return null;
			}
		}
		ProblemDetail problem = (body instanceof ProblemDetail detail) ? detail
				: (ex instanceof NotesException notes) ? notes.getBody() : ProblemDetail.forStatus(statusCode);
		ErrorCode code = (ex instanceof NotesException notes) ? notes.code() : codeFor(ex, statusCode);
		HttpStatusCode status = (ex instanceof NotesException) ? statusCode : code.status();
		problem.setStatus(status.value());
		problem.setType(code.type());
		problem.setTitle(code.title());
		problem.setProperty("code", code.code());
		if (code == ErrorCode.BAD_REQUEST && (problem.getProperties() == null
				|| !problem.getProperties().containsKey("errors"))) {
			problem.setProperty("errors", fieldErrors(ex));
		}
		if (code == ErrorCode.TOO_LARGE && (problem.getProperties() == null
				|| !problem.getProperties().containsKey("limit"))) {
			problem.setProperty("limit", PayloadTooLargeException.limitOf(ex));
		}
		HttpHeaders responseHeaders = new HttpHeaders();
		responseHeaders.addAll(headers);
		responseHeaders.setContentType(Problems.PROBLEM_JSON);
		responseHeaders.setCacheControl("no-store");
		String instance = (request instanceof ServletWebRequest servlet) ? servlet.getRequest().getRequestURI() : null;
		return new ResponseEntity<>(Problems.toMap(problem, instance), responseHeaders, status);
	}

	private static ErrorCode codeFor(Exception ex, HttpStatusCode status) {
		if (ex instanceof HttpMessageNotReadableException && PayloadTooLargeException.limitOf(ex) != null) {
			return ErrorCode.TOO_LARGE;
		}
		if (ex instanceof MaxUploadSizeExceededException) {
			return ErrorCode.TOO_LARGE;
		}
		if (ex instanceof HttpMediaTypeNotSupportedException) {
			return ErrorCode.UNSUPPORTED_MEDIA_TYPE;
		}
		if (ex instanceof HttpRequestMethodNotSupportedException) {
			return ErrorCode.METHOD_NOT_ALLOWED;
		}
		if (ex instanceof NoResourceFoundException || ex instanceof NoHandlerFoundException) {
			return ErrorCode.NOT_FOUND;
		}
		if (ex instanceof MethodArgumentNotValidException || ex instanceof HandlerMethodValidationException
				|| ex instanceof HttpMessageNotReadableException || ex instanceof ServletRequestBindingException
				|| ex instanceof TypeMismatchException) {
			return ErrorCode.BAD_REQUEST;
		}
		return switch (status.value()) {
			case 404 -> ErrorCode.NOT_FOUND;
			case 405 -> ErrorCode.METHOD_NOT_ALLOWED;
			case 413 -> ErrorCode.TOO_LARGE;
			case 415 -> ErrorCode.UNSUPPORTED_MEDIA_TYPE;
			case 503 -> ErrorCode.BUSY;
			default -> status.is4xxClientError() ? ErrorCode.BAD_REQUEST : ErrorCode.INTERNAL_ERROR;
		};
	}

	private static List<FieldError> fieldErrors(Exception ex) {
		List<FieldError> errors = new ArrayList<>();
		if (ex instanceof MethodArgumentNotValidException invalid) {
			for (org.springframework.validation.FieldError error : invalid.getBindingResult().getFieldErrors()) {
				errors.add(new FieldError(error.getField(), String.valueOf(error.getDefaultMessage())));
			}
		}
		else if (ex instanceof HandlerMethodValidationException invalid) {
			for (ParameterValidationResult result : invalid.getParameterValidationResults()) {
				String name = String.valueOf(result.getMethodParameter().getParameterName());
				for (MessageSourceResolvable error : result.getResolvableErrors()) {
					errors.add(new FieldError(name, String.valueOf(error.getDefaultMessage())));
				}
			}
		}
		return errors;
	}

	private @Nullable String vaultPath(@Nullable String file) {
		if (file == null) {
			return null;
		}
		try {
			Path absolute = Path.of(file).toAbsolutePath().normalize();
			if (!absolute.startsWith(this.fs.root())) {
				return null;
			}
			String relative = this.fs.root().relativize(absolute).toString().replace('\\', '/');
			return Normalizer.normalize(relative, Normalizer.Form.NFC);
		}
		catch (RuntimeException ex) {
			return null;
		}
	}

}
