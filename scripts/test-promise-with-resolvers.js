'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'compat.js'), 'utf8');

function browserContext() {
  return vm.createContext({ AbortSignal, AbortController, DOMException, setTimeout });
}

async function main() {
  const legacy = browserContext();
  vm.runInContext('delete Promise.withResolvers', legacy);
  assert.equal(vm.runInContext('typeof Promise.withResolvers', legacy), 'undefined');
  vm.runInContext(source, legacy);
  const withResolvers = vm.runInContext('Promise.withResolvers', legacy);
  assert.equal(typeof withResolvers, 'function');
  assert.equal(withResolvers.name, 'withResolvers');
  assert.equal(withResolvers.length, 0);
  const descriptor = vm.runInContext(
    "Object.getOwnPropertyDescriptor(Promise, 'withResolvers')", legacy);
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.configurable, true);

  // Both upstream DSH pending card constructors use the no-argument form.
  const browserCapability = vm.runInContext('Promise.withResolvers()', legacy);
  assert.equal(typeof browserCapability.resolve, 'function');
  assert.equal(typeof browserCapability.reject, 'function');
  browserCapability.resolve('approval allowed once');
  assert.equal(await browserCapability.promise, 'approval allowed once');

  const pending = withResolvers.call(Promise);
  assert.equal(pending.promise instanceof Promise, true);
  assert.deepEqual(Object.keys(pending), ['promise', 'resolve', 'reject']);
  let settled = false;
  pending.promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'the capability must wait for a user answer');
  pending.resolve({ answers: [{ id: 'mode', selected: ['chosen option'] }] });
  assert.deepEqual(await pending.promise,
    { answers: [{ id: 'mode', selected: ['chosen option'] }] });

  const rejection = withResolvers.call(Promise);
  const reason = new Error('user declined');
  const rejected = assert.rejects(rejection.promise, error => error === reason);
  rejection.reject(reason);
  await rejected;

  const adopted = withResolvers.call(Promise);
  adopted.resolve({ then(resolve) { resolve('thenable answer'); } });
  assert.equal(await adopted.promise, 'thenable answer');

  const once = withResolvers.call(Promise);
  once.resolve('first answer');
  once.reject(new Error('late rejection'));
  once.resolve('late answer');
  assert.equal(await once.promise, 'first answer');

  class DerivedPromise extends Promise {}
  const derived = withResolvers.call(DerivedPromise);
  assert.equal(derived.promise instanceof DerivedPromise, true);
  derived.resolve('derived answer');
  assert.equal(await derived.promise, 'derived answer');

  // The standard API is generic, including constructors that are not Promises.
  function Capability(executor) {
    this.kind = 'custom capability';
    executor(value => { this.value = value; }, error => { this.reason = error; });
  }
  const generic = withResolvers.call(Capability);
  assert.equal(generic.promise instanceof Capability, true);
  generic.resolve('custom answer');
  assert.equal(generic.promise.value, 'custom answer');
  generic.reject(reason);
  assert.equal(generic.promise.reason, reason);

  for (const receiver of [null, {}, () => {}]) {
    assert.throws(() => withResolvers.call(receiver), { name: 'TypeError' });
  }
  function Invalid(executor) { executor(undefined, () => {}); }
  assert.throws(() => withResolvers.call(Invalid), { name: 'TypeError' });
  function Twice(executor) {
    executor(() => {}, () => {});
    executor(() => {}, () => {});
  }
  assert.throws(() => withResolvers.call(Twice), { name: 'TypeError' });

  const native = browserContext();
  const original = vm.runInContext('Promise.withResolvers', native);
  assert.equal(typeof original, 'function');
  vm.runInContext(source, native);
  assert.equal(vm.runInContext('Promise.withResolvers', native), original,
    'a browser native implementation must remain unchanged');
  vm.runInContext(source, legacy);
  assert.equal(vm.runInContext('Promise.withResolvers', legacy), withResolvers,
    'repeated loading must retain the first fallback');

  console.log('Promise.withResolvers supports DSH approval/question capabilities in legacy browsers');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
