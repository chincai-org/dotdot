"use strict";

// Minimal fake DOM for running main.js under Node. Only the pieces main.js
// touches are implemented; drawing calls are recorded nowhere and cost only
// a function call.

class ClassList {
  constructor() {
    this.items = new Set();
  }

  add(...names) {
    for (const name of names) {
      this.items.add(name);
    }
  }

  remove(...names) {
    for (const name of names) {
      this.items.delete(name);
    }
  }

  toggle(name, force) {
    const on = force === undefined ? !this.items.has(name) : Boolean(force);
    if (on) {
      this.items.add(name);
    } else {
      this.items.delete(name);
    }
    return on;
  }

  contains(name) {
    return this.items.has(name);
  }
}

class Style {
  constructor() {
    this.values = new Map();
  }

  setProperty(name, value) {
    this.values.set(name, value);
  }

  getPropertyValue(name) {
    return this.values.get(name) ?? "";
  }
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = new Style();
    this.classList = new ClassList();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.value = "";
    this.min = "";
    this.max = "";
    this.disabled = false;
    this.clientWidth = 1000;
    this.clientHeight = 800;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.rect = { left: 0, top: 0, width: 1000, height: 800 };
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener() {}

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  replaceChildren(...nodes) {
    for (const node of this.children) {
      node.parentNode = null;
    }
    this.children = nodes;
    for (const node of nodes) {
      node.parentNode = this;
    }
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
    }
    this.children.push(...nodes);
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  prepend(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
    }
    this.children.unshift(...nodes);
  }

  remove() {
    const parent = this.parentNode;
    if (parent === null || parent === undefined) {
      return;
    }
    const index = parent.children.indexOf(this);
    if (index !== -1) {
      parent.children.splice(index, 1);
    }
    this.parentNode = null;
  }

  closest() {
    return null;
  }

  focus() {
    globalThis.document.activeElement = this;
    for (const fn of this.listeners.get("focus") ?? []) {
      fn({ target: this });
    }
  }

  blur() {
    if (globalThis.document.activeElement === this) {
      globalThis.document.activeElement = null;
    }
    for (const fn of this.listeners.get("blur") ?? []) {
      fn({ target: this });
    }
  }

  getContext() {
    return makeContext();
  }

  get valueAsNumber() {
    return Number(this.value);
  }
}

class HTMLInputElement extends Element {}
class HTMLButtonElement extends Element {}
class HTMLTextAreaElement extends Element {}
class HTMLElement extends Element {}
class HTMLCanvasElement extends Element {}

function makeContext() {
  const noop = () => {};
  return {
    canvas: null,
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    strokeStyle: "#000",
    fillStyle: "#000",
    setTransform: noop,
    clearRect: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    drawImage: noop,
  };
}

class Path2D {
  moveTo() {}
  lineTo() {}
  arc() {}
}

function makeElement(tag) {
  if (tag === "canvas") {
    const canvas = new HTMLCanvasElement(tag);
    canvas.width = 300;
    canvas.height = 150;
    return canvas;
  }
  if (tag === "input") {
    return new HTMLInputElement(tag);
  }
  if (tag === "button") {
    return new HTMLButtonElement(tag);
  }
  if (tag === "textarea") {
    return new HTMLTextAreaElement(tag);
  }
  return new HTMLElement(tag);
}

function install() {
  const elements = new Map();
  const ids = [
    "board", "status", "undo", "clear", "players", "players-dec",
    "players-inc", "board-size", "board-dec", "board-inc", "board-wrap",
    "board-spacer", "coord-x", "coord-y", "hud", "controls", "controls-tab",
    "scores", "scores-tab", "leader-dot", "scores-list", "leader-line",
    "history", "history-tab", "history-line", "history-list",
    "prefs", "prefs-open", "prefs-close", "prefs-reset", "prefs-error",
    "theme-system-note", "binding-up", "binding-down", "binding-left",
    "binding-right", "binding-place", "binding-undo", "binding-pan-up",
    "binding-pan-down", "binding-pan-left", "binding-pan-right",
  ];
  for (const id of ids) {
    const tag = id === "board" ? "canvas" : "div";
    const el = makeElement(tag);
    if (id === "board") {
      el.rect = { left: 0, top: 0, width: 1000, height: 800 };
    }
    elements.set(id, el);
  }

  // Inputs need input-like tags for instanceof checks in key handlers.
  for (const id of ["players", "board-size", "coord-x", "coord-y",
    "theme-system", "theme-light", "theme-dark"]) {
    const el = makeElement("input");
    el.id = id;
    elements.set(id, el);
  }
  for (const id of ["undo", "clear", "players-dec", "players-inc",
    "board-dec", "board-inc", "controls-tab", "scores-tab", "history-tab",
    "prefs-open", "prefs-close", "prefs-reset", "binding-up",
    "binding-down", "binding-left", "binding-right", "binding-place",
    "binding-undo", "binding-pan-up", "binding-pan-down", "binding-pan-left",
    "binding-pan-right"]) {
    const el = makeElement("button");
    el.id = id;
    elements.set(id, el);
  }

  const document = {
    activeElement: null,
    body: makeElement("body"),
    listeners: new Map(),
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    createElement(tag) {
      return makeElement(tag);
    },
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    },
  };

  const window = {
    devicePixelRatio: 1,
    addEventListener() {},
  };

  const sandbox = {
    document,
    window,
    Element,
    HTMLElement,
    HTMLInputElement,
    HTMLButtonElement,
    HTMLTextAreaElement,
    HTMLCanvasElement,
    Path2D,
    requestAnimationFrame(cb) {
      return cb();
    },
    cancelAnimationFrame() {},
    getComputedStyle() {
      return { flexDirection: "row" };
    },
    console,
    Math,
    Number,
    Array,
    Map,
    Set,
    Uint8Array,
    Uint32Array,
    Int8Array,
    Int32Array,
    Float64Array,
    Object,
    String,
    Boolean,
    Error,
    JSON,
    Infinity,
    NaN,
    isFinite,
    parseInt,
    parseFloat,
  };
  sandbox.globalThis = sandbox;

  return { sandbox, elements, document, window };
}

module.exports = { install, makeElement, Element, Path2D };
