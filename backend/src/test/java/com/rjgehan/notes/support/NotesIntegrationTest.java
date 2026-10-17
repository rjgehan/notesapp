package com.rjgehan.notes.support;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureRestTestClient;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;

/**
 * The integration-test setup of DESIGN §8.1: the real server on a random port, driven through {@code RestTestClient}.
 * Each test class owns a {@code @TempDir} vault and registers it with {@link IntegrationProperties#register}; the
 * context is closed after the class, so a scheduled rescan never runs against a deleted vault.
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureRestTestClient
@DirtiesContext
public @interface NotesIntegrationTest {

}
