package com.rjgehan.notes.ops;

import java.time.Instant;

import com.rjgehan.notes.vaults.ServerWide;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.UnsynchronizedAppenderBase;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.stereotype.Component;

/**
 * Feeds the stable log markers (DESIGN §5.18) to {@link AppAlerts}: a Logback appender on the root logger hands every
 * WARN or ERROR event whose message pattern starts with a marker to {@link AppAlerts#raise}. Only the marker and the
 * event's time are passed on; the message's arguments are never formatted or read. The appender is attached when this
 * bean is created, before the vault startup runs, so a marker logged during startup is not missed.
 */
@Component
@ServerWide
public class AlertLogBridge implements InitializingBean, DisposableBean {

	private static final Logger logger = LoggerFactory.getLogger(AlertLogBridge.class);

	private final AppAlerts alerts;

	private @Nullable MarkerAppender appender;

	public AlertLogBridge(AppAlerts alerts) {
		this.alerts = alerts;
	}

	@Override
	public void afterPropertiesSet() {
		if (!(LoggerFactory.getILoggerFactory() instanceof LoggerContext context)) {
			logger.warn("Logging is not done by Logback, so log markers are not sent as alerts");
			return;
		}
		MarkerAppender markers = new MarkerAppender(this.alerts);
		markers.setContext(context);
		markers.setName("notesapp-alerts-" + Integer.toHexString(System.identityHashCode(this)));
		markers.start();
		context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME).addAppender(markers);
		this.appender = markers;
	}

	@Override
	public void destroy() {
		MarkerAppender markers = this.appender;
		this.appender = null;
		if (markers != null && markers.getContext() instanceof LoggerContext context) {
			context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME).detachAppender(markers);
			markers.stop();
		}
	}

	/** The appender: cheap for every event that is not a marker, which is nearly all of them. */
	static final class MarkerAppender extends UnsynchronizedAppenderBase<ILoggingEvent> {

		private final AppAlerts alerts;

		MarkerAppender(AppAlerts alerts) {
			this.alerts = alerts;
		}

		@Override
		protected void append(ILoggingEvent event) {
			if (!event.getLevel().isGreaterOrEqual(Level.WARN)) {
				return;
			}
			AlertMarker marker = AlertMarker.of(event.getMessage());
			if (marker != null) {
				this.alerts.raise(marker, Instant.ofEpochMilli(event.getTimeStamp()));
			}
		}

	}

}
