package com.rjgehan.notes.vaults;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a bean that exists once per server, not once per vault (DESIGN §5.39): it lives only in the main application
 * context (the default vault's). An extra vault's context does not create it; when that context's beans need it,
 * they are given the main context's instance. Server-wide beans hold state that must not be duplicated (the request
 * filters, alerts, the Web Push key pair and subscriptions, the AI providers and spend ledger, the publish server, the
 * Tailscale checks) or serve the whole server (the single-page app, the vault list).
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface ServerWide {

}
