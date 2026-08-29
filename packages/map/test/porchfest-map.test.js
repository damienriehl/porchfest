/* global AbortController, setImmediate */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "vitest";

const scriptPath = path.join(
  import.meta.dirname,
  "..",
  "assets",
  "porchfest-map.js",
);
const scriptSource = fs.readFileSync(scriptPath, "utf8");
const instrumentedScriptSource = scriptSource.replace(
  /\n\}\)\(\);\s*$/,
  `
  window.__porchfestMapTest = {
    venueKey: typeof venueKey === 'function' ? venueKey : undefined,
    genreTags: typeof genreTags === 'function' ? genreTags : undefined,
    applyView: typeof applyView === 'function' ? applyView : undefined,
    getViewState: function () {
      return typeof viewState === 'undefined' ? undefined : viewState;
    },
    getMap: function () {
      return typeof map === 'undefined' ? undefined : map;
    },
    getMarkersByVenueKey: function () {
      return typeof markersByVenueKey === 'undefined' ? undefined : markersByVenueKey;
    },
    layoutVenueCards: typeof layoutVenueCards === 'function' ? layoutVenueCards : undefined,
    scheduleVenueLayout: typeof scheduleVenueLayout === 'function' ? scheduleVenueLayout : undefined
  };
})();`,
);
assert.notStrictEqual(
  instrumentedScriptSource,
  scriptSource,
  "Test harness failed to inject window.__porchfestMapTest into porchfest-map.js",
);
const stylesheetPath = path.join(
  import.meta.dirname,
  "..",
  "assets",
  "porchfest-map.css",
);
const stylesheetSource = fs.readFileSync(stylesheetPath, "utf8");
const FALLBACK =
  "The interactive map could not be loaded. Please refresh the page and try again.";
const EMPTY_STATE =
  "The 2026 lineup is not on the interactive map yet. Please check back soon.";
const ALL_HOURS = "";
const DEFAULT_SLOT_LABELS_BY_ID = {
  "6-7": "6–7 pm",
  "7-8": "7–8 pm",
  "6-8": "6–8 pm",
};

class TestStyle {
  constructor() {
    this.position = "";
    this.height = "";
    this.width = "";
    this.left = "";
    this.top = "";
  }

  removeProperty(name) {
    this[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = "";
  }
}

class TestNode {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName ? String(tagName).toUpperCase() : "";
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.tabIndex = -1;
    this.clientWidth = 0;
    this.offsetHeight = 0;
    this.style = new TestStyle();
    this._text = "";
    this._listeners = {};
    this.classList = {
      add: (...tokens) => {
        const classes = this.className.split(/\s+/).filter(Boolean);
        tokens.forEach((token) => {
          if (!classes.includes(token)) classes.push(token);
        });
        this.className = classes.join(" ");
      },
      remove: (...tokens) => {
        this.className = this.className
          .split(/\s+/)
          .filter((className) => className && !tokens.includes(className))
          .join(" ");
      },
      toggle: (token, force) => {
        const shouldAdd =
          force === undefined
            ? !this.classList.contains(token)
            : Boolean(force);
        if (shouldAdd) this.classList.add(token);
        else this.classList.remove(token);
        return shouldAdd;
      },
      contains: (token) => this.className.split(/\s+/).includes(token),
    };
  }

  appendChild(child) {
    return this.insertBefore(child, null);
  }

  // The module under test positions the filter controls with
  // parentNode.insertBefore, so this fake has to honour real insertion semantics:
  // a null reference appends, and an already-attached node moves rather than
  // duplicating. appendChild is the reference-less case of exactly this.
  insertBefore(child, reference) {
    // Validate before mutating, like the DOM pre-insert algorithm. Appending on a
    // bad reference would let a production insertBefore that a browser rejects
    // outright still produce a plausible tree here, so most of the suite would stay
    // green while the real page rendered nothing but the error state.
    const referenceIndex =
      reference == null ? -1 : this.children.indexOf(reference);
    if (reference != null && referenceIndex === -1) {
      throw new Error("NotFoundError: reference is not a child of this node");
    }
    // "If referenceChild is node, set referenceChild to node's next sibling."
    // Without this, inserting a node before itself relocates it to the end.
    const target =
      reference === child
        ? this.children[referenceIndex + 1] || null
        : reference;

    if (child.tagName === "#FRAGMENT") {
      child.children
        .slice()
        .forEach((fragmentChild) => this.insertBefore(fragmentChild, target));
      child.children = [];
      return child;
    }
    if (child.parentNode) {
      const oldIndex = child.parentNode.children.indexOf(child);
      if (oldIndex !== -1) child.parentNode.children.splice(oldIndex, 1);
    }
    child.parentNode = this;
    const at = target == null ? -1 : this.children.indexOf(target);
    if (at === -1) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  addEventListener(type, listener) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  }

  dispatchEvent(event) {
    event.target = this;
    (this._listeners[event.type] || []).forEach((listener) =>
      listener.call(this, event),
    );
  }

  querySelector(selector) {
    return findAll(this, selector)[0] || null;
  }

  querySelectorAll(selector) {
    return findAll(this, selector);
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  get textContent() {
    return (
      this._text + this.children.map((child) => child.textContent).join("")
    );
  }
}

class TestDocument {
  constructor() {
    this.readyState = "complete";
    this.root = new TestNode("body", this);
  }

  createElement(tagName) {
    return new TestNode(tagName, this);
  }

  createElementNS(namespace, tagName) {
    const node = new TestNode(tagName, this);
    node.namespaceURI = namespace;
    return node;
  }

  createTextNode(value) {
    const node = new TestNode("#text", this);
    node._text = String(value);
    return node;
  }

  createDocumentFragment() {
    return new TestNode("#fragment", this);
  }

  querySelector(selector) {
    return this.root.querySelector(selector);
  }

  addEventListener() {}
}

function hasClass(node, className) {
  return node.className.split(/\s+/).includes(className);
}

function matches(node, selector) {
  const attributeMatches = Array.from(
    selector.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g),
  );
  const withoutAttributes = selector.replace(/\[[^\]]+\]/g, "");
  const parts = withoutAttributes.split(".");
  const tagName = parts.shift();

  if (tagName && node.tagName !== tagName.toUpperCase()) return false;
  if (!parts.every((className) => hasClass(node, className))) return false;
  return attributeMatches.every((match) => {
    const name = match[1];
    const expected = match[2];
    let actual;
    if (name.startsWith("data-")) {
      const datasetName = name
        .slice(5)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      actual = node.dataset[datasetName];
    } else {
      actual = node.getAttribute(name);
    }
    return expected === undefined
      ? actual !== undefined && actual !== null
      : String(actual) === expected;
  });
}

function findAll(root, selector) {
  const matchesFound = [];
  function visit(node) {
    node.children.forEach((child) => {
      if (matches(child, selector)) matchesFound.push(child);
      visit(child);
    });
  }
  visit(root);
  return matchesFound;
}

function buildMount(document) {
  const mount = document.createElement("div");
  mount.className = "porchfest-map-mount";

  const fullbleed = document.createElement("div");
  fullbleed.className = "porchfest-map-fullbleed";

  const status = document.createElement("p");
  status.className = "porchfest-map-status is-loading";
  status.textContent = "Loading the 2026 interactive map and lineup…";

  const mapElement = document.createElement("div");
  mapElement.className = "porchfest-map-canvas";
  mapElement.hidden = true;

  const listSection = document.createElement("section");
  listSection.className = "porchfest-venue-list";
  listSection.hidden = true;
  const list = document.createElement("ol");
  list.className = "porchfest-venue-list-items";
  listSection.appendChild(list);

  fullbleed.appendChild(status);
  fullbleed.appendChild(mapElement);
  mount.appendChild(fullbleed);
  mount.appendChild(listSection);
  document.root.appendChild(mount);
  return { mount, fullbleed, status, mapElement, listSection, list };
}

function createLeaflet(document) {
  const records = {
    maps: [],
    markers: [],
    tileLayers: [],
    bounds: [],
  };

  const L = {
    map(element, options) {
      const map = {
        element,
        options,
        removed: false,
        hasView: false,
        fitBoundsArgs: null,
        flyToCalls: [],
        invalidateSizeCalls: 0,
        listeners: {},
        onceCalls: [],
        onceListeners: {},
        fitBounds(bounds, fitOptions) {
          this.hasView = true;
          this.fitBoundsArgs = { bounds, options: fitOptions };
          return this;
        },
        setView() {
          this.hasView = true;
          return this;
        },
        flyTo(coordinates, zoom, flyOptions) {
          this.flyToCalls.push({ coordinates, zoom, options: flyOptions });
          return this;
        },
        on(type, listener) {
          if (!this.listeners[type]) this.listeners[type] = [];
          this.listeners[type].push(listener);
          return this;
        },
        once(type, listener) {
          this.onceCalls.push({ type, handler: listener });
          if (!this.onceListeners[type]) this.onceListeners[type] = [];
          this.onceListeners[type].push(listener);
          return this.on(type, listener);
        },
        off(type, listener) {
          if (!this.listeners[type]) return this;
          this.listeners[type] = this.listeners[type].filter(
            (candidate) => candidate !== listener,
          );
          this.onceListeners[type] = (this.onceListeners[type] || []).filter(
            (candidate) => candidate !== listener,
          );
          return this;
        },
        fire(type) {
          (this.listeners[type] || []).slice().forEach((listener) => {
            if ((this.onceListeners[type] || []).includes(listener))
              this.off(type, listener);
            listener.call(this);
          });
          return this;
        },
        invalidateSize() {
          this.invalidateSizeCalls += 1;
          this.fire("resize");
          return this;
        },
        remove() {
          this.removed = true;
        },
      };
      records.maps.push(map);
      return map;
    },
    tileLayer(url, options) {
      const layer = {
        url,
        options,
        addTo(map) {
          this.map = map;
          return this;
        },
      };
      records.tileLayers.push(layer);
      return layer;
    },
    latLngBounds(initial) {
      const bounds = {
        initial,
        points: [],
        extend(point) {
          this.points.push(point);
        },
      };
      records.bounds.push(bounds);
      return bounds;
    },
    divIcon(options) {
      return { options };
    },
    marker(coordinates, options) {
      const element = document.createElement("a");
      const marker = {
        coordinates,
        options,
        element,
        popupFactory: null,
        popupOptions: null,
        popup: null,
        openPopupCalls: 0,
        addTo(map) {
          this.map = map;
          return this;
        },
        getElement() {
          return this.map && this.map.hasView ? element : null;
        },
        bindPopup(factory, popupOptions) {
          this.popupFactory = factory;
          this.popupOptions = popupOptions;
          this.popup = {
            options: popupOptions,
            updateCalls: 0,
            isOpen() {
              return marker.openPopupCalls > 0;
            },
            update() {
              this.updateCalls += 1;
            },
          };
          return this;
        },
        getPopup() {
          return this.popup;
        },
        openPopup() {
          this.openPopupCalls += 1;
          this.openedContent = this.popupFactory();
          return this;
        },
      };
      records.markers.push(marker);
      return marker;
    },
  };

  return { L, records };
}

