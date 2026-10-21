import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseTwitterOutput, searchArguments } from '../../scripts/hermes-research.js';

test('Twitter output fails closed on errors and schema drift', () => {
  assert.deepEqual(parseTwitterOutput('{"ok":true,"schema_version":"1","data":[]}'), []);
  for (const value of [{ ok: false, schema_version: '1', error: {} },
    { ok: true, schema_version: '2', data: [] }, { ok: true, schema_version: '1' }]) {
    assert.throws(() => parseTwitterOutput(JSON.stringify(value)));
  }
  assert.throws(() => parseTwitterOutput('not JSON'));
});

test('queries remain a single literal argument and result counts are bounded', () => {
  const query = '$NVDA $(touch /tmp/should-not-exist)';
  assert.deepEqual(searchArguments(query, '2026-10-21', 25),
    ['search', query, '-t', 'Latest', '--since', '2026-10-21', '--max', '25', '--json']);
  for (const max of [0, 51, NaN, 1.5]) assert.throws(() => searchArguments('stocks', '2026-10-21', max));
});

test('collector and Hermes handoff work together without live services', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stockbot-hermes-test-'));
  const fake = join(directory, 'fake-cli');
  const exec = promisify(execFile);
  let runDirectory;
  try {
    await writeFile(fake, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'chat') {
  if (!args.includes('web,file,delegation') || !args.includes('--query-file')) process.exit(5);
  console.log('# Test research report');
} else if (args[0] === 'status') {
  console.log(JSON.stringify({ok:true,schema_version:'1',data:{authenticated:true}}));
} else if (args[0] === 'search' && args.includes('--json')) {
  console.log(JSON.stringify({ok:true,schema_version:'1',data:[{id:'123',text:'Test evidence'}]}));
} else process.exit(6);
`);
    await chmod(fake, 0o700);
    const { stdout } = await exec(process.execPath, ['scripts/hermes-research.js', 'run'], {
      cwd: resolve('.'), env: { ...process.env, STOCKBOT_TWITTER_BIN: fake, STOCKBOT_HERMES_BIN: fake }
    });
    runDirectory = stdout.match(/Research bundle: (.+)/)[1];
    const evidence = JSON.parse(await readFile(join(runDirectory, 'evidence.json'), 'utf8'));
    assert.equal(evidence.searches.length, 3);
    assert.equal(evidence.market, 'US-listed common stocks');
    assert.match(await readFile(join(runDirectory, 'prompt.md'), 'utf8'), /delegate_task/);
    assert.match(await readFile(join(runDirectory, 'report.md'), 'utf8'), /Test research report/);
    await writeFile(fake, `#!${process.execPath}\nconsole.error('sensitive stderr'); process.exit(1);\n`);
    await assert.rejects(exec(process.execPath, ['scripts/hermes-research.js', 'run'], {
      env: { ...process.env, STOCKBOT_TWITTER_BIN: fake, STOCKBOT_HERMES_BIN: fake }
    }), error => !error.stderr.includes('sensitive stderr') && error.stderr.includes('Twitter read failed'));
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
  }
});
