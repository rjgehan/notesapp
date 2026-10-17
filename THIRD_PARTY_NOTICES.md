# Third-party notices

NotesApp is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`, see [LICENSE](LICENSE)).
The NotesApp image ships the third-party software listed below, each under its own licence. Where an entry names several
licences, they are the alternatives or the combination its project declares. Each package's full licence text is in its
source distribution: `frontend/node_modules/<package>/` for the web app, and the `META-INF` folder of each jar inside
the server's Spring Boot jar.

This file is generated; do not edit it by hand. After a dependency change, regenerate it from the repository root with
`node scripts/third-party-notices.mjs` (it reads `frontend/package-lock.json` and resolves the backend's runtime
dependencies with the Maven wrapper).

## Web app (bundled by Vite)

The production dependencies of `frontend/package.json`, direct and transitive. Development tools (Vite, TypeScript,
Vitest, ESLint and so on) are not shipped.

| Package | Licence | Source |
|---|---|---|
| @codemirror/autocomplete | MIT | <https://code.haverbeke.berlin/codemirror/autocomplete> |
| @codemirror/commands | MIT | <https://code.haverbeke.berlin/codemirror/commands> |
| @codemirror/lang-angular | MIT | <https://github.com/codemirror/lang-angular> |
| @codemirror/lang-cpp | MIT | <https://github.com/codemirror/lang-cpp> |
| @codemirror/lang-css | MIT | <https://github.com/codemirror/lang-css> |
| @codemirror/lang-go | MIT | <https://github.com/codemirror/lang-go> |
| @codemirror/lang-html | MIT | <https://code.haverbeke.berlin/codemirror/lang-html> |
| @codemirror/lang-java | MIT | <https://github.com/codemirror/lang-java> |
| @codemirror/lang-javascript | MIT | <https://github.com/codemirror/lang-javascript> |
| @codemirror/lang-jinja | MIT | <https://code.haverbeke.berlin/codemirror/lang-jinja> |
| @codemirror/lang-json | MIT | <https://github.com/codemirror/lang-json> |
| @codemirror/lang-less | MIT | <https://github.com/codemirror/lang-less> |
| @codemirror/lang-liquid | MIT | <https://code.haverbeke.berlin/codemirror/lang-liquid> |
| @codemirror/lang-markdown | MIT | <https://code.haverbeke.berlin/codemirror/lang-markdown> |
| @codemirror/lang-php | MIT | <https://github.com/codemirror/lang-php> |
| @codemirror/lang-python | MIT | <https://github.com/codemirror/lang-python> |
| @codemirror/lang-rust | MIT | <https://github.com/codemirror/lang-rust> |
| @codemirror/lang-sass | MIT | <https://github.com/codemirror/lang-sass> |
| @codemirror/lang-sql | MIT | <https://github.com/codemirror/lang-sql> |
| @codemirror/lang-vue | MIT | <https://github.com/codemirror/lang-vue> |
| @codemirror/lang-wast | MIT | <https://github.com/codemirror/lang-wast> |
| @codemirror/lang-xml | MIT | <https://github.com/codemirror/lang-xml> |
| @codemirror/lang-yaml | MIT | <https://github.com/codemirror/lang-yaml> |
| @codemirror/language | MIT | <https://code.haverbeke.berlin/codemirror/language> |
| @codemirror/language-data | MIT | <https://github.com/codemirror/language-data> |
| @codemirror/legacy-modes | MIT | <https://code.haverbeke.berlin/codemirror/legacy-modes> |
| @codemirror/lint | MIT | <https://code.haverbeke.berlin/codemirror/lint> |
| @codemirror/merge | MIT | <https://code.haverbeke.berlin/codemirror/merge> |
| @codemirror/search | MIT | <https://code.haverbeke.berlin/codemirror/search> |
| @codemirror/state | MIT | <https://code.haverbeke.berlin/codemirror/state> |
| @codemirror/streamparser | MIT | <https://code.haverbeke.berlin/codemirror/streamparser> |
| @codemirror/view | MIT | <https://code.haverbeke.berlin/codemirror/view> |
| @lezer/common | MIT | <https://code.haverbeke.berlin/lezer/common> |
| @lezer/cpp | MIT | <https://code.haverbeke.berlin/lezer/cpp> |
| @lezer/css | MIT | <https://code.haverbeke.berlin/lezer/css> |
| @lezer/go | MIT | <https://github.com/lezer-parser/go> |
| @lezer/highlight | MIT | <https://code.haverbeke.berlin/lezer/highlight> |
| @lezer/html | MIT | <https://github.com/lezer-parser/html> |
| @lezer/java | MIT | <https://code.haverbeke.berlin/lezer/java> |
| @lezer/javascript | MIT | <https://code.haverbeke.berlin/lezer/javascript> |
| @lezer/json | MIT | <https://github.com/lezer-parser/json> |
| @lezer/lr | MIT | <https://code.haverbeke.berlin/lezer/lr> |
| @lezer/markdown | MIT | <https://code.haverbeke.berlin/lezer/markdown> |
| @lezer/php | MIT | <https://code.haverbeke.berlin/lezer/php> |
| @lezer/python | MIT | <https://code.haverbeke.berlin/lezer/python> |
| @lezer/rust | MIT | <https://code.haverbeke.berlin/lezer/rust> |
| @lezer/sass | MIT | <https://github.com/lezer-parser/sass> |
| @lezer/xml | MIT | <https://github.com/lezer-parser/xml> |
| @lezer/yaml | MIT | <https://github.com/lezer-parser/yaml> |
| @marijn/find-cluster-break | MIT | <https://code.haverbeke.berlin/marijn/find-cluster-break> |
| @mdit/helper | MIT | <https://mdit-plugins.github.io/> |
| @mdit/plugin-footnote | MIT | <https://mdit-plugins.github.io/footnote.html> |
| @mdit/plugin-inline-rule | MIT | <https://mdit-plugins.github.io/inline-rule.html> |
| @mdit/plugin-mark | MIT | <https://mdit-plugins.github.io/mark.html> |
| @mdit/plugin-tasklist | MIT | <https://mdit-plugins.github.io/tasklist.html> |
| @remix-run/route-pattern | MIT | <https://github.com/remix-run/remix/tree/main/packages/route-pattern> |
| @tanstack/query-core | MIT | <https://tanstack.com/query> |
| @tanstack/react-query | MIT | <https://tanstack.com/query> |
| argparse | PSF-2.0 | <https://github.com/nodeca/argparse> |
| cookie-es | MIT | <https://github.com/unjs/cookie-es> |
| crelt | MIT | <https://code.haverbeke.berlin/marijn/crelt> |
| dayjs | MIT | <https://day.js.org> |
| dompurify | (MPL-2.0 OR Apache-2.0) | <https://github.com/cure53/DOMPurify> |
| entities | BSD-2-Clause | <https://github.com/fb55/entities> |
| fuzzysort | MIT | <https://github.com/farzher/fuzzysort> |
| linkify-it | MIT | <https://github.com/markdown-it/linkify-it> |
| lucide-react | ISC | <https://lucide.dev> |
| markdown-it | MIT | <https://github.com/markdown-it/markdown-it> |
| mdurl | MIT | <https://github.com/markdown-it/mdurl> |
| punycode.js | MIT | <https://mths.be/punycode> |
| react | MIT | <https://react.dev/> |
| react-dom | MIT | <https://react.dev/> |
| react-router | MIT | <https://github.com/remix-run/react-router> |
| scheduler | MIT | <https://react.dev/> |
| style-mod | MIT | <https://code.haverbeke.berlin/marijn/style-mod> |
| uc.micro | MIT | <https://github.com/markdown-it/uc.micro> |
| w3c-keyname | MIT | <https://github.com/marijnh/w3c-keyname> |
| yaml | ISC | <https://eemeli.org/yaml/> |
| zustand | MIT | <https://github.com/pmndrs/zustand> |

## Server (in the Spring Boot jar)

The compile and runtime dependencies of `backend/pom.xml`, direct and transitive. Test-only dependencies are not shipped.

| Artifact | Licence | Source |
|---|---|---|
| ch.qos.logback:logback-classic | EPL-2.0 / LGPL-2.1-only | <http://logback.qos.ch> |
| ch.qos.logback:logback-core | EPL-2.0 / LGPL-2.1-only | <http://logback.qos.ch> |
| com.fasterxml:classmate | Apache-2.0 | <https://github.com/FasterXML/java-classmate> |
| com.fasterxml.jackson.core:jackson-annotations | Apache-2.0 | <https://github.com/FasterXML/jackson> |
| com.googlecode.javaewah:JavaEWAH | Apache-2.0 | <https://github.com/lemire/javaewah> |
| commons-codec:commons-codec | Apache-2.0 | <https://commons.apache.org/proper/commons-codec/> |
| commons-logging:commons-logging | Apache-2.0 | <https://commons.apache.org/proper/commons-logging/> |
| io.micrometer:micrometer-commons | Apache-2.0 | <https://github.com/micrometer-metrics/micrometer-commercial> |
| io.micrometer:micrometer-core | Apache-2.0 | <https://github.com/micrometer-metrics/micrometer-commercial> |
| io.micrometer:micrometer-jakarta9 | Apache-2.0 | <https://github.com/micrometer-metrics/micrometer-commercial> |
| io.micrometer:micrometer-observation | Apache-2.0 | <https://github.com/micrometer-metrics/micrometer-commercial> |
| jakarta.annotation:jakarta.annotation-api | EPL-2.0 / GPL-2.0-with-classpath-exception | <https://projects.eclipse.org/projects/ee4j.ca> |
| jakarta.validation:jakarta.validation-api | Apache-2.0 | <https://beanvalidation.org> |
| org.apache.logging.log4j:log4j-api | Apache-2.0 | <https://logging.apache.org/log4j/2.x/> |
| org.apache.logging.log4j:log4j-to-slf4j | Apache-2.0 | <https://logging.apache.org/log4j/2.x/> |
| org.apache.tomcat.embed:tomcat-embed-core | Apache-2.0 | <https://tomcat.apache.org/> |
| org.apache.tomcat.embed:tomcat-embed-el | Apache-2.0 | <https://tomcat.apache.org/> |
| org.apache.tomcat.embed:tomcat-embed-websocket | Apache-2.0 | <https://tomcat.apache.org/> |
| org.eclipse.jgit:org.eclipse.jgit | BSD-3-Clause | <https://www.eclipse.org/jgit/> |
| org.hdrhistogram:HdrHistogram | CC0-1.0 / BSD-2-Clause | <http://hdrhistogram.github.io/HdrHistogram/> |
| org.hibernate.validator:hibernate-validator | Apache-2.0 | <https://hibernate.org/validator> |
| org.jboss.logging:jboss-logging | Apache-2.0 | <https://www.jboss.org> |
| org.jspecify:jspecify | Apache-2.0 | <https://jspecify.dev/> |
| org.slf4j:jul-to-slf4j | MIT | <http://www.slf4j.org> |
| org.slf4j:slf4j-api | MIT | <http://www.slf4j.org> |
| org.snakeyaml:snakeyaml-engine | Apache-2.0 | <https://codeberg.org/snakeyaml/snakeyaml-engine> |
| org.springframework:spring-aop | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-beans | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-context | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-core | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-expression | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-web | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-webmvc | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework.boot:spring-boot | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-actuator | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-actuator-autoconfigure | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-autoconfigure | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-health | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-http-converter | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-jackson | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-micrometer-metrics | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-micrometer-observation | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-servlet | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-actuator | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-jackson | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-logging | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-micrometer-metrics | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-tomcat | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-tomcat-runtime | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-validation | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-webmvc | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-tomcat | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-validation | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-web-server | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-webmvc | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.yaml:snakeyaml | Apache-2.0 | <https://bitbucket.org/snakeyaml/snakeyaml> |
| tools.jackson.core:jackson-core | Apache-2.0 | <https://github.com/FasterXML/jackson-core> |
| tools.jackson.core:jackson-databind | Apache-2.0 | <https://github.com/FasterXML/jackson> |

## Container image

The image's base layers (the Eclipse Temurin JRE on Ubuntu, see the `Dockerfile`) are third-party software under their
own licences, which the base images document.
