package com.rjgehan.notes.identity;

import jakarta.servlet.http.HttpServletRequest;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import org.jspecify.annotations.Nullable;

import org.springframework.core.MethodParameter;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

/** Lets controllers declare an {@link Identity} parameter: the identity admitted by {@code HostAndIdentityFilter}. */
@Component
public class IdentityArgumentResolver implements HandlerMethodArgumentResolver {

	private final IdentityResolver resolver;

	public IdentityArgumentResolver(IdentityResolver resolver) {
		this.resolver = resolver;
	}

	@Override
	public boolean supportsParameter(MethodParameter parameter) {
		return Identity.class.equals(parameter.getParameterType());
	}

	@Override
	public Identity resolveArgument(MethodParameter parameter, @Nullable ModelAndViewContainer mavContainer,
			NativeWebRequest webRequest, @Nullable WebDataBinderFactory binderFactory) {
		HttpServletRequest request = webRequest.getNativeRequest(HttpServletRequest.class);
		if (request != null && request.getAttribute(Identity.ATTRIBUTE) instanceof Identity identity) {
			return identity;
		}
		Identity identity = (request != null) ? this.resolver.resolve(request) : null;
		if (identity == null) {
			throw new NotesException(ErrorCode.IDENTITY_NOT_ALLOWED, "This identity may not use NotesApp");
		}
		return identity;
	}

}
