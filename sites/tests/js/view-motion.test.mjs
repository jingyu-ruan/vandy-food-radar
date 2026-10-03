import assert from 'node:assert/strict';
import test from 'node:test';
import {springStep} from '../../public/static/js/view-motion.js';

test('a resting slide accelerates, slows and settles without overshooting', () => {
  let position = 1000, velocity = 0;
  const speeds = [];
  for (let frame = 0; frame < 60; frame++) {
    const step = springStep(position, velocity, 0, 1 / 60);
    assert.ok(step.position <= position && step.position >= 0);
    ({position, velocity} = step);
    speeds.push(Math.abs(velocity));
  }
  assert.ok(speeds[1] > speeds[0]);
  assert.ok(speeds[20] < speeds[5]);
  assert.ok(position < 0.01 && Math.abs(velocity) < 0.1);
});

test('retargeting preserves position and velocity at the interruption', () => {
  const moving = springStep(1000, 0, 0, 0.1);
  const interrupted = springStep(moving.position, moving.velocity, 1000, 0);
  assert.deepEqual(interrupted, moving);
  const resumed = springStep(moving.position, moving.velocity, 1000, 0.001);
  assert.ok(Math.abs(resumed.position - moving.position) < 10);
  assert.ok(resumed.velocity < 0);
});