function response(payload, options = {}) {
  return {
    ok: options.ok !== false,
    json() {
      return options.jsonError
        ? Promise.reject(options.jsonError)
        : Promise.resolve(payload);
    },
  };
}

function venue(overrides = {}) {
  const result = Object.assign(
    {
      title: "Garden Stage",
      address: "100 Festival Ave",
      lat: 44.98,
      lng: -93.19,
      schedule: "6–8 pm",
      acts: [
        {
          slot: "6-8",
          slot_label: "6–8 pm",
          name: "The Neighbors",
          genre: "Folk",
          description: "Songs from down the block.",
          links: [{ label: "Band site", url: "https://example.com/band" }],
          note: "All ages",
        },
      ],
    },
    overrides,
  );
  result.acts = result.acts.map((act) => ({
    slot_label: DEFAULT_SLOT_LABELS_BY_ID[act.slot] || act.slot,
    ...act,
  }));
  return result;
}

async function settlePromises() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function runScript(options = {}) {
  const document = new TestDocument();
  const nodes = buildMount(document);
  const leaflet = createLeaflet(document);
  const timers = [];
  const clearedTimers = [];
  const animationFrames = [];
  const windowListeners = {};
  const window = {
    innerWidth: options.innerWidth || 1024,
    location: { href: "https://sapporchfest.org/map/" },
    fetch: Object.prototype.hasOwnProperty.call(options, "fetch")
      ? options.fetch
      : () => Promise.resolve(response({ venues: [venue()] })),
    L: Object.prototype.hasOwnProperty.call(options, "L")
      ? options.L
      : leaflet.L,
    AbortController: Object.prototype.hasOwnProperty.call(
      options,
      "AbortController",
    )
      ? options.AbortController
      : AbortController,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout(id) {
      clearedTimers.push(id);
    },
    addEventListener(type, listener) {
      if (!windowListeners[type]) windowListeners[type] = [];
      windowListeners[type].push(listener);
    },
    dispatchEvent(event) {
      (windowListeners[event.type] || []).forEach((listener) =>
        listener.call(window, event),
      );
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    matchMedia(query) {
      return {
        matches: query === "(max-width: 768px)" && this.innerWidth <= 768,
      };
    },
    getComputedStyle() {
      return { columnGap: "16px" };
    },
  };

  const context = vm.createContext({
    AbortController,
    URL: options.URLClass || URL,
    console,
    document,
    window,
    L: window.L,
  });
  vm.runInContext(instrumentedScriptSource, context, { filename: scriptPath });
  await settlePromises();
  while (animationFrames.length) animationFrames.shift()();
  return {
    document,
    nodes,
    leaflet,
    timers,
    clearedTimers,
    animationFrames,
    window,
    windowListeners,
    testApi: window.__porchfestMapTest,
  };
}

function flushAnimationFrames(run) {
  while (run.animationFrames.length) run.animationFrames.shift()();
}

function assertFailure(nodes) {
  assert.equal(nodes.status.hidden, false);
  assert.equal(nodes.status.className, "porchfest-map-status is-error");
  assert.equal(nodes.status.textContent, FALLBACK);
  assert.equal(nodes.mapElement.hidden, true);
  assert.equal(nodes.listSection.hidden, true);
  assert.equal(
    nodes.mount.querySelectorAll(".porchfest-map-controls").length,
    0,
  );
  assert.equal(
    nodes.mount.querySelectorAll(".porchfest-genre-facet").length,
    0,
  );
}

function applyFilters(run, venues, hour, genre) {
  const state = run.testApi.getViewState();
  state.hour = hour;
  state.genre = genre;
  run.testApi.applyView(
    run.nodes.status,
    run.nodes.listSection,
    venues,
    run.testApi.getMarkersByVenueKey(),
  );
}

function assertViewClasses(node, expected) {
  assert.equal(node.classList.contains("is-match"), expected === "match");
  assert.equal(node.classList.contains("is-dimmed"), expected === "dimmed");
  assert.equal(
    node.classList.contains("is-collapsed"),
    expected === "collapsed",
  );
}

function cssToken(name) {
  const match = stylesheetSource.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  assert.ok(match, `expected ${name} in the stylesheet`);
  return match[1].trim();
}

function hexChannels(hex) {
  const value = hex.replace("#", "");
  assert.match(value, /^[0-9a-f]{6}$/i);
  return [0, 2, 4].map((offset) =>
    parseInt(value.slice(offset, offset + 2), 16),
  );
}

function mixSrgb(from, to, toWeight) {
  const fromChannels = hexChannels(from);
  const toChannels = hexChannels(to);
  return fromChannels.map(
    (channel, index) => channel * (1 - toWeight) + toChannels[index] * toWeight,
  );
}

function relativeLuminance(color) {
  const channels = Array.isArray(color) ? color : hexChannels(color);
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

test("collapsed cards and dimmed markers never fade their subtrees with opacity or filters", () => {
  const stylesheetRules = Array.from(
    stylesheetSource.matchAll(/([^{}]+)\{([^{}]*)\}/g),
  );
  const cardRules = stylesheetRules.filter((rule) =>
    rule[1].includes(".porchfest-venue-card"),
  );

  assert.ok(
    cardRules.some((rule) =>
      rule[1].includes(".porchfest-venue-card.is-collapsed"),
    ),
  );
  cardRules.forEach((rule) => {
    assert.doesNotMatch(rule[2], /(?:^|[;\s])opacity\s*:/i);
    assert.doesNotMatch(rule[2], /(?:^|[;\s])filter\s*:/i);
  });

  const dimmedMarkerRules = stylesheetRules.filter((rule) =>
    rule[1].includes(".porchfest-marker-shell.is-dimmed"),
  );
  assert.ok(dimmedMarkerRules.length > 0);
  dimmedMarkerRules.forEach((rule) => {
    assert.doesNotMatch(rule[2], /(?:^|[;\s])opacity\s*:/i);
    assert.doesNotMatch(rule[2], /(?:^|[;\s])filter\s*:/i);
  });
  assert.doesNotMatch(stylesheetSource, /\.porchfest-venue-card\.is-dimmed/);
});

test("the stylesheet keeps one organizer-tunable fade factor for the pin and collapsed band", () => {
  const definitions = Array.from(
    stylesheetSource.matchAll(/--porchfest-filter-fade\s*:\s*([^;]+);/g),
  );
  const fadeWeight = parseFloat(definitions[0] && definitions[0][1]) / 100;
  const fadedPin = mixSrgb(
    cssToken("--color-accent"),
    cssToken("--color-bg"),
    fadeWeight,
  );

  assert.equal(definitions.length, 1);
  assert.match(definitions[0][1], /^\s*\d+(?:\.\d+)?%\s*$/);
  assert.ok(fadeWeight >= 0.75);
  assert.ok(contrastRatio(fadedPin, cssToken("--color-bg")) >= 1.3);
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-collapsed \.porchfest-venue-band\s*\{[^}]*var\(--porchfest-filter-fade\)/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-marker-shell\.is-dimmed \.porchfest-marker-pin\s*\{[^}]*color-mix\([^}]*var\(--porchfest-filter-fade\)/s,
  );
});

test("collapsed card CSS keeps an auto-height band above a smaller clipped performer peek", () => {
  const cardRule = stylesheetSource.match(
    /\.porchfest-venue-card\s*\{([^}]*)\}/,
  );
  const collapsedRule = stylesheetSource.match(
    /\.porchfest-venue-card\.is-collapsed\s*\{([^}]*)\}/,
  );
  const expandedActsRule = stylesheetSource.match(
    /\.porchfest-venue-card \.porchfest-venue-acts\s*\{([^}]*)\}/,
  );
  const actsRule = stylesheetSource.match(
    /\.porchfest-venue-card\.is-collapsed \.porchfest-venue-acts\s*\{([^}]*)\}/,
  );

  assert.ok(cardRule);
  assert.ok(collapsedRule);
  assert.ok(expandedActsRule);
  assert.ok(actsRule);
  assert.ok(
    parseFloat(collapsedRule[1].match(/min-height:\s*([\d.]+)px/)[1]) >= 44,
  );
  assert.match(cardRule[1], /overflow:\s*hidden/);
  assert.doesNotMatch(collapsedRule[1], /max-height:/);
  const expandedMaxHeight =
    parseFloat(expandedActsRule[1].match(/max-height:\s*([\d.]+)rem/)[1]) * 16;
  const collapsedMaxHeight = parseFloat(
    actsRule[1].match(/max-height:\s*([\d.]+)px/)[1],
  );
  assert.ok(collapsedMaxHeight < expandedMaxHeight);
  assert.ok(collapsedMaxHeight >= 24 && collapsedMaxHeight <= 28);
  assert.match(actsRule[1], /overflow:\s*hidden/);
  assert.match(
    actsRule[1],
    /(?:-webkit-)?mask-image:\s*linear-gradient\(\s*to bottom,/s,
  );
  assert.match(actsRule[1], /transparent/);
  assert.doesNotMatch(collapsedRule[1], /(?:^|[;\s])opacity\s*:/i);
});

test("venue band CSS has no obsolete schedule selector", () => {
  assert.doesNotMatch(stylesheetSource, /porchfest-venue-schedule/);
});

test("collapsed card CSS keeps the map control at least 44px in both dimensions", () => {
  const controlRule = stylesheetSource.match(
    /\.porchfest-venue-card\.is-collapsed \.porchfest-show-on-map\s*\{([^}]*)\}/,
  );

  assert.ok(controlRule);
  assert.ok(
    parseFloat(controlRule[1].match(/min-width:\s*([\d.]+)px/)[1]) >= 44,
  );
  assert.ok(
    parseFloat(controlRule[1].match(/min-height:\s*([\d.]+)px/)[1]) >= 44,
  );
});

