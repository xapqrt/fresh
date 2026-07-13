let _rafBatchDirty = false;
let _rafBatchQueue = [];

const _rafBatchTask = () => {
  _rafBatchDirty = false;
  for (let i = 0; i < _rafBatchQueue.length; i++) _rafBatchQueue[i]();
  _rafBatchQueue.length = 0;
};

function rafThrottle(fn) {
  let scheduled = false;
  return function (...args) {
    if (scheduled) return;
    scheduled = true;
    _rafBatchQueue.push(() => {
      scheduled = false;
      fn(...args);
    });
    if (!_rafBatchDirty) {
      _rafBatchDirty = true;
      requestAnimationFrame(_rafBatchTask);
    }
  };
}

function rafThrottleMO(cb) {
  let scheduled = false;
  let pending = [];
  return function (mutations, observer) {
    for (let i = 0; i < mutations.length; i++) pending.push(mutations[i]);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const batch = pending;
      pending = [];
      cb(batch, observer);
    });
  };
}

function patchMutationObserverGlobal(cleanupFn) {
  const OrigMO = window.MutationObserver;
  window.MutationObserver = function (cb) {
    const wrapped = rafThrottleMO(cb);
    const obs = new OrigMO(wrapped);
    if (cleanupFn) cleanupFn(obs);
    return obs;
  };
  window.MutationObserver.prototype = OrigMO.prototype;
}

module.exports = { rafThrottle, rafThrottleMO, patchMutationObserverGlobal };
