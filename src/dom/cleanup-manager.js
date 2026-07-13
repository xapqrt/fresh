const _cleanupFns = [];
const _intervals = [];
const _timeouts = [];
const _observers = [];

const add = (fn) => {
  if (typeof fn === 'function') {
    _cleanupFns.push(fn);
  }
  return fn;
};

const addInterval = (id) => {
  if (id) _intervals.push(id);
  return id;
};

const addTimeout = (id) => {
  if (id) _timeouts.push(id);
  return id;
};

const addObserver = (obs) => {
  if (obs) _observers.push(obs);
  return obs;
};

const cleanup = () => {
  for (let i = _intervals.length - 1; i >= 0; i--) {
    clearInterval(_intervals[i]);
  }
  for (let i = _timeouts.length - 1; i >= 0; i--) {
    clearTimeout(_timeouts[i]);
  }
  for (let i = _observers.length - 1; i >= 0; i--) {
    _observers[i].disconnect();
  }
  for (let i = _cleanupFns.length - 1; i >= 0; i--) {
    try { _cleanupFns[i](); } catch (e) { console.error('cleanup error:', e); }
  }

  _intervals.length = 0;
  _timeouts.length = 0;
  _observers.length = 0;
  _cleanupFns.length = 0;
};

const reset = () => {
  _intervals.length = 0;
  _timeouts.length = 0;
  _observers.length = 0;
  _cleanupFns.length = 0;
};

module.exports = { add, addInterval, addTimeout, addObserver, cleanup, reset };
