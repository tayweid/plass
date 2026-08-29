import assert from 'node:assert/strict';
import { SuffixPaginationControl } from './pagination-suffix-control';

// --- sampling counter -------------------------------------------------------

{
  const control = new SuffixPaginationControl(8);
  const sampled: number[] = [];
  for (let install = 1; install <= 25; install++) {
    if (control.recordInstall()) sampled.push(install);
  }
  assert.deepEqual(sampled, [1, 9, 17, 25]);
  assert.equal(control.installs, 25);
  console.log('  ok  installs 1, 1+N, 1+2N, ... are sampled deterministically');
}

{
  const control = new SuffixPaginationControl(1);
  assert.equal(control.recordInstall(), true);
  assert.equal(control.recordInstall(), true);
  assert.equal(control.recordInstall(), true);
  console.log('  ok  verifyEvery=1 verifies every install');
}

{
  const control = new SuffixPaginationControl(8);
  for (let install = 0; install < 5; install++) control.recordInstall();
  control.resetSampling();
  assert.equal(control.installs, 0);
  assert.equal(control.recordInstall(), true);
  assert.equal(control.recordInstall(), false);
  console.log('  ok  resetSampling restarts the window so its first install is verified');
}

{
  assert.throws(() => new SuffixPaginationControl(0));
  assert.throws(() => new SuffixPaginationControl(2.5));
  assert.throws(() => new SuffixPaginationControl(-8));
  console.log('  ok  a non-positive or fractional sample interval is rejected');
}

// --- kill-switch state machine ---------------------------------------------

{
  const control = new SuffixPaginationControl();
  assert.equal(control.killed, false);
  assert.equal(control.killDetail, null);
  assert.equal(control.inactiveReason(), null);
  assert.equal(control.installsSuffix, true);

  const detail = { source: 'exact', summary: '3:block@120:411.2500!=block@120:435.0000' };
  control.recordMismatch(detail);
  assert.equal(control.killed, true);
  assert.deepEqual(control.killDetail, detail);
  assert.notEqual(control.killDetail, detail); // defensive copy
  assert.equal(control.inactiveReason(), 'killed');
  assert.equal(control.installsSuffix, false);
  console.log('  ok  the first mismatch kills the paginator and retains its detail');
}

{
  const control = new SuffixPaginationControl();
  control.recordMismatch({ source: 'fallback', summary: 'first' });
  control.recordMismatch({ source: 'exact', summary: 'second' });
  assert.equal(control.killed, true);
  assert.equal(control.killDetail?.summary, 'first');
  console.log('  ok  a later mismatch cannot overwrite the original evidence');
}

{
  const control = new SuffixPaginationControl();
  control.recordMismatch({ source: 'injected', summary: 'dev-injected mismatch' });
  assert.equal(control.killed, true);
  control.revive();
  assert.equal(control.killed, false);
  assert.equal(control.killDetail, null);
  assert.equal(control.inactiveReason(), null);
  assert.equal(control.installsSuffix, true);
  console.log('  ok  revive re-arms a killed session');
}

{
  const control = new SuffixPaginationControl();
  for (let install = 0; install < 3; install++) control.recordInstall();
  control.recordMismatch({ source: 'exact', summary: 'drift' });
  control.resetSampling();
  assert.equal(control.installs, 0);
  assert.equal(control.killed, true, 'stats reset must not clear the kill-switch');
  console.log('  ok  resetSampling leaves the kill-switch tripped');
}

// --- mode interactions ------------------------------------------------------

{
  const control = new SuffixPaginationControl();
  control.mode = 'shadow';
  assert.equal(control.inactiveReason(), null, 'shadow mode still plans');
  assert.equal(control.installsSuffix, false, 'shadow mode never installs the suffix');

  control.mode = 'full';
  assert.equal(control.inactiveReason(), 'mode-full');
  assert.equal(control.installsSuffix, false);

  control.mode = 'live';
  assert.equal(control.inactiveReason(), null);
  assert.equal(control.installsSuffix, true);

  control.recordMismatch({ source: 'exact', summary: 'x' });
  assert.equal(control.inactiveReason(), 'killed', 'killed outranks every mode');
  control.mode = 'shadow';
  assert.equal(control.inactiveReason(), 'killed');
  console.log('  ok  mode gates planning and installing; killed outranks every mode');
}

console.log('pagination-suffix-control tests passed');