test("venue band CSS puts the map control beside the title at every viewport", () => {
  const baseBandRule = stylesheetSource.match(
    /\.porchfest-venue-band\s*\{([^}]*)\}/,
  );
  const baseTitleRule = stylesheetSource.match(
    /\.porchfest-venue-band \.porchfest-venue-title\s*\{([^}]*)\}/,
  );
  const baseAddressRule = stylesheetSource.match(
    /\.porchfest-venue-band \.porchfest-venue-address\s*\{([^}]*)\}/,
  );
  const baseControlRule = stylesheetSource.match(
    /\.porchfest-show-on-map\s*\{([^}]*)\}/,
  );
  const bandRule = stylesheetSource.match(
    /\.porchfest-venue-card\.is-collapsed \.porchfest-venue-band\s*\{([^}]*)\}/,
  );
  const titleRule = stylesheetSource.match(
    /\.porchfest-venue-card\.is-collapsed \.porchfest-venue-title\s*\{([^}]*)\}/,
  );
  const addressRule = stylesheetSource.match(
    /\.porchfest-venue-card\.is-collapsed \.porchfest-venue-address\s*\{([^}]*)\}/,
  );
  const controlRule = stylesheetSource.match(
    /\.porchfest-venue-card\.is-collapsed \.porchfest-show-on-map\s*\{([^}]*)\}/,
  );

  assert.ok(baseBandRule);
  assert.ok(baseTitleRule);
  assert.ok(baseAddressRule);
  assert.ok(baseControlRule);
  assert.match(baseBandRule[1], /display:\s*grid/);
  assert.match(
    baseBandRule[1],
    /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/,
  );
  assert.match(baseBandRule[1], /align-items:\s*start/);
  assert.match(baseTitleRule[1], /grid-column:\s*1/);
  assert.match(baseTitleRule[1], /grid-row:\s*1/);
  assert.match(baseAddressRule[1], /grid-column:\s*1/);
  assert.match(baseAddressRule[1], /grid-row:\s*2/);
  assert.match(baseAddressRule[1], /min-width:\s*0/);
  assert.match(baseControlRule[1], /grid-column:\s*2/);
  assert.match(baseControlRule[1], /grid-row:\s*1/);
  assert.match(baseControlRule[1], /align-self:\s*start/);
  assert.match(baseControlRule[1], /margin-top:\s*0/);
  assert.ok(bandRule);
  assert.ok(titleRule);
  assert.ok(addressRule);
  assert.ok(controlRule);
  assert.match(bandRule[1], /padding:\s*0\.35rem 0\.5rem/);
  assert.match(addressRule[1], /margin-bottom:\s*0/);
  assert.match(controlRule[1], /margin-top:\s*0/);
  assert.match(
    controlRule[1],
    /border:\s*1px solid var\(--color-text-secondary\)/,
  );
  assert.match(controlRule[1], /color:\s*var\(--color-text-secondary\)/);
  assert.match(controlRule[1], /background:\s*transparent/);
  assert.doesNotMatch(controlRule[1], /var\(--color-accent(?:-ink)?\)/);
});

test("collapsed card CSS expands for focus and disables motion when requested", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-collapsed:focus-within \.porchfest-venue-acts\s*\{[^}]*max-height:\s*100rem[^}]*mask-image:\s*none/s,
  );
  assert.match(
    stylesheetSource,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.porchfest-venue-card \.porchfest-venue-acts\s*\{[^}]*transition:\s*none/s,
  );
});

test("single-column cards use normal-flow margins with a smaller collapsed gap", () => {
  const listRule = stylesheetSource.match(
    /@media\s*\(max-width:\s*768px\)[\s\S]*?\.porchfest-venue-list-items\s*\{([^}]*)\}/,
  );
  const normalGapRule = stylesheetSource.match(
    /\.porchfest-venue-card\s*\+\s*\.porchfest-venue-card\s*\{([^}]*)\}/,
  );
  const stackRule = stylesheetSource.match(
    /\.porchfest-venue-card\.is-collapsed\s*\+\s*\.porchfest-venue-card\.is-collapsed\s*\{([^}]*)\}/,
  );

  assert.ok(listRule);
  assert.ok(normalGapRule);
  assert.ok(stackRule);
  assert.match(listRule[1], /column-gap:\s*0/);
  assert.match(normalGapRule[1], /margin-top:\s*1rem\s*!important/);
  assert.match(stackRule[1], /margin-top:\s*0\.5rem\s*!important/);
  assert.doesNotMatch(stackRule[1], /margin[^:]*:\s*-/);
});

test("matching cards and marker pins receive distinct accent treatments", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-match\s*\{[^}]*border-color:\s*var\(--color-accent-ink\)[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-marker-shell\.is-match \.porchfest-marker-pin\s*\{[^}]*transform:[^;}]*scale\(/s,
  );
});

test("neutral venue bands use the existing dark-ground and light-text tokens", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-band\s*\{[^}]*background:\s*var\(--color-bg-dark\)[^}]*color:\s*var\(--color-text-light\)/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-band \.porchfest-venue-title\s*\{[^}]*color:\s*var\(--color-heading-light\)/s,
  );
  assert.ok(
    contrastRatio(
      cssToken("--color-bg-dark"),
      cssToken("--color-text-light"),
    ) >= 4.5,
  );
});

test("matched venue bands use the AA terracotta ink token with white text", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-match \.porchfest-venue-band\s*\{[^}]*background:\s*var\(--color-accent-ink\)[^}]*color:\s*var\(--color-text-light\)/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-match \.porchfest-venue-band \.porchfest-venue-title,[^{]*\.porchfest-venue-address,[^{]*\.porchfest-venue-band strong\s*\{[^}]*color:\s*var\(--color-text-light\) !important/s,
  );
  assert.ok(contrastRatio(cssToken("--color-accent"), "#ffffff") < 4.5);
  assert.ok(contrastRatio(cssToken("--color-accent-ink"), "#ffffff") >= 4.5);
});

test("a collapsed venue band lightens past midpoint and flips to the dark text token at AA contrast", () => {
  const fadeWeight = parseFloat(cssToken("--porchfest-filter-fade")) / 100;
  const fadedBand = mixSrgb(
    cssToken("--color-bg-dark"),
    cssToken("--color-bg"),
    fadeWeight,
  );

  assert.ok(fadeWeight > 0.5);
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-collapsed \.porchfest-venue-band\s*\{[^}]*background:\s*color-mix\(\s*in srgb,\s*var\(--color-bg-dark\),\s*var\(--color-bg\) var\(--porchfest-filter-fade\)\s*\)[^}]*color:\s*var\(--color-text\)/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-collapsed \.porchfest-venue-band \.porchfest-venue-title,[^{]*\.porchfest-venue-address,[^{]*\.porchfest-venue-band strong\s*\{[^}]*color:\s*var\(--color-text\) !important/s,
  );
  assert.ok(contrastRatio(fadedBand, cssToken("--color-text")) >= 4.5);
});

test("the matched band replaces the now-redundant two-tone accent rail", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-match\s*\{[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-card\.is-match \.porchfest-venue-band\s*\{[^}]*var\(--color-accent-ink\)/s,
  );
});

test("the act region retains a light ground and dark text below the venue band", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-venue-acts\s*\{[^}]*background:\s*#fff[^}]*color:\s*var\(--color-text\)/s,
  );
});

test("Leaflet popup spacing lets the shared venue band reach the wrapper edges", () => {
  assert.match(
    stylesheetSource,
    /\.leaflet-popup-content-wrapper\s*\{[^}]*padding:\s*0[^}]*overflow:\s*hidden/s,
  );
  assert.match(
    stylesheetSource,
    /\.leaflet-popup-content\s*\{[^}]*margin:\s*0/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-map-popup\s*\{[^}]*padding:\s*0/s,
  );
});

