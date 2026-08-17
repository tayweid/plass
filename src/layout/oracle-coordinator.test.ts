import { PageHoldConfidence } from './oracle-coordinator';
import type { PageOracleEntry } from './page-oracle';

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

const policy = new PageHoldConfidence();
const failures: PageOracleEntry[] = Array.from({ length: 4 }, (_, i) => ({
  status: 'fail',
  reason: `failure ${i + 1}`,
}));

let decision = policy.observe(undefined);
check('missing entry can hold', decision.hold && decision.failureStreak === 0 && decision.status === 'pending');

decision = policy.observe(failures[0]);
check('first failed entry can hold', decision.hold && decision.failureStreak === 1);
decision = policy.observe(failures[0]);
check('same failed entry increments once', decision.hold && decision.failureStreak === 1);

decision = policy.observe(failures[1]);
check('second distinct failed entry can hold', decision.hold && decision.failureStreak === 2);
decision = policy.observe(failures[2]);
check('third distinct failed entry can hold', decision.hold && decision.failureStreak === 3);
decision = policy.observe(failures[3]);
check('fourth distinct failed entry abandons hold', !decision.hold && decision.failureStreak === 4);

decision = policy.observe(undefined);
check('pending entry can hold after failure cutoff', decision.hold && decision.failureStreak === 4);

decision = policy.observe({ status: 'ok', pageStarts: [], pageCount: 1 });
check('successful entry resets failure streak', decision.hold && decision.failureStreak === 0);

decision = policy.observe(failures[3]);
check('failure after success begins a new streak', decision.hold && decision.failureStreak === 1);

console.log('\nall oracle coordinator tests passed');
