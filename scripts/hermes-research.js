#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const twitter = process.env.STOCKBOT_TWITTER_BIN || join(root, '.tools/twitter-cli/bin/twitter');
const hermes = process.env.STOCKBOT_HERMES_BIN || 'hermes';

export function parseTwitterOutput(stdout) {
  const value = JSON.parse(stdout);
  if (value.ok !== true || value.schema_version !== '1' || !Object.hasOwn(value, 'data')) {
    throw new Error('Twitter CLI returned an error or an unsupported output envelope.');
  }
  return value.data;
}

export function searchArguments(query, since, max) {
  if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('Invalid search query.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('Invalid since date.');
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error('Invalid post limit.');
  return ['search', query, '-t', 'Latest', '--since', since, '--max', String(max), '--json'];
}

async function twitterRead(args) {
  // Fixed read operations; no shell interpolation and no raw stderr/auth output.
  let result;
  try { result = await exec(twitter, args, { cwd: root, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new Error('Twitter read failed. Check installation and login with the status command.'); }
  return parseTwitterOutput(result.stdout);
}

async function authenticated() {
  const status = await twitterRead(['status', '--json']);
  if (status?.authenticated !== true) throw new Error('X login required. Sign in to x.com in your browser, then retry. Keep cookies out of chat and Git.');
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...extra] = argv;
  if (extra.length || !['status', 'prepare', 'run'].includes(command)) {
    throw new Error('Usage: npm run research:hermes -- status|prepare|run');
  }
  await authenticated();
  if (command === 'status') {
    process.stdout.write('Twitter CLI authenticated.\n');
    return;
  }
  const config = JSON.parse(await readFile(join(root, 'research/us-equities-twitter.json'), 'utf8'));
  if (!Number.isInteger(config.lookbackDays) || config.lookbackDays < 1 || config.lookbackDays > 30 ||
      !Array.isArray(config.queries) || config.queries.length < 1 || config.queries.length > 10) {
    throw new Error('Invalid bounded research configuration.');
  }
  const asOf = new Date().toISOString();
  const since = new Date(Date.parse(asOf) - config.lookbackDays * 86400000).toISOString().slice(0, 10);
  const directory = join(root, 'data/hermes-research', asOf.replace(/[:.]/g, '-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const searches = [];
  // Sequential collection shares one account and avoids concurrent bursts.
  for (const query of config.queries) {
    const data = await twitterRead(searchArguments(query, since, config.maxPostsPerQuery));
    if (!Array.isArray(data)) throw new Error('Expected a Twitter search result list.');
    searches.push({ query, retrievedAt: new Date().toISOString(), data });
  }
  const evidence = { asOf, since, market: config.market, horizon: config.horizon, searches };
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const mandate = await readFile(join(root, 'research/hermes-us-equities.md'), 'utf8');
  const prompt = `${mandate}\n\nAs-of UTC: ${asOf}\nEvidence file: ${join(directory, 'evidence.json')}\nRead that file using read_file before delegating. Return the final report in your response.\n`;
  const promptFile = join(directory, 'prompt.md');
  await writeFile(promptFile, prompt, { mode: 0o600 });
  process.stdout.write(`Research bundle: ${directory}\n`);
  if (command === 'prepare') return;
  let result;
  try {
    result = await exec(hermes, ['chat', '--query-file', promptFile, '--toolsets', 'web,file,delegation',
      '--max-turns', '40', '--run-budget', '900', '--quiet'], {
      cwd: root, timeout: 960_000, maxBuffer: 8 * 1024 * 1024
    });
  } catch {
    throw new Error(`Hermes failed; evidence is preserved in ${directory}. Check Hermes provider/tool configuration before retrying.`);
  }
  if (!result.stdout.trim()) throw new Error('Hermes returned an empty report.');
  await writeFile(join(directory, 'report.md'), result.stdout, { mode: 0o600 });
  process.stdout.write(`Hermes output saved: ${join(directory, 'report.md')}\nReview reported role completion and source coverage before using the shortlist.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