test("source never uses innerHTML", () => {
  assert.doesNotMatch(
    scriptSource,
    /\.innerHTML\b|\[\s*['"]innerHTML['"]\s*\]/,
  );
});

test("re-appending an attached child moves it without changing the child count", () => {
  const document = new TestDocument();
  const parent = document.createElement("ol");
  const first = document.createElement("li");
  const second = document.createElement("li");
  parent.appendChild(first);
  parent.appendChild(second);

  parent.appendChild(first);

  assert.equal(parent.children.length, 2);
  assert.deepEqual(parent.children, [second, first]);
  assert.equal(first.parentNode, parent);
});

test("staggered relayout preserves the exact venue card node objects", async () => {
  const venues = [
    venue({ title: "First Stage", lat: 44.97 }),
    venue({ title: "Second Stage", lat: 44.98 }),
    venue({ title: "Third Stage", lat: 44.99 }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const cardsBefore = run.nodes.list.children.slice();

  run.testApi.scheduleVenueLayout(run.nodes.listSection);
  flushAnimationFrames(run);

  assert.deepEqual(run.nodes.list.children, cardsBefore);
  run.nodes.list.children.forEach((card, index) => {
    assert.equal(card, cardsBefore[index]);
  });
});

test("hour and genre filter changes each schedule a relayout", async () => {
  const venues = [
    venue({
      title: "Folk Stage",
      acts: [{ slot: "6-7", name: "Folk Act", genre: "Folk" }],
    }),
    venue({
      title: "Rock Stage",
      lat: 44.99,
      acts: [{ slot: "7-8", name: "Rock Act", genre: "Rock" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const hourButton = run.nodes.mount
    .querySelector(".porchfest-hour-control")
    .querySelectorAll("button")[1];
  const genreButton = run.nodes.mount
    .querySelector(".porchfest-genre-chips")
    .querySelectorAll("button")
    .find((button) => button.textContent === "Folk");

  hourButton.dispatchEvent({ type: "click" });
  assert.equal(run.animationFrames.length, 1);
  flushAnimationFrames(run);

  genreButton.dispatchEvent({ type: "click" });
  assert.equal(run.animationFrames.length, 1);
});

test("sort changes schedule a relayout after existing cards move", async () => {
  const run = await runScript({
    fetch: () =>
      Promise.resolve(
        response({
          venues: [
            venue({ lat: 44.97 }),
            venue({ title: "North Stage", lat: 44.99 }),
          ],
        }),
      ),
  });
  const cardsBefore = run.nodes.list.children.slice();
  const sortButton = run.nodes.mount.querySelector(".porchfest-sort-button");

  sortButton.dispatchEvent({ type: "click" });

  assert.equal(run.animationFrames.length, 1);
  assert.deepEqual(run.nodes.list.children, cardsBefore.slice().reverse());
});

test("focus entering and leaving the venue list each schedules a relayout", async () => {
  const run = await runScript();

  run.nodes.list.dispatchEvent({ type: "focusin" });
  assert.equal(run.animationFrames.length, 1);
  flushAnimationFrames(run);

  run.nodes.list.dispatchEvent({ type: "focusout" });
  assert.equal(run.animationFrames.length, 1);
});

test("max-height transition completion schedules one relayout and preserves card nodes", async () => {
  const venues = [venue(), venue({ title: "Second Stage", lat: 44.99 })];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const cardsBefore = run.nodes.list.children.slice();

  run.nodes.list.dispatchEvent({
    type: "transitionend",
    propertyName: "opacity",
  });
  assert.equal(run.animationFrames.length, 0);

  run.nodes.list.dispatchEvent({
    type: "transitionend",
    propertyName: "max-height",
  });
  run.nodes.list.dispatchEvent({
    type: "transitionend",
    propertyName: "max-height",
  });
  assert.equal(run.animationFrames.length, 1);
  flushAnimationFrames(run);

  assert.deepEqual(run.nodes.list.children, cardsBefore);
  run.nodes.list.children.forEach((card, index) => {
    assert.equal(card, cardsBefore[index]);
  });
});

test("single-column relayout clears every inline positioning style", async () => {
  const run = await runScript({
    fetch: () =>
      Promise.resolve(
        response({ venues: [venue(), venue({ title: "Second Stage" })] }),
      ),
  });

  assert.equal(run.nodes.list.style.position, "relative");
  assert.equal(run.nodes.list.children[0].style.position, "absolute");

  run.window.innerWidth = 600;
  run.nodes.list.dispatchEvent({ type: "focusin" });
  flushAnimationFrames(run);

  assert.equal(run.nodes.list.style.position, "");
  assert.equal(run.nodes.list.style.height, "");
  run.nodes.list.children.forEach((card) => {
    assert.equal(card.style.position, "");
    assert.equal(card.style.width, "");
    assert.equal(card.style.left, "");
    assert.equal(card.style.top, "");
  });
});

test("window resize relayout is debounced for 150ms", async () => {
  const run = await runScript();
  const timerCountBefore = run.timers.length;

  run.window.dispatchEvent({ type: "resize" });
  run.window.dispatchEvent({ type: "resize" });

  assert.equal(run.timers.length, timerCountBefore + 2);
  assert.equal(run.timers.at(-1).delay, 150);
  assert.ok(run.clearedTimers.length >= 2);
  run.timers.at(-1).callback();
  assert.equal(run.animationFrames.length, 1);
});

test("insertBefore matches real DOM semantics for the fake node tree", () => {
  // A gap here does not surface as a harness failure: the module calls insertBefore
  // inside init(), whose catch turns any throw into the generic error state.
  const parent = new TestNode("div");
  const a = new TestNode("a");
  const b = new TestNode("b");
  const c = new TestNode("c");
  parent.appendChild(a);
  parent.appendChild(c);

  assert.equal(parent.insertBefore(b, c), b);
  assert.deepEqual(parent.children, [a, b, c]);
  assert.equal(b.parentNode, parent);

  // a null reference appends, as in the real DOM
  const d = new TestNode("d");
  parent.insertBefore(d, null);
  assert.deepEqual(parent.children, [a, b, c, d]);

  // re-inserting an attached node moves it rather than duplicating it
  parent.insertBefore(d, a);
  assert.deepEqual(parent.children, [d, a, b, c]);
  assert.equal(parent.children.filter((child) => child === d).length, 1);

  // an existing parent releases the node
  const other = new TestNode("section");
  other.insertBefore(a, null);
  assert.equal(a.parentNode, other);
  assert.deepEqual(parent.children, [d, b, c]);

  // inserting a node before itself is a no-op, not a move to the end
  parent.insertBefore(d, d);
  assert.deepEqual(parent.children, [d, b, c]);

  // a reference that is not a child is rejected instead of silently appending
  assert.throws(
    () => parent.insertBefore(new TestNode("x"), other),
    /NotFoundError/,
  );

  // a fragment inserted before a reference keeps its children's relative order
  const fragment = new TestNode("#FRAGMENT");
  const f1 = new TestNode("f1");
  const f2 = new TestNode("f2");
  fragment.appendChild(f1);
  fragment.appendChild(f2);
  parent.insertBefore(fragment, c);
  assert.deepEqual(parent.children, [d, b, f1, f2, c]);
  assert.deepEqual(fragment.children, []);
  assert.equal(f1.parentNode, parent);
});

test("classList methods stay synchronized with className", () => {
  const node = new TestNode("div");
  node.className = "alpha";

  node.classList.add("beta");
  assert.equal(node.className, "alpha beta");
  assert.equal(node.classList.contains("beta"), true);
  assert.equal(node.classList.toggle("gamma"), true);
  assert.equal(node.className, "alpha beta gamma");
  assert.equal(node.classList.toggle("beta"), false);
  assert.equal(node.classList.contains("beta"), false);
  node.classList.remove("alpha");
  assert.equal(node.className, "gamma");
});

test("Leaflet map stub records flyTo coordinates and options", () => {
  const document = new TestDocument();
  const { L, records } = createLeaflet(document);
  const map = L.map(document.createElement("div"), {});
  const options = { duration: 0.5 };

  map.flyTo([44.98, -93.19], 17, options);

  assert.deepEqual(records.maps[0].flyToCalls, [
    {
      coordinates: [44.98, -93.19],
      zoom: 17,
      options,
    },
  ]);
});

test("Leaflet map stub fires once listeners exactly once", () => {
  const document = new TestDocument();
  const { L } = createLeaflet(document);
  const map = L.map(document.createElement("div"), {});
  let calls = 0;

  map.once("moveend", () => {
    calls += 1;
  });
  map.fire("moveend");
  map.fire("moveend");

  assert.equal(map.onceCalls.length, 1);
  assert.equal(map.onceCalls[0].type, "moveend");
  assert.equal(typeof map.onceCalls[0].handler, "function");
  assert.equal(calls, 1);
  assert.deepEqual(map.listeners.moveend, []);
});

test("venue keys distinguish matching titles at different coordinates", async () => {
  const { testApi } = await runScript();
  const first = venue({ title: "Shared Stage", lat: 44.98, lng: -93.19 });
  const second = venue({ title: "Shared Stage", lat: 44.99, lng: -93.18 });

  assert.notEqual(testApi.venueKey(first), testApi.venueKey(second));
});

test("venue keys remain stable when the lineup is reordered", async () => {
  const { testApi } = await runScript();
  const first = venue({ title: "First Stage" });
  const second = venue({ title: "Second Stage", lat: 44.99, lng: -93.18 });
  const venues = [first, second];
  const keyBefore = testApi.venueKey(first);

  venues.reverse();

  assert.equal(testApi.venueKey(first), keyBefore);
});

test("a reordered card resolves its marker through the venue-keyed lookup", async () => {
  const venues = [
    venue({ title: "First Stage" }),
    venue({ title: "Second Stage", lat: 44.99, lng: -93.18 }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const cards = run.nodes.list.querySelectorAll(".porchfest-venue-card");
  cards.reverse().forEach((card) => run.nodes.list.appendChild(card));
  const firstSortedCard = run.nodes.list.children[0];
  const lookup = run.testApi.getMarkersByVenueKey();

  assert.equal(run.testApi.getMap(), run.leaflet.records.maps[0]);
  assert.equal(run.nodes.list.children.length, 2);
  assert.equal(
    lookup[firstSortedCard.dataset.venueKey],
    run.leaflet.records.markers[1],
  );
});

test("each venue card has an accessible native Map control", async () => {
  const run = await runScript({
    fetch: () =>
      Promise.resolve(
        response({
          venues: [
            venue({ title: "First Stage" }),
            venue({ title: "Second Stage", lat: 44.99, lng: -93.18 }),
          ],
        }),
      ),
  });
  const buttons = run.nodes.list.querySelectorAll(
    "button.porchfest-show-on-map",
  );

  assert.equal(buttons.length, 2);
  buttons.forEach((button, index) => {
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.textContent, "Map");
    assert.equal(
      button.getAttribute("aria-label"),
      "Show " + ["First Stage", "Second Stage"][index] + " on map",
    );
  });
  assert.match(
    stylesheetSource,
    /\.porchfest-show-on-map\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-show-on-map:focus-visible\s*\{[^}]*outline:/s,
  );
});

test("a sorted card flies to and opens its venue-keyed marker", async () => {
  const venues = [
    venue({ title: "North Stage", lat: 45.01, lng: -93.17 }),
    venue({ title: "South Stage", lat: 44.97, lng: -93.21 }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const firstSortedCard = run.nodes.list.children[0];
  const button = firstSortedCard.querySelector("button.porchfest-show-on-map");

  assert.equal(
    firstSortedCard.dataset.venueKey,
    run.testApi.venueKey(venues[1]),
  );
  button.dispatchEvent({ type: "click" });

  assert.equal(run.leaflet.records.maps[0].flyToCalls.length, 1);
  assert.deepEqual(
    Array.from(run.leaflet.records.maps[0].flyToCalls[0].coordinates),
    [44.97, -93.21],
  );
  assert.equal(run.leaflet.records.maps[0].flyToCalls[0].zoom, 17);
  assert.equal(run.leaflet.records.maps[0].flyToCalls[0].options.duration, 0.5);
  assert.equal(run.leaflet.records.markers[0].openPopupCalls, 0);
  run.leaflet.records.maps[0].fire("moveend");
  assert.equal(run.leaflet.records.markers[1].openPopupCalls, 1);
});

test("a card opens its popup only from the flight move-completion callback", async () => {
  const selectedVenue = venue({
    title: "Flight Stage",
    lat: 44.99,
    lng: -93.18,
  });
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues: [selectedVenue] })),
  });
  const map = run.leaflet.records.maps[0];
  const marker = run.leaflet.records.markers[0];
  const button = run.nodes.list.querySelector("button.porchfest-show-on-map");

  button.dispatchEvent({ type: "click" });

  assert.equal(map.flyToCalls.length, 1);
  assert.equal(map.onceCalls.length, 1);
  assert.equal(map.onceCalls[0].type, "moveend");
  assert.equal(marker.openPopupCalls, 0);

  map.fire("moveend");

  assert.equal(marker.openPopupCalls, 1);
  map.fire("moveend");
  assert.equal(marker.openPopupCalls, 1);
});

test("a newer card flight supersedes the pending popup callback", async () => {
  const venues = [
    venue({ title: "First Flight Stage" }),
    venue({ title: "Latest Flight Stage", lat: 44.99, lng: -93.18 }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const map = run.leaflet.records.maps[0];
  const buttons = run.nodes.list.querySelectorAll(
    "button.porchfest-show-on-map",
  );

  buttons[0].dispatchEvent({ type: "click" });
  buttons[1].dispatchEvent({ type: "click" });

  assert.equal(map.flyToCalls.length, 2);
  assert.equal(map.listeners.moveend.length, 1);
  assert.equal(run.leaflet.records.markers[0].openPopupCalls, 0);
  assert.equal(run.leaflet.records.markers[1].openPopupCalls, 0);

  map.fire("moveend");

  assert.equal(run.leaflet.records.markers[0].openPopupCalls, 0);
  assert.equal(run.leaflet.records.markers[1].openPopupCalls, 1);
});

test("a collapsed venue card still navigates to its marker without changing filter state", async () => {
  const venues = [
    venue({
      title: "Folk Stage",
      acts: [{ slot: "6-7", name: "Folk Act", genre: "Folk" }],
    }),
    venue({
      title: "Rock Stage",
      lat: 44.99,
      lng: -93.18,
      acts: [{ slot: "7-8", name: "Rock Act", genre: "Rock" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const rockCard = run.nodes.list
    .querySelectorAll(".porchfest-venue-card")
    .find((card) => card.dataset.venueKey === run.testApi.venueKey(venues[1]));

  applyFilters(run, venues, "6–7 pm", "Folk");
  assertViewClasses(rockCard, "collapsed");

  rockCard
    .querySelector("button.porchfest-show-on-map")
    .dispatchEvent({ type: "click" });

  assertViewClasses(rockCard, "collapsed");
  assert.equal(run.testApi.getViewState().hour, "6–7 pm");
  assert.equal(run.testApi.getViewState().genre, "Folk");
  assert.equal(run.leaflet.records.maps[0].flyToCalls.length, 1);
  assert.deepEqual(
    Array.from(run.leaflet.records.maps[0].flyToCalls[0].coordinates),
    [venues[1].lat, venues[1].lng],
  );
  assert.equal(run.leaflet.records.markers[1].openPopupCalls, 0);
  run.leaflet.records.maps[0].fire("moveend");
  assert.equal(run.leaflet.records.markers[1].openPopupCalls, 1);
});

test("renders a permanent one-line hour control with exactly one active button", async () => {
  const venues = [
    venue({ title: "Early", acts: [{ slot: "6-7", name: "Early Act" }] }),
    venue({
      title: "Late",
      lat: 44.99,
      acts: [{ slot: "7-8", name: "Late Act" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const controls = run.nodes.mount.querySelector(".porchfest-map-controls");
  const hourControl = controls.querySelector(".porchfest-hour-control");
  const buttons = hourControl.querySelectorAll("button");

  // The filters sit outside the full-bleed map block, reading as a header for the
  // lineup they filter: DOM order is map -> filters -> lineup.
  assert.equal(controls.parentNode, run.nodes.mount);
  const mountOrder = run.nodes.mount.children;
  // Pin the map block's index first: indexOf returns -1 when it is not a direct
  // child, and -1 < any index, so the map-before-filters claim would pass vacuously.
  assert.equal(mountOrder.indexOf(run.nodes.fullbleed), 0);
  assert.equal(
    mountOrder.indexOf(run.nodes.fullbleed) < mountOrder.indexOf(controls),
    true,
  );
  assert.equal(
    mountOrder.indexOf(controls),
    mountOrder.indexOf(run.nodes.listSection) - 1,
  );
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ["All", "6–7 pm", "7–8 pm"],
  );
  assert.equal(
    buttons.filter((button) => button.getAttribute("aria-pressed") === "true")
      .length,
    1,
  );
  assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
  assert.equal(hourControl.getAttribute("role"), "group");
  assert.match(hourControl.getAttribute("aria-label"), /hour/i);
});

test("derives hour filters from first-seen non-Goal-1 slot labels", async () => {
  const venues = [
    venue({
      title: "Second Afternoon Stage",
      acts: [
        {
          slot: "slot-b",
          slot_label: "afternoon-2",
          name: "Second Afternoon Act",
        },
      ],
    }),
    venue({
      title: "First Afternoon Stage",
      lat: 44.99,
      acts: [
        {
          slot: "slot-a",
          slot_label: "afternoon-1",
          name: "First Afternoon Act",
        },
      ],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const buttons = run.nodes.mount
    .querySelector(".porchfest-hour-control")
    .querySelectorAll("button");

  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ["All", "afternoon-2", "afternoon-1"],
  );

  buttons[2].dispatchEvent({ type: "click" });
  assert.equal(run.testApi.getViewState().hour, "afternoon-1");
  assertViewClasses(run.nodes.list.children[0], "collapsed");
  assertViewClasses(run.nodes.list.children[1], "match");
});

test('keeps a payload slot label named "all" distinct from the All option', async () => {
  const venues = [
    venue({
      title: "Literal All Stage",
      acts: [{ slot: "slot-all", slot_label: "all", name: "Literal All Act" }],
    }),
    venue({
      title: "Evening Stage",
      lat: 44.99,
      acts: [
        { slot: "slot-evening", slot_label: "evening", name: "Evening Act" },
      ],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const buttons = run.nodes.mount
    .querySelector(".porchfest-hour-control")
    .querySelectorAll("button");

  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ["All", "all", "evening"],
  );

  buttons[1].dispatchEvent({ type: "click" });
  assert.equal(run.testApi.getViewState().hour, "all");
  assertViewClasses(run.nodes.list.children[0], "match");
  assertViewClasses(run.nodes.list.children[1], "collapsed");
});

test("keeps distinct raw slot labels separate while de-duplicating exact repeats", async () => {
  const venues = [
    venue({
      title: "Plain Label Stage",
      acts: [
        {
          slot: "slot-plain",
          slot_label: "afternoon-1",
          name: "Plain Label Act",
        },
      ],
    }),
    venue({
      title: "Padded Label Stage",
      lat: 44.99,
      acts: [
        {
          slot: "slot-padded",
          slot_label: " afternoon-1 ",
          name: "Padded Label Act",
        },
      ],
    }),
    venue({
      title: "Whitespace Label Stage",
      lat: 44.98,
      acts: [
        {
          slot: "slot-whitespace",
          slot_label: " ",
          name: "Whitespace Label Act",
        },
        {
          slot: "slot-duplicate",
          slot_label: "afternoon-1",
          name: "Duplicate Plain Label Act",
        },
      ],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const buttons = run.nodes.mount
    .querySelector(".porchfest-hour-control")
    .querySelectorAll("button");
  const cardsByVenueKey = Object.fromEntries(
    run.nodes.list.children.map((card) => [card.dataset.venueKey, card]),
  );

  assert.deepEqual(
    buttons.map((button) => button.dataset.filterValue),
    [ALL_HOURS, "afternoon-1", " afternoon-1 ", " "],
  );

  buttons[2].dispatchEvent({ type: "click" });
  assert.equal(run.testApi.getViewState().hour, " afternoon-1 ");
  assertViewClasses(
    cardsByVenueKey[run.testApi.venueKey(venues[0])],
    "collapsed",
  );
  assertViewClasses(cardsByVenueKey[run.testApi.venueKey(venues[1])], "match");
  assertViewClasses(
    cardsByVenueKey[run.testApi.venueKey(venues[2])],
    "collapsed",
  );

  buttons[3].dispatchEvent({ type: "click" });
  assert.equal(run.testApi.getViewState().hour, " ");
  assertViewClasses(
    cardsByVenueKey[run.testApi.venueKey(venues[0])],
    "collapsed",
  );
  assertViewClasses(
    cardsByVenueKey[run.testApi.venueKey(venues[1])],
    "collapsed",
  );
  assertViewClasses(cardsByVenueKey[run.testApi.venueKey(venues[2])], "match");
});

test("hour buttons are accessible native buttons that update state and reapply the view", async () => {
  const venues = [
    venue({ title: "Early", acts: [{ slot: "6-7", name: "Early Act" }] }),
    venue({
      title: "Late",
      lat: 44.99,
      acts: [{ slot: "7-8", name: "Late Act" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const buttons = run.nodes.mount
    .querySelector(".porchfest-hour-control")
    .querySelectorAll("button");

  buttons.forEach((button) => {
    assert.equal(button.tagName, "BUTTON");
    assert.ok(button.getAttribute("aria-label") || button.textContent);
    assert.notEqual(button.getAttribute("aria-pressed"), null);
  });

  buttons[2].dispatchEvent({ type: "click" });
  assert.equal(run.testApi.getViewState().hour, "7–8 pm");
  assert.equal(
    buttons.filter((button) => button.getAttribute("aria-pressed") === "true")
      .length,
    1,
  );
  assert.equal(buttons[2].getAttribute("aria-pressed"), "true");
  assertViewClasses(run.nodes.list.children[0], "collapsed");
  assertViewClasses(run.nodes.list.children[1], "match");

  assert.equal(buttons[0].textContent, "All");
  buttons[0].dispatchEvent({ type: "click" });
  assert.equal(run.testApi.getViewState().hour, ALL_HOURS);
  assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
  run.nodes.list.children.forEach((card) => assertViewClasses(card, "neutral"));
});

test("hour chips meet the 44px target and the toolbar is constrained to one line", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-filter-chip\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-map-toolbar\s*\{[^}]*flex-wrap:\s*nowrap/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-hour-control\s*\{[^}]*flex-wrap:\s*nowrap/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-filter-chip:focus-visible\s*\{[^}]*outline:/s,
  );
});

test("filter chips use content width without shrinking below their touch target", () => {
  const chipRule = stylesheetSource.match(
    /\.porchfest-filter-chip\s*\{([^}]*)\}/,
  );

  assert.ok(chipRule);
  assert.match(chipRule[1], /width:\s*auto/);
  assert.match(chipRule[1], /min-width:\s*44px/);
  assert.match(chipRule[1], /flex:\s*0\s+0\s+auto/);
  assert.doesNotMatch(chipRule[1], /(?:^|;)\s*width:\s*44px/);
});

test("derives genre chips from loaded data and orders them by frequency then alphabetically", async () => {
  const venues = [
    venue({
      title: "Mixed Stage",
      acts: [
        { slot: "6-7", name: "Rock One", genre: "Rock, Folk" },
        { slot: "7-8", name: "Rock Two", genre: "Rock" },
      ],
    }),
    venue({
      title: "Novel Stage",
      lat: 44.99,
      acts: [
        { slot: "6-7", name: "Novel Act", genre: "Glitch Hop" },
        { slot: "7-8", name: "Folk Rock", genre: "Folk, Rock" },
      ],
    }),
    venue({
      title: "Slash Stage",
      lat: 45,
      acts: [
        { slot: "6-8", name: "Indie Act", genre: "Alternative / Indie Rock" },
      ],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const chips = run.nodes.mount
    .querySelector(".porchfest-genre-chips")
    .querySelectorAll("button");

  assert.deepEqual(
    chips.map((button) => button.textContent),
    ["All", "Rock", "Folk", "Alternative / Indie Rock", "Glitch Hop"],
  );
  assert.equal(
    chips.filter((button) => button.textContent === "Glitch Hop").length,
    1,
  );
  assert.equal(
    chips.filter((button) => button.textContent === "Alternative / Indie Rock")
      .length,
    1,
  );
});

test("genre disclosure uses the existing details pattern and All clears the genre facet", async () => {
  const venues = [
    venue({
      title: "Folk Stage",
      acts: [{ slot: "6-8", name: "Folk Act", genre: "Folk" }],
    }),
    venue({
      title: "Rock Stage",
      lat: 44.99,
      acts: [{ slot: "6-8", name: "Rock Act", genre: "Rock" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const facet = run.nodes.mount.querySelector(".porchfest-genre-facet");
  const summary = facet.querySelector("summary");
  const chips = facet
    .querySelector(".porchfest-genre-chips")
    .querySelectorAll("button");
  const allChip = chips.find((button) => button.textContent === "All");
  const folkChip = chips.find((button) => button.textContent === "Folk");

  assert.equal(facet.tagName, "DETAILS");
  assert.equal(facet.classList.contains("accordion-item"), true);
  assert.equal(summary.classList.contains("accordion-item-header"), true);
  assert.match(summary.textContent, /genre/i);

  folkChip.dispatchEvent({ type: "click" });
  assert.equal(run.testApi.getViewState().genre, "Folk");
  assert.equal(folkChip.getAttribute("aria-pressed"), "true");
  assertViewClasses(run.nodes.list.children[0], "match");
  assertViewClasses(run.nodes.list.children[1], "collapsed");

  allChip.dispatchEvent({ type: "click" });
  assert.equal(run.testApi.getViewState().genre, "all");
  assert.equal(allChip.getAttribute("aria-pressed"), "true");
  assert.equal(
    chips.filter((button) => button.getAttribute("aria-pressed") === "true")
      .length,
    1,
  );
  run.nodes.list.children.forEach((card) => assertViewClasses(card, "neutral"));
});

test("genre chip row scrolls horizontally with a visible scrollbar cue", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-genre-chips\s*\{[^}]*overflow-x:\s*auto[^}]*scrollbar-color:/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-genre-chips::-webkit-scrollbar\s*\{[^}]*height:/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-genre-summary:focus-visible[^}]*outline:/s,
  );
});

test("starts south-to-north and reverses the existing card nodes through one sort button", async () => {
  const venues = [
    venue({ title: "Middle Stage", lat: 44.98 }),
    venue({ title: "North Stage", lat: 45.01 }),
    venue({ title: "South Stage", lat: 44.94 }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const sortButton = run.nodes.mount.querySelector(".porchfest-sort-button");
  const cardsBefore = run.nodes.list.children.slice();

  assert.equal(run.testApi.getViewState().sortDirection, "asc");
  assert.equal(sortButton.tagName, "BUTTON");
  assert.equal(sortButton.getAttribute("aria-pressed"), "true");
  assert.match(sortButton.textContent, /south.*north/i);
  assert.match(sortButton.getAttribute("aria-label"), /south.*north/i);
  assert.deepEqual(
    cardsBefore.map(
      (card) => card.querySelector(".porchfest-venue-title").textContent,
    ),
    ["South Stage", "Middle Stage", "North Stage"],
  );

  sortButton.dispatchEvent({ type: "click" });

  assert.equal(run.testApi.getViewState().sortDirection, "desc");
  assert.equal(sortButton.getAttribute("aria-pressed"), "false");
  assert.match(sortButton.textContent, /north.*south/i);
  assert.deepEqual(run.nodes.list.children, cardsBefore.slice().reverse());
  assert.equal(run.nodes.list.children[0], cardsBefore[2]);
  assert.equal(run.nodes.list.children[2], cardsBefore[0]);

  sortButton.dispatchEvent({ type: "click" });

  assert.equal(run.testApi.getViewState().sortDirection, "asc");
  assert.equal(sortButton.getAttribute("aria-pressed"), "true");
  assert.match(sortButton.textContent, /south.*north/i);
  assert.deepEqual(run.nodes.list.children, cardsBefore);
});

test("sorting preserves every venue match state and marker lookup by venue key", async () => {
  const venues = [
    venue({
      title: "Middle Stage",
      lat: 44.98,
      acts: [{ slot: "6-7", name: "Middle Act" }],
    }),
    venue({
      title: "North Stage",
      lat: 45.01,
      acts: [{ slot: "7-8", name: "North Act" }],
    }),
    venue({
      title: "South Stage",
      lat: 44.94,
      acts: [{ slot: "6-7", name: "South Act" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const hourButtons = run.nodes.mount
    .querySelector(".porchfest-hour-control")
    .querySelectorAll("button");
  const sortButton = run.nodes.mount.querySelector(".porchfest-sort-button");
  const lookup = run.testApi.getMarkersByVenueKey();

  hourButtons[1].dispatchEvent({ type: "click" });
  const statesBefore = Object.create(null);
  run.nodes.list.children.forEach((card) => {
    statesBefore[card.dataset.venueKey] = card.className;
  });

  sortButton.dispatchEvent({ type: "click" });

  run.nodes.list.children.forEach((card) => {
    assert.equal(card.className, statesBefore[card.dataset.venueKey]);
    assert.ok(lookup[card.dataset.venueKey]);
    const venueForCard = venues.find(
      (item) => run.testApi.venueKey(item) === card.dataset.venueKey,
    );
    assert.equal(
      lookup[card.dataset.venueKey].coordinates[0],
      venueForCard.lat,
    );
  });
  run.leaflet.records.markers.forEach((marker, index) => {
    assertViewClasses(marker.element, index === 1 ? "dimmed" : "match");
  });
});

test("sort button shares the accessible 44px chip treatment", async () => {
  const run = await runScript();
  const sortButton = run.nodes.mount.querySelector(".porchfest-sort-button");

  assert.equal(sortButton.classList.contains("porchfest-filter-chip"), true);
  assert.notEqual(sortButton.getAttribute("aria-label"), null);
  assert.notEqual(sortButton.getAttribute("aria-pressed"), null);
  assert.match(
    stylesheetSource,
    /\.porchfest-filter-chip\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s,
  );
});

test("a full-evening act matches its payload-provided hour label", async () => {
  const venues = [venue({ acts: [{ slot: "6-8", name: "Full Evening" }] })];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const card = run.nodes.list.children[0];
  const markerElement = run.leaflet.records.markers[0].element;

  applyFilters(run, venues, "6–8 pm", "all");
  assertViewClasses(card, "match");
  assertViewClasses(markerElement, "match");
});

test("filtering keeps non-matching venues in the lineup and their markers on the map", async () => {
  const venues = [
    venue({ title: "Early Stage", acts: [{ slot: "6-7", name: "Early Act" }] }),
    venue({
      title: "Late Stage",
      lat: 44.99,
      lng: -93.18,
      acts: [{ slot: "7-8", name: "Late Act" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });

  applyFilters(run, venues, "6–7 pm", "all");

  assert.equal(
    run.nodes.list.querySelectorAll(".porchfest-venue-card").length,
    2,
  );
  assert.equal(run.leaflet.records.markers.length, 2);
  assert.equal(run.leaflet.records.markers[1].map, run.leaflet.records.maps[0]);
  assertViewClasses(run.nodes.list.children[1], "collapsed");
  assertViewClasses(run.leaflet.records.markers[1].element, "dimmed");
});

test("only non-matching cards collapse while matching and neutral cards stay full height", async () => {
  const venues = [
    venue({ title: "Early Stage", acts: [{ slot: "6-7", name: "Early Act" }] }),
    venue({
      title: "Late Stage",
      lat: 44.99,
      lng: -93.18,
      acts: [{ slot: "7-8", name: "Late Act" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const earlyCard = run.nodes.list.children[0];
  const lateCard = run.nodes.list.children[1];

  assertViewClasses(earlyCard, "neutral");
  assertViewClasses(lateCard, "neutral");

  applyFilters(run, venues, "6–7 pm", "all");

  assertViewClasses(earlyCard, "match");
  assertViewClasses(lateCard, "collapsed");
});

test("matching venues mark both the lineup card and marker element", async () => {
  const venues = [
    venue({ title: "Early Stage", acts: [{ slot: "6-7", name: "Early Act" }] }),
    venue({
      title: "Late Stage",
      lat: 44.99,
      lng: -93.18,
      acts: [{ slot: "7-8", name: "Late Act" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });

  applyFilters(run, venues, "6–7 pm", "all");

  assertViewClasses(run.nodes.list.children[0], "match");
  assertViewClasses(run.leaflet.records.markers[0].element, "match");
});

test("a faded marker stays keyboard-focusable and opens its popup", async () => {
  const venues = [
    venue({ title: "Early Stage", acts: [{ slot: "6-7", name: "Early Act" }] }),
    venue({
      title: "Late Stage",
      lat: 44.99,
      lng: -93.18,
      acts: [{ slot: "7-8", name: "Late Act" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const fadedMarker = run.leaflet.records.markers[1];

  applyFilters(run, venues, "6–7 pm", "all");
  fadedMarker.element.dispatchEvent({
    type: "keydown",
    key: " ",
    preventDefault() {},
  });

  assertViewClasses(fadedMarker.element, "dimmed");
  assert.equal(fadedMarker.element.tabIndex, 0);
  assert.equal(fadedMarker.openPopupCalls, 1);
  assert.equal(fadedMarker.openedContent.className, "porchfest-map-popup");
});

test("hour filters resolve every slot label and a two-act venue", async () => {
  const venues = [
    venue({ title: "Early", acts: [{ slot: "6-7", name: "Early Act" }] }),
    venue({
      title: "Late",
      lat: 44.981,
      acts: [{ slot: "7-8", name: "Late Act" }],
    }),
    venue({
      title: "Full",
      lat: 44.982,
      acts: [{ slot: "6-8", name: "Full Act" }],
    }),
    venue({
      title: "Two Act",
      lat: 44.983,
      acts: [
        { slot: "6-7", name: "First Act" },
        { slot: "7-8", name: "Second Act" },
      ],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const cards = run.nodes.list.children;

  applyFilters(run, venues, "6–7 pm", "all");
  assert.deepEqual(
    cards.map((card) => card.classList.contains("is-match")),
    [true, false, false, true],
  );
  assertViewClasses(cards[1], "collapsed");

  applyFilters(run, venues, "7–8 pm", "all");
  assert.deepEqual(
    cards.map((card) => card.classList.contains("is-match")),
    [false, true, false, true],
  );
  assertViewClasses(cards[0], "collapsed");

  applyFilters(run, venues, "6–8 pm", "all");
  assert.deepEqual(
    cards.map((card) => card.classList.contains("is-match")),
    [false, false, true, false],
  );
});

test("a genre-less act is collapsed under an active genre filter", async () => {
  const venues = [
    venue({
      acts: [{ slot: "6-8", name: "Unclassified Act" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const card = run.nodes.list.children[0];
  const markerElement = run.leaflet.records.markers[0].element;

  applyFilters(run, venues, ALL_HOURS, "Folk");

  assertViewClasses(card, "collapsed");
  assertViewClasses(markerElement, "dimmed");
});

test("facets combine with AND when hour matches but genre does not", async () => {
  const venues = [
    venue({
      title: "Rock Stage",
      acts: [{ slot: "6-7", name: "Rock Act", genre: "Rock" }],
    }),
    venue({
      title: "Folk Stage",
      lat: 44.99,
      lng: -93.18,
      acts: [{ slot: "6-7", name: "Folk Act", genre: "Folk" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });

  applyFilters(run, venues, "6–7 pm", "Folk");

  assertViewClasses(run.nodes.list.children[0], "collapsed");
  assertViewClasses(run.nodes.list.children[1], "match");
});

test("different acts can satisfy the venue hour and genre facets", async () => {
  const venues = [
    venue({
      acts: [
        { slot: "6-7", name: "Early Rock Act", genre: "Rock" },
        { slot: "7-8", name: "Late Folk Act", genre: "Folk" },
      ],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });

  applyFilters(run, venues, "6–7 pm", "Folk");

  assertViewClasses(run.nodes.list.children[0], "match");
  assertViewClasses(run.leaflet.records.markers[0].element, "match");
});

test("filtering preserves sorted card and marker pairing by venue key", async () => {
  const venues = [
    venue({
      title: "Early Folk",
      acts: [{ slot: "6-7", name: "Folk Act", genre: "Folk" }],
    }),
    venue({
      title: "Late Rock",
      lat: 44.99,
      lng: -93.18,
      acts: [{ slot: "7-8", name: "Rock Act", genre: "Rock" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const earlyCard = run.nodes.list.children[0];
  const lateCard = run.nodes.list.children[1];
  [lateCard, earlyCard].forEach((card) => run.nodes.list.appendChild(card));

  applyFilters(run, venues, "6–7 pm", "Folk");

  assert.equal(run.nodes.list.children[1], earlyCard);
  assertViewClasses(earlyCard, "match");
  assertViewClasses(run.leaflet.records.markers[0].element, "match");
  assertViewClasses(lateCard, "collapsed");
  assertViewClasses(run.leaflet.records.markers[1].element, "dimmed");
});

test("genre tags split on commas but preserve slash compounds", async () => {
  const run = await runScript();

  assert.deepEqual(
    Array.from(
      run.testApi.genreTags({ genre: "Alternative / Indie Rock, Folk" }),
    ),
    ["Alternative / Indie Rock", "Folk"],
  );
  assert.equal(
    run.testApi.genreTags({ genre: "Alternative / Indie Rock" }).length,
    1,
  );
});

test("returning both facets to All removes every view class", async () => {
  const venues = [
    venue({
      title: "Folk Stage",
      acts: [{ slot: "6-7", name: "Folk Act", genre: "Folk" }],
    }),
    venue({
      title: "Rock Stage",
      lat: 44.99,
      lng: -93.18,
      acts: [{ slot: "7-8", name: "Rock Act", genre: "Rock" }],
    }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });

  applyFilters(run, venues, "6–7 pm", "Folk");
  applyFilters(run, venues, ALL_HOURS, "all");

  run.nodes.list.children.forEach((card) => assertViewClasses(card, "neutral"));
  run.leaflet.records.markers.forEach((marker) =>
    assertViewClasses(marker.element, "neutral"),
  );
});

test("a zero-match combination explains how to return to All without removing venues", async () => {
  const venues = [
    venue({ acts: [{ slot: "6-7", name: "Folk Act", genre: "Folk" }] }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });

  applyFilters(run, venues, "7–8 pm", "Rock");

  assert.equal(run.nodes.status.hidden, false);
  assert.equal(run.nodes.status.className, "porchfest-map-status is-no-match");
  assert.match(run.nodes.status.textContent, /no venues match/i);
  assert.match(run.nodes.status.textContent, /All/);
  assert.equal(run.nodes.mapElement.hidden, false);
  assert.equal(run.nodes.listSection.hidden, false);
  assert.equal(run.nodes.status.parentNode, run.nodes.fullbleed);
  // Assert the two blocks separately. Locating the controls inside the full-bleed
  // block goes vacuous rather than failing, because indexOf(null) is -1.
  assert.equal(run.nodes.fullbleed.children.indexOf(run.nodes.status), 0);
  assert.equal(
    run.nodes.fullbleed.children.indexOf(run.nodes.mapElement),
    run.nodes.fullbleed.children.indexOf(run.nodes.status) + 1,
  );
  const noMatchControls = run.nodes.mount.querySelector(
    ".porchfest-map-controls",
  );
  assert.ok(noMatchControls, "expected the filter controls to be mounted");
  // Same trap as above: pin the map block's index before doing arithmetic on it.
  assert.equal(run.nodes.mount.children.indexOf(run.nodes.fullbleed), 0);
  assert.equal(
    run.nodes.mount.children.indexOf(noMatchControls),
    run.nodes.mount.children.indexOf(run.nodes.fullbleed) + 1,
  );
  assertViewClasses(run.nodes.list.children[0], "collapsed");
  assertViewClasses(run.leaflet.records.markers[0].element, "dimmed");

  applyFilters(run, venues, "6–7 pm", "Folk");

  assert.equal(run.nodes.status.hidden, true);
  assert.equal(run.nodes.status.className, "porchfest-map-status");
  assertViewClasses(run.nodes.list.children[0], "match");
  assertViewClasses(run.leaflet.records.markers[0].element, "match");
});

test("the zero-match notice overrides map-sized status dimensions", () => {
  assert.match(
    stylesheetSource,
    /\.porchfest-map-status\.is-no-match\s*\{[^}]*height:\s*auto[^}]*min-height:\s*0/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-map-status\.is-no-match\s*\{[^}]*padding:\s*[^;}]+/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-map-canvas,\s*\.porchfest-map-status\s*\{[^}]*min-height:\s*480px/s,
  );
});

test("applyView preserves the existing card node identity", async () => {
  const venues = [
    venue(),
    venue({ title: "Second Stage", lat: 44.99, lng: -93.18 }),
  ];
  const run = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });
  const cardsBefore = run.nodes.list.children.slice();
  run.document.createElement = () => {
    throw new Error("applyView must not create elements");
  };
  run.nodes.list.appendChild = () => {
    throw new Error("applyView must not detach or re-append cards");
  };
  // appendChild delegates to insertBefore, so spying only on appendChild would let a
  // direct list.insertBefore(card, ref) past the guard -- including the no-op form
  // that detaches and re-attaches every card while leaving children identical.
  run.nodes.list.insertBefore = () => {
    throw new Error("applyView must not detach or re-append cards");
  };

  applyFilters(run, venues, "6–7 pm", "Rock");

  assert.equal(run.nodes.list.children[0], cardsBefore[0]);
  assert.equal(run.nodes.list.children[1], cardsBefore[1]);
  assert.equal(cardsBefore[0].parentNode, run.nodes.list);
  assert.equal(cardsBefore[1].parentNode, run.nodes.list);
  cardsBefore.forEach((card) => assertViewClasses(card, "collapsed"));
});

test("shows the fallback when fetch is unavailable", async () => {
  const { nodes } = await runScript({ fetch: undefined });
  assertFailure(nodes);
});

test("shows the fallback when Leaflet is unavailable", async () => {
  const { nodes } = await runScript({ L: undefined });
  assertFailure(nodes);
});

test("shows the fallback when the request rejects", async () => {
  const { nodes } = await runScript({
    fetch: () => Promise.reject(new Error("offline")),
  });
  assertFailure(nodes);
});

test("aborts a request after ten seconds and shows the fallback", async () => {
  let capturedSignal;
  const fetch = (url, options) => {
    capturedSignal = options.signal;
    return Promise.resolve({
      ok: true,
      json() {
        return new Promise((resolve, reject) => {
          capturedSignal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      },
    });
  };
  const run = await runScript({ fetch });

  assert.equal(run.timers.length, 1);
  assert.equal(run.timers[0].delay, 10000);
  run.timers[0].callback();
  await settlePromises();

  assert.equal(capturedSignal.aborted, true);
  assert.deepEqual(run.clearedTimers, [1]);
  assertFailure(run.nodes);
});

test("shows the fallback when JSON parsing fails", async () => {
  const { nodes } = await runScript({
    fetch: () =>
      Promise.resolve(
        response(null, { jsonError: new SyntaxError("bad JSON") }),
      ),
  });
  assertFailure(nodes);
});

test("shows the fallback for malformed JSON data", async () => {
  const { nodes } = await runScript({
    fetch: () => Promise.resolve(response({ venues: "not-an-array" })),
  });
  assertFailure(nodes);
});

test("shows the empty state when no venue has an act", async () => {
  const { nodes } = await runScript({
    fetch: () => Promise.resolve(response({ venues: [venue({ acts: [] })] })),
  });
  assert.equal(nodes.status.hidden, false);
  assert.equal(nodes.status.className, "porchfest-map-status is-empty");
  assert.equal(nodes.status.textContent, EMPTY_STATE);
  assert.equal(nodes.mapElement.hidden, true);
  assert.equal(nodes.listSection.hidden, true);
  assert.equal(
    nodes.mount.querySelectorAll(".porchfest-map-controls").length,
    0,
  );
  assert.equal(
    nodes.mount.querySelectorAll(".porchfest-genre-facet").length,
    0,
  );
});

test("the marker shell never overrides the inline styles Leaflet uses for icon geometry", () => {
  // Leaflet implements iconAnchor as inline margin-left/-top on the icon. A CSS
  // !important margin outranks that inline style and silently discards the anchor,
  // pinning the icon's top-left corner to the coordinate instead of the pin tip --
  // every marker then sits 22px east and 40px south of its true location, which
  // reads as ~30ft off at max zoom but over 1000ft off zoomed out.
  const rule = stylesheetSource.match(/\.porchfest-marker-shell\s*\{([^}]*)\}/);
  const declarations = rule && rule[1].replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(rule, "expected a .porchfest-marker-shell rule");
  // Broadened from margin to every property: Leaflet drives this element's width,
  // height, margin, and transform from iconSize/iconAnchor via inline styles, and
  // !important outranks all of them. margin is simply the one that bit first.
  assert.doesNotMatch(declarations, /!important/);
});

test("no state message points readers at a Google map the page no longer embeds", () => {
  // sapporchfest.org dropped the My Maps iframe from /map/. Copy that still sends
  // readers "below" to a Google map is a dangling pointer, and showState() also
  // hides the venue list -- so a stale message leaves a failed load with no way forward.
  assert.doesNotMatch(scriptSource, /google/i);
  assert.doesNotMatch(scriptSource, /map below/i);
});

test("shows the fallback and no partial list for invalid coordinates", async () => {
  const { nodes, leaflet } = await runScript({
    fetch: () =>
      Promise.resolve(response({ venues: [venue({ lat: "44.98" })] })),
  });
  assertFailure(nodes);
  assert.equal(nodes.list.children.length, 0);
  assert.equal(leaflet.records.markers.length, 0);
});

test("renders one marker and one semantic list item per venue", async () => {
  const venues = [
    venue(),
    venue({
      title: "Oak Stage",
      address: "200 Festival Ave",
      lat: 44.99,
      lng: -93.18,
    }),
  ];
  const { nodes, leaflet, clearedTimers } = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });

  assert.equal(nodes.status.hidden, true);
  assert.equal(nodes.mapElement.hidden, false);
  assert.equal(nodes.listSection.hidden, false);
  assert.equal(nodes.list.children.length, 2);
  assert.equal(nodes.list.children[0].tagName, "LI");
  assert.equal(nodes.list.querySelectorAll("h3").length, 2);
  assert.equal(leaflet.records.markers.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(leaflet.records.bounds[0].points)),
    [
      [44.98, -93.19],
      [44.99, -93.18],
    ],
  );
  assert.equal(leaflet.records.tileLayers[0].options.maxZoom, 19);
  assert.match(
    leaflet.records.tileLayers[0].options.attribution,
    /OpenStreetMap/,
  );
  assert.deepEqual(clearedTimers, [1]);
});

test("renders an accessible 44px marker with a decorative SVG musical note", async () => {
  const { leaflet } = await runScript();
  const marker = leaflet.records.markers[0];
  const icon = marker.options.icon.options;
  const pin = icon.html;
  const note = pin.querySelector(".porchfest-marker-note");
  const notePath = note.querySelector("path");

  assert.equal(icon.className, "porchfest-marker-shell");
  assert.deepEqual(Array.from(icon.iconSize), [44, 44]);
  assert.equal(pin.className, "porchfest-marker-pin");
  assert.equal(pin.getAttribute("aria-hidden"), "true");
  assert.equal(note.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(note.getAttribute("aria-hidden"), "true");
  assert.equal(note.getAttribute("focusable"), "false");
  assert.equal(note.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(
    notePath.getAttribute("d"),
    "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z",
  );
  assert.equal(marker.element.getAttribute("role"), "button");
  assert.equal(
    marker.element.getAttribute("aria-label"),
    "Garden Stage: show lineup",
  );
  assert.equal(marker.element.tabIndex, 0);
  assert.match(
    stylesheetSource,
    /\.porchfest-marker-shell\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-marker-shell:focus-visible\s*\{[^}]*outline:/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-marker-pin\s*\{[^}]*border:\s*3px solid #fff[^}]*box-shadow:/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-marker-note\s*\{[^}]*fill:\s*#fff/s,
  );
});

test("labels every rendered marker with its venue title", async () => {
  const venues = [
    venue({ title: "Garden Stage" }),
    venue({ title: "Oak Stage", lat: 44.99, lng: -93.18 }),
  ];
  const { leaflet } = await runScript({
    fetch: () => Promise.resolve(response({ venues })),
  });

  leaflet.records.markers.forEach((marker, index) => {
    assert.match(
      marker.element.getAttribute("aria-label"),
      new RegExp(venues[index].title),
    );
  });
});

test("renders a 6-8 act and preserves the producer order for two-act venues", async () => {
  const twoActVenue = venue({
    title: "Two Act Stage",
    address: "200 Festival Ave",
    lat: 44.99,
    lng: -93.18,
    acts: [
      { slot: "6-7", slot_label: "6–7 pm", name: "First Act" },
      { slot: "7-8", slot_label: "7–8 pm", name: "Second Act" },
    ],
  });
  const { nodes } = await runScript({
    fetch: () => Promise.resolve(response({ venues: [venue(), twoActVenue] })),
  });
  const cards = nodes.list.querySelectorAll(".porchfest-venue-card");

  assert.deepEqual(
    cards[0]
      .querySelectorAll(".porchfest-act-slot")
      .map((node) => node.textContent),
    ["6–8 pm"],
  );
  assert.deepEqual(
    cards[1]
      .querySelectorAll(".porchfest-act-slot")
      .map((node) => node.textContent),
    ["6–7 pm", "7–8 pm"],
  );
});

test("appendVenueContent emits a schedule-free venue band with a card-only map control", async () => {
  const { nodes, leaflet } = await runScript();
  const card = nodes.list.querySelector(".porchfest-venue-card");
  const popup = leaflet.records.markers[0].popupFactory();

  [card, popup].forEach((container) => {
    const bands = container.querySelectorAll(".porchfest-venue-band");
    const band = bands[0];

    assert.equal(bands.length, 1);
    const expectedChildren = [
      "porchfest-venue-title",
      "porchfest-venue-address",
    ];
    if (container === card) expectedChildren.push("porchfest-show-on-map");
    assert.deepEqual(
      band.children.map((child) => child.className),
      expectedChildren,
    );
    assert.equal(band.querySelectorAll(".porchfest-venue-schedule").length, 0);
    assert.equal(container.children.length, 2);
    assert.equal(container.children[0], band);
    assert.equal(container.children[1].className, "porchfest-venue-acts");
  });
});

test("omits a whitespace-equivalent address in both the list and popup", async () => {
  const matchingAddress = venue({
    title: "  100   Festival Ave  ",
    address: "100 Festival   Ave",
  });
  const { nodes, leaflet } = await runScript({
    fetch: () => Promise.resolve(response({ venues: [matchingAddress] })),
  });
  const popup = leaflet.records.markers[0].popupFactory();

  assert.equal(nodes.list.querySelectorAll(".porchfest-venue-title").length, 1);
  assert.equal(
    nodes.list.querySelectorAll(".porchfest-venue-address").length,
    0,
  );
  assert.equal(popup.querySelectorAll(".porchfest-venue-title").length, 1);
  assert.equal(popup.querySelectorAll(".porchfest-venue-address").length, 0);
});

test("keeps a meaningfully different address in both the list and popup", async () => {
  const differentAddress = venue({
    title: "St. Cecilia's Church, 2357 Bayless Place",
    address: "2357 Bayless Place",
  });
  const { nodes, leaflet } = await runScript({
    fetch: () => Promise.resolve(response({ venues: [differentAddress] })),
  });
  const popup = leaflet.records.markers[0].popupFactory();

  assert.equal(
    nodes.list.querySelector(".porchfest-venue-address").textContent,
    "2357 Bayless Place",
  );
  assert.equal(
    popup.querySelector(".porchfest-venue-address").textContent,
    "2357 Bayless Place",
  );
});

test("uses hostnames for visible link text and keeps link types in accessible labels", async () => {
  const linkedVenue = venue({
    acts: [
      {
        slot: "6-8",
        slot_label: "6–8 pm",
        name: "Linked Act",
        links: [
          { label: "Listen", url: "https://open.spotify.com/artist/example" },
          {
            label: "Website",
            url: "https://www.instagram.com/grovekeepermusic",
          },
        ],
      },
    ],
  });
  const { nodes } = await runScript({
    fetch: () => Promise.resolve(response({ venues: [linkedVenue] })),
  });
  const anchors = nodes.list
    .querySelectorAll(".porchfest-act-links")[0]
    .querySelectorAll("a");

  assert.deepEqual(
    anchors.map((anchor) => anchor.textContent),
    ["open.spotify.com", "instagram.com"],
  );
  assert.equal(
    anchors[0].getAttribute("aria-label"),
    "Listen — open.spotify.com",
  );
  assert.equal(anchors[0].getAttribute("title"), "Listen — open.spotify.com");
  assert.equal(
    anchors[1].getAttribute("aria-label"),
    "Website — instagram.com",
  );
  assert.equal(anchors[1].getAttribute("title"), "Website — instagram.com");
  anchors.forEach((anchor) => {
    assert.equal(anchor.target, "_blank");
    assert.equal(anchor.rel, "noopener");
  });
});

test("renders a hostile parsed hostname literally", async () => {
  class HostileURL {
    constructor() {
      this.protocol = "https:";
      this.href = "https://safe.example/";
      this.hostname = "<img src=x onerror=alert(1)>";
    }
  }
  const hostileHostnameVenue = venue({
    acts: [
      {
        slot: "6-8",
        slot_label: "6–8 pm",
        name: "Hostile Host Act",
        links: [{ label: "Website", url: "https://safe.example/" }],
      },
    ],
  });
  const { nodes } = await runScript({
    URLClass: HostileURL,
    fetch: () => Promise.resolve(response({ venues: [hostileHostnameVenue] })),
  });
  const anchor = nodes.list.querySelector("a");

  assert.equal(anchor.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(anchor.querySelectorAll("img").length, 0);
});

test("uses phone-safe popup options and recomputes widths after viewport changes", async () => {
  const run = await runScript({ innerWidth: 375 });
  const map = run.leaflet.records.maps[0];
  const marker = run.leaflet.records.markers[0];

  assert.equal(marker.popupOptions.maxWidth, 320);
  assert.equal(marker.popupOptions.autoPan, true);
  assert.deepEqual(Array.from(marker.popupOptions.autoPanPadding), [24, 24]);
  assert.equal(map.listeners.resize.length, 1);
  assert.equal(run.windowListeners.orientationchange.length, 1);

  run.window.innerWidth = 280;
  map.fire("resize");
  assert.equal(marker.popup.options.maxWidth, 248);
  assert.equal(marker.popup.options.minWidth, 248);
  assert.equal(marker.popup.updateCalls, 0);

  marker.openPopup();
  run.window.innerWidth = 600;
  map.fire("resize");
  assert.equal(marker.popup.options.maxWidth, 320);
  assert.equal(marker.popup.updateCalls, 1);

  run.window.innerWidth = 300;
  run.window.dispatchEvent({ type: "orientationchange" });
  assert.equal(run.animationFrames.length, 1);
  run.animationFrames[0]();
  assert.equal(map.invalidateSizeCalls, 1);
  assert.equal(marker.popup.options.maxWidth, 268);
  assert.equal(marker.popup.updateCalls, 2);
});

test("popup CSS caps content and wraps long unbroken text", () => {
  assert.match(
    stylesheetSource,
    /\.leaflet-popup-content\s*\{[^}]*max-width:[^;}]*100vw/s,
  );
  assert.match(
    stylesheetSource,
    /\.leaflet-popup-content\s*\{[^}]*overflow-wrap:\s*anywhere/s,
  );
  assert.match(
    stylesheetSource,
    /\.porchfest-act-links a[^}]*overflow-wrap:\s*anywhere/s,
  );
  assert.match(
    stylesheetSource,
    /\.leaflet-popup-content\s*\{[^}]*overflow-x:\s*hidden/s,
  );
});

test("renders hostile text literally and drops unsafe links in list and popup", async () => {
  const hostile = venue({
    title: "<img src=x onerror=alert(1)>",
    address: "<script>alert(2)</script>",
    acts: [
      {
        slot: "6-7",
        slot_label: "<b>6–7 pm</b>",
        name: "<svg onload=alert(3)>",
        genre: "<em>Noise</em>",
        description: "<iframe src=evil>",
        links: [
          {
            label: "<script>alert(4)</script>",
            url: "https://example.com/safe?q=<tag>",
          },
          { label: "Unsafe", url: "javascript:alert(5)" },
        ],
        note: "<a href=evil>note</a>",
      },
    ],
  });
  const { nodes, leaflet } = await runScript({
    fetch: () => Promise.resolve(response({ venues: [hostile] })),
  });
  const popup = leaflet.records.markers[0].popupFactory();
  const listAnchors = nodes.list.querySelectorAll("a");
  const popupAnchors = popup.querySelectorAll("a");

  assert.match(nodes.list.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(popup.textContent, /<iframe src=evil>/);
  assert.equal(nodes.list.querySelectorAll("script").length, 0);
  assert.equal(popup.querySelectorAll("svg").length, 0);
  assert.equal(listAnchors.length, 1);
  assert.equal(popupAnchors.length, 1);
  [listAnchors[0], popupAnchors[0]].forEach((anchor) => {
    assert.equal(anchor.textContent, "example.com");
    assert.equal(
      anchor.getAttribute("aria-label"),
      "<script>alert(4)</script> — example.com",
    );
    assert.equal(anchor.href, "https://example.com/safe?q=%3Ctag%3E");
    assert.equal(anchor.target, "_blank");
    assert.equal(anchor.rel, "noopener");
  });
});

test("Space opens a marker popup without changing Enter handling", async () => {
  const { leaflet } = await runScript();
  const marker = leaflet.records.markers[0];
  let spacePrevented = false;
  marker.element.dispatchEvent({
    type: "keydown",
    key: " ",
    preventDefault() {
      spacePrevented = true;
    },
  });
  assert.equal(spacePrevented, true);
  assert.equal(marker.openPopupCalls, 1);

  let enterPrevented = false;
  marker.element.dispatchEvent({
    type: "keydown",
    key: "Enter",
    preventDefault() {
      enterPrevented = true;
    },
  });
  assert.equal(enterPrevented, false);
  assert.equal(marker.openPopupCalls, 1);
});
