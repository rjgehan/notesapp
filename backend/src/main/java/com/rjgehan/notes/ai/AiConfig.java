package com.rjgehan.notes.ai;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** The {@link ClaudeGateway}: the Anthropic SDK, or the offline fake when {@code notes.ai.fake} is set. */
@Configuration(proxyBeanMethods = false)
public class AiConfig {

	private static final Logger logger = LoggerFactory.getLogger(AiConfig.class);

	@Bean
	ClaudeGateway claudeGateway(AiProperties properties) {
		if (properties.fake()) {
			logger.warn("notes.ai.fake is set: Ask and summaries answer with canned text and never call Anthropic");
			return new FakeGateway(25);
		}
		return new AnthropicGateway(properties.timeout());
	}

}
