import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { BUSINESS_LINES } from '../packages/business-lines/business-lines.mjs';

test('only JUNK main is enabled; historical line metadata remains resolvable', () => {
  assert.deepEqual(Object.values(BUSINESS_LINES).filter(line => line.enabled).map(line => line.key), ['zero-dte-options']);
  assert.equal(BUSINESS_LINES['junk-multi-options'].logPrefix, 'junk-multi-options');
});

for (const line of ['junk-multi-options', 'junk-flow-heatmap-options']) {
  test(`${line} direct execution refuses before connecting or overwriting historical status`, () => {
    const statusFile = new URL(`../logs/${line}-status.json`, import.meta.url);
    let before;
    try { before = readFileSync(statusFile); } catch {}
    const entry = new URL(`../apps/${line}/${line.replace('-options', '')}-line.mjs`, import.meta.url);
    const result = spawnSync(process.execPath, [entry.pathname.replace(/^\/(\w:)/, '$1'), '--watch', '--execute-simulate'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, JUNK_ACTIVE_BUSINESS_LINE: line, MOOMOO_OPEND_WS_PORT: '1' },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /is retired; only zero-dte-options may run/);
    if (before) assert.deepEqual(readFileSync(statusFile), before);
  });
}

test('top-level startup and npm no longer schedule retired execution lines', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).scripts;
  assert.equal(Object.keys(scripts).some(key => /^junk:(multi|flow-heatmap):/.test(key)), false);
  const stack = readFileSync(new URL('../run-junk-stack.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(stack, /(?:Start|Ensure)-Junk(?:Multi|FlowHeatmap)Supervisor/);
  assert.match(stack, /Ensure-JunkSupervisor/);
});
