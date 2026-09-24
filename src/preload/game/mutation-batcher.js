"use strict";

/**
 * One observer can mark several UI regions dirty, while each registered task
 * runs at most once in the next scheduled batch (an animation frame in-game).
 * This turns mutation storms from the
 * scoreboard/killfeed/spectator UI into one bounded update pass.
 */
function createMutationBatcher(options = {}) {
  const MutationObserverClass = options.MutationObserverClass || globalThis.MutationObserver;
  const enqueue = options.enqueue || globalThis.queueMicrotask || ((callback) => Promise.resolve().then(callback));
  const cancelEnqueue = typeof options.cancelEnqueue === "function" ? options.cancelEnqueue : null;
  const onMutations = typeof options.onMutations === "function" ? options.onMutations : () => {};
  const tasks = new Map();
  const dirty = new Set();
  const roots = [];
  let queued = false;
  let queuedHandle = null;
  let suspended = false;
  let destroyed = false;

  const stats = {
    mutationBatches: 0,
    mutations: 0,
    flushes: 0,
    taskRuns: 0,
    coalescedMarks: 0,
  };

  const flush = () => {
    queued = false;
    queuedHandle = null;
    if (destroyed || suspended) return;
    stats.flushes++;
    const pending = Array.from(dirty);
    dirty.clear();
    for (const name of pending) {
      const task = tasks.get(name);
      if (!task) continue;
      try {
        task();
        stats.taskRuns++;
      } catch (error) {
        options.onError?.(error, name);
      }
    }
  };

  const mark = (name) => {
    if (destroyed || !tasks.has(name)) return;
    if (dirty.has(name)) stats.coalescedMarks++;
    dirty.add(name);
    if (!queued && !suspended) {
      queued = true;
      queuedHandle = enqueue(flush);
    }
  };

  const cancelQueued = () => {
    if (queued && cancelEnqueue && queuedHandle !== null && queuedHandle !== undefined) {
      cancelEnqueue(queuedHandle);
    }
    queued = false;
    queuedHandle = null;
  };

  const observer = new MutationObserverClass((mutations) => {
    if (destroyed || suspended) return;
    stats.mutationBatches++;
    stats.mutations += mutations.length;
    onMutations(mutations, mark);
  });

  const reconnect = () => {
    if (destroyed || suspended) return;
    for (const { target, observeOptions } of roots) observer.observe(target, observeOptions);
  };

  const api = {
    register(name, task) {
      tasks.set(name, task);
      return api;
    },
    unregister(name) {
      tasks.delete(name);
      dirty.delete(name);
    },
    mark,
    observe(target, observeOptions) {
      if (!target || destroyed) return api;
      roots.push({ target, observeOptions });
      if (!suspended) observer.observe(target, observeOptions);
      return api;
    },
    suspend() {
      if (destroyed || suspended) return;
      suspended = true;
      observer.disconnect();
      dirty.clear();
      cancelQueued();
    },
    resume(markAll = true) {
      if (destroyed || !suspended) return;
      suspended = false;
      reconnect();
      if (markAll) for (const name of tasks.keys()) mark(name);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      roots.length = 0;
      tasks.clear();
      dirty.clear();
      cancelQueued();
    },
    flush,
    getStats: () => ({ ...stats, tasks: tasks.size, roots: roots.length, dirty: dirty.size, suspended, destroyed }),
  };

  return api;
}

const mutationTouches = (mutation, selector) => {
  const target = mutation?.target;
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  if (element?.matches?.(selector) || element?.closest?.(selector)) return true;
  for (const node of mutation?.addedNodes || []) {
    if (node?.nodeType !== 1) continue;
    if (node.matches?.(selector) || node.querySelector?.(selector)) return true;
  }
  return false;
};

module.exports = { createMutationBatcher, mutationTouches };
