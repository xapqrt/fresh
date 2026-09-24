"use strict";

/**
 * Owns the disposable work created for one SPA route/match. Besides final
 * cleanup, suspend/resume temporarily detaches cosmetic observers and global
 * listeners while the window is hidden without touching the game/input clock.
 */
class RuntimeScope {
  constructor(name = "runtime", scheduler = globalThis) {
    this.name = name;
    this.scheduler = scheduler;
    this.closed = false;
    this.suspended = false;
    this.resources = [];
    this.stats = {
      listeners: 0,
      observers: 0,
      timeouts: 0,
      intervals: 0,
      animationFrames: 0,
      custom: 0,
      suspends: 0,
      resumes: 0,
    };
  }

  _add(resource) {
    if (this.closed) {
      resource.cleanup?.();
      return resource;
    }
    this.resources.push(resource);
    if (this.suspended) {
      try { resource.suspend?.(); } catch (error) {}
    }
    return resource;
  }

  listen(target, type, listener, options, suspendable = true) {
    if (!target?.addEventListener || typeof listener !== "function") return () => {};
    let attached = false;
    const attach = () => {
      if (attached || this.closed || (suspendable && this.suspended)) return;
      target.addEventListener(type, listener, options);
      attached = true;
    };
    const detach = () => {
      if (!attached) return;
      target.removeEventListener(type, listener, options);
      attached = false;
    };
    attach();
    this.stats.listeners++;
    this._add({ suspend: suspendable ? detach : null, resume: suspendable ? attach : null, cleanup: detach });
    return detach;
  }

  observe(observer, target, options, suspendable = true) {
    if (!observer?.observe || !target) return observer;
    let attached = false;
    const attach = () => {
      if (attached || this.closed || (suspendable && this.suspended)) return;
      observer.observe(target, options);
      attached = true;
    };
    const detach = () => {
      if (!attached) return;
      observer.disconnect();
      attached = false;
    };
    attach();
    this.stats.observers++;
    this._add({ suspend: suspendable ? detach : null, resume: suspendable ? attach : null, cleanup: detach });
    return observer;
  }

  setTimeout(callback, delay = 0, suspendable = true) {
    if (typeof callback !== "function") return () => {};
    const schedule = this.scheduler?.setTimeout?.bind(this.scheduler) || globalThis.setTimeout;
    const clear = this.scheduler?.clearTimeout?.bind(this.scheduler) || globalThis.clearTimeout;
    let handle = null;
    let active = true;
    const stop = () => {
      if (handle !== null) clear(handle);
      handle = null;
    };
    const start = () => {
      if (!active || handle !== null || this.closed || (suspendable && this.suspended)) return;
      handle = schedule(() => {
        handle = null;
        if (!active || this.closed) return;
        active = false;
        callback();
      }, delay);
    };
    const cleanup = () => {
      active = false;
      stop();
    };
    start();
    this.stats.timeouts++;
    this._add({ suspend: suspendable ? stop : null, resume: suspendable ? start : null, cleanup });
    return cleanup;
  }

  setInterval(callback, delay = 0, suspendable = true) {
    if (typeof callback !== "function") return () => {};
    const schedule = this.scheduler?.setInterval?.bind(this.scheduler) || globalThis.setInterval;
    const clear = this.scheduler?.clearInterval?.bind(this.scheduler) || globalThis.clearInterval;
    let handle = null;
    let active = true;
    const stop = () => {
      if (handle !== null) clear(handle);
      handle = null;
    };
    const start = () => {
      if (!active || handle !== null || this.closed || (suspendable && this.suspended)) return;
      handle = schedule(() => {
        if (active && !this.closed) callback();
      }, delay);
    };
    const cleanup = () => {
      active = false;
      stop();
    };
    start();
    this.stats.intervals++;
    this._add({ suspend: suspendable ? stop : null, resume: suspendable ? start : null, cleanup });
    return cleanup;
  }

  requestAnimationFrame(callback, suspendable = true) {
    if (typeof callback !== "function") return () => {};
    const request = this.scheduler?.requestAnimationFrame?.bind(this.scheduler) || ((fn) => globalThis.setTimeout(() => fn(Date.now()), 16));
    const cancel = this.scheduler?.cancelAnimationFrame?.bind(this.scheduler) || globalThis.clearTimeout;
    let handle = null;
    let active = true;
    const stop = () => {
      if (handle !== null) cancel(handle);
      handle = null;
    };
    const start = () => {
      if (!active || handle !== null || this.closed || (suspendable && this.suspended)) return;
      handle = request((timestamp) => {
        handle = null;
        if (!active || this.closed) return;
        active = false;
        callback(timestamp);
      });
    };
    const cleanup = () => {
      active = false;
      stop();
    };
    start();
    this.stats.animationFrames++;
    this._add({ suspend: suspendable ? stop : null, resume: suspendable ? start : null, cleanup });
    return cleanup;
  }

  track(resource) {
    if (!resource) return resource;
    const normalized = typeof resource === "function" ? { cleanup: resource } : resource;
    this.stats.custom++;
    this._add(normalized);
    return resource;
  }

  suspend() {
    if (this.closed || this.suspended) return false;
    this.suspended = true;
    for (const resource of this.resources) {
      try { resource.suspend?.(); } catch (error) {}
    }
    this.stats.suspends++;
    return true;
  }

  resume() {
    if (this.closed || !this.suspended) return false;
    this.suspended = false;
    for (const resource of this.resources) {
      try { resource.resume?.(); } catch (error) {}
    }
    this.stats.resumes++;
    return true;
  }

  cleanup() {
    if (this.closed) return false;
    this.closed = true;
    for (let index = this.resources.length - 1; index >= 0; index--) {
      try { this.resources[index].cleanup?.(); } catch (error) {}
    }
    this.resources.length = 0;
    return true;
  }

  getStats() {
    return { ...this.stats, name: this.name, closed: this.closed, suspended: this.suspended, resources: this.resources.length };
  }
}

module.exports = { RuntimeScope };
