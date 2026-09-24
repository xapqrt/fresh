"use strict";

function createIdleWorkQueue(options = {}) {
  const scope = options.scope || globalThis;
  const requestIdle = options.requestIdle || scope.requestIdleCallback?.bind(scope) || ((callback) => scope.setTimeout(callback, 80));
  const cancelIdle = options.cancelIdle || scope.cancelIdleCallback?.bind(scope) || scope.clearTimeout?.bind(scope);
  const tasks = [];
  let handle = null;
  let suspended = false;
  let destroyed = false;
  const stats = { queued: 0, completed: 0, failed: 0, suspends: 0 };

  const schedule = () => {
    if (destroyed || suspended || handle !== null || !tasks.length) return;
    handle = requestIdle((deadline = {}) => {
      handle = null;
      if (destroyed || suspended) return;
      do {
        const task = tasks.shift();
        if (!task) break;
        try {
          const result = task();
          if (result?.catch) result.catch(() => { stats.failed++; });
          stats.completed++;
        } catch (error) {
          stats.failed++;
        }
      } while (tasks.length && typeof deadline.timeRemaining === "function" && deadline.timeRemaining() > 4);
      schedule();
    }, { timeout: 1000 });
  };

  return {
    add(task) {
      if (destroyed || typeof task !== "function") return;
      tasks.push(task);
      stats.queued++;
      schedule();
    },
    suspend() {
      if (suspended || destroyed) return;
      suspended = true;
      stats.suspends++;
      if (handle !== null) cancelIdle?.(handle);
      handle = null;
    },
    resume() {
      if (!suspended || destroyed) return;
      suspended = false;
      schedule();
    },
    destroy() {
      destroyed = true;
      if (handle !== null) cancelIdle?.(handle);
      handle = null;
      tasks.length = 0;
    },
    getStats: () => ({ ...stats, pending: tasks.length, suspended, destroyed }),
  };
}

module.exports = { createIdleWorkQueue };
