#!/usr/bin/env node
// Regenerates THIRD_PARTY_NOTICES.md: every third-party package that ships in the NotesApp image,
// with its licence. Run it from anywhere after a dependency change:
//
//   node scripts/third-party-notices.mjs
//
// Frontend: the production packages of frontend/package-lock.json (dev-only packages and type
// definitions never reach the bundle). Backend: the compile and runtime dependencies Maven resolves
// for backend/pom.xml, with licences read from their POMs in the local Maven repository (following
// parent POMs). Needs Node 24 and the backend's Maven wrapper; uses no npm packages.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'THIRD_PARTY_NOTICES.md');

// ---------- frontend ----------

function sourceUrl(pkg) {
  let url = pkg.homepage ?? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url);
  if (!url) return '';
  url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/#readme$/, '');
  if (/^github:/.test(url)) url = 'https://github.com/' + url.slice('github:'.length);
  else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = 'https://github.com/' + url;
  return url;
}

function frontendPackages() {
  const lock = JSON.parse(readFileSync(join(root, 'frontend', 'package-lock.json'), 'utf8'));
  const byName = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith('node_modules/') || entry.dev || entry.devOptional || entry.link) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (name.startsWith('@types/')) continue; // type definitions only, no code in the bundle
    const manifestPath = join(root, 'frontend', key, 'package.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
    const licence = entry.license ?? manifest.license ?? 'UNKNOWN';
    const known = byName.get(name);
    if (known) known.licences.add(licence);
    else byName.set(name, { name, licences: new Set([licence]), url: sourceUrl(manifest) });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- backend ----------

function mavenDependencies() {
  const dir = mkdtempSync(join(tmpdir(), 'notices-'));
  const list = join(dir, 'deps.txt');
  try {
    const args = ['-B', '-q', 'dependency:list', '-DincludeScope=runtime', `-DoutputFile=${list}`];
    const [command, commandArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', '.\\mvnw.cmd', ...args]] : ['./mvnw', args];
    const result = spawnSync(command, commandArgs, { cwd: join(root, 'backend'), stdio: 'inherit' });
    if (result.status !== 0) throw new Error('mvnw dependency:list failed');
    const deps = [];
    for (const line of readFileSync(list, 'utf8').split(/\r?\n/)) {
      // group:artifact:type[:classifier]:version:scope, optionally followed by " -- module ..."
      const m = /^\s+([^:\s]+):([^:\s]+):[^:\s]+(?::[^:\s]+)?:([^:\s]+):(compile|runtime)\b/.exec(line);
      if (m) deps.push({ groupId: m[1], artifactId: m[2], version: m[3] });
    }
    return deps;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const repository = process.env.MAVEN_REPO_LOCAL ?? join(homedir(), '.m2', 'repository');

function readPom({ groupId, artifactId, version }) {
  const path = join(repository, ...groupId.split('.'), artifactId, version, `${artifactId}-${version}.pom`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const tag = (xml, name) => new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(xml)?.[1];
const withoutBlocks = (xml, names) => names.reduce((s, n) => s.replace(new RegExp(`<${n}>[\\s\\S]*?</${n}>`, 'g'), ''), xml);

/** Licences and project URL of an artifact, inherited from parent POMs when it declares none. */
function pomInfo(coords, depth = 0) {
  const pom = readPom(coords);
  if (!pom || depth > 10) return { licences: [], url: '' };
  const licencesBlock = tag(pom, 'licenses') ?? '';
  const licences = [...licencesBlock.matchAll(/<license>([\s\S]*?)<\/license>/g)].map((m) => tag(m[1], 'name')?.replace(/\s+/g, ' ')).filter(Boolean);
  const own = withoutBlocks(pom, [
    'parent', 'licenses', 'developers', 'contributors', 'scm', 'organization', 'issueManagement', 'ciManagement',
    'distributionManagement', 'mailingLists', 'repositories', 'pluginRepositories', 'build', 'reporting', 'profiles',
    'dependencies', 'dependencyManagement',
  ]);
  const properties = tag(pom, 'properties') ?? '';
  let url = (tag(own, 'url') ?? tag(tag(pom, 'scm') ?? '', 'url') ?? '').replace(/\$\{([\w.-]+)\}/g, (m, name) => tag(properties, name) ?? m);
  if (url.includes('${')) url = '';
  const parentBlock = tag(pom, 'parent');
  if ((licences.length === 0 || !url) && parentBlock) {
    const parent = pomInfo({ groupId: tag(parentBlock, 'groupId'), artifactId: tag(parentBlock, 'artifactId'), version: tag(parentBlock, 'version') }, depth + 1);
    return { licences: licences.length > 0 ? licences : parent.licences, url: url || parent.url };
  }
  return { licences, url };
}

/** POM licence names, shortened to their SPDX identifiers where unambiguous. */
const SPDX = [
  [/apache.*\b2(\.0)?\b/i, 'Apache-2.0'],
  [/eclipse distribution license.*1\.0|^edl 1\.0$/i, 'BSD-3-Clause (EDL-1.0)'],
  [/eclipse public license.*2\.0|^epl[- ]2\.0$/i, 'EPL-2.0'],
  [/eclipse public license.*1\.0|^epl[- ]1\.0$/i, 'EPL-1.0'],
  [/lesser general public license.*2\.1|^lgpl[- ]2\.1$/i, 'LGPL-2.1'],
  [/^gnu lesser general public license$/i, 'LGPL-2.1'],
  [/gpl2 w\/ cpe|classpath exception/i, 'GPL-2.0-with-classpath-exception'],
  [/^(the )?mit license$|^mit$/i, 'MIT'],
  [/bsd[- ]2[- ]clause|simplified bsd/i, 'BSD-2-Clause'],
  [/bsd[- ]3[- ]clause|new bsd|revised bsd/i, 'BSD-3-Clause'],
  [/^bsd license$|^bsd$/i, 'BSD-3-Clause'],
  [/cc0|public domain/i, 'CC0-1.0'],
];
const spdx = (name) => SPDX.find(([re]) => re.test(name))?.[1] ?? name;

function backendArtifacts() {
  return mavenDependencies()
    .map((d) => {
      const info = pomInfo(d);
      return { name: `${d.groupId}:${d.artifactId}`, licences: new Set(info.licences.map(spdx)), url: info.url };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- output ----------

const cell = (s) => s.replace(/\|/g, '\\|');
const row = (p) => `| ${cell(p.name)} | ${cell([...p.licences].join(' / ') || 'UNKNOWN')} | ${p.url ? `<${p.url}>` : ''} |`;

const frontend = frontendPackages();
const backend = backendArtifacts();
const unknown = [...frontend, ...backend].filter((p) => p.licences.size === 0 || p.licences.has('UNKNOWN'));

writeFileSync(
  out,
  `# Third-party notices

NotesApp is licensed under the GNU General Public License, version 3 only (\`GPL-3.0-only\`, see [LICENSE](LICENSE)).
The NotesApp image ships the third-party software listed below, each under its own licence. Where an entry names several
licences, they are the alternatives or the combination its project declares. Each package's full licence text is in its
source distribution: \`frontend/node_modules/<package>/\` for the web app, and the \`META-INF\` folder of each jar inside
the server's Spring Boot jar.

This file is generated; do not edit it by hand. After a dependency change, regenerate it from the repository root with
\`node scripts/third-party-notices.mjs\` (it reads \`frontend/package-lock.json\` and resolves the backend's runtime
dependencies with the Maven wrapper).

## Web app (bundled by Vite)

The production dependencies of \`frontend/package.json\`, direct and transitive. Development tools (Vite, TypeScript,
Vitest, ESLint and so on) are not shipped.

| Package | Licence | Source |
|---|---|---|
${frontend.map(row).join('\n')}

## Server (in the Spring Boot jar)

The compile and runtime dependencies of \`backend/pom.xml\`, direct and transitive. Test-only dependencies are not shipped.

| Artifact | Licence | Source |
|---|---|---|
${backend.map(row).join('\n')}

## Container image

The image's base layers (the Eclipse Temurin JRE on Ubuntu, see the \`Dockerfile\`) are third-party software under their
own licences, which the base images document.
`,
);

console.log(`Wrote ${out}: ${frontend.length} frontend packages, ${backend.length} backend artifacts.`);
if (unknown.length > 0) {
  console.error(`No licence found for: ${unknown.map((p) => p.name).join(', ')}`);
  process.exitCode = 1;
}
