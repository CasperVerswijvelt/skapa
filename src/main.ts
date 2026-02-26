import "./style.css";

import * as THREE from "three";
import { Renderer } from "./rendering/renderer";

import { CLIP_HEIGHT, box, type OpenFrontParams } from "./model/manifold";
import { mesh2geometry } from "./model/export";
import { TMFLoader } from "./model/load";
import { Animate, immediate } from "./animate";

import { Dyn } from "twrl";

import { rangeControl, stepper, toggleControl, advancedSettings } from "./controls";

/// CONSTANTS

// Align axes with 3D printer
THREE.Object3D.DEFAULT_UP = new THREE.Vector3(0, 0, 1);

const DIMENSIONS = [
  "height",
  "width",
  "depth",
  "radius",
  "wall",
  "bottom",
] as const;

// constants, all in outer dimensions (when applicable)

// actual constants
const START_RADIUS = 6;
const START_WALL = 2;
const START_BOTTOM = 3;

const START_HEIGHT = 52; /* calculated manually from START_LEVELS */
const START_LEVELS = 2;
const MIN_LEVELS = 1;
const MAX_LEVELS = 5;

const START_WIDTH = 80;
const MIN_WIDTH = 10 + 2 * START_RADIUS;
const MAX_WIDTH = 204; /* somewhat arbitrary */

const START_DEPTH = 60;
const MIN_DEPTH = 20;
const MAX_DEPTH = 204; /* somewhat arbitrary */

const MIN_RADIUS = 0;
const MAX_RADIUS = 20;

const START_OPEN_FRONT_SIDE_OFFSET = 6;
const START_OPEN_FRONT_BOTTOM_OFFSET = 6;
const MIN_OPEN_FRONT_OFFSET = 0;

const START_OPEN_FRONT_RADIUS = 6;
const MIN_OPEN_FRONT_RADIUS = 0;

/// STATE

// Dimensions of the model (outer, where applicable).
// These are the dimensions of the 3MF file, as well as
// the _target_ dimensions for the animations, though may
// be (ephemerally) different from the animation values.

const levels = new Dyn(START_LEVELS); /* number of clip levels */

const modelDimensions = {
  height: levels.map((x) => x * CLIP_HEIGHT + (x - 1) * (40 - CLIP_HEIGHT)),
  width: new Dyn(START_WIDTH),
  depth: new Dyn(START_DEPTH),
  radius: new Dyn(START_RADIUS),
  wall: new Dyn(START_WALL),
  bottom: new Dyn(START_BOTTOM),
};

const innerWidth = Dyn.sequence([
  modelDimensions.wall,
  modelDimensions.width,
] as const).map(([wall, width]) => width - 2 * wall);

const innerDepth = Dyn.sequence([
  modelDimensions.wall,
  modelDimensions.depth,
] as const).map(([wall, depth]) => depth - 2 * wall);

// Open front state
const openFrontEnabled = new Dyn(false);
const openFrontDimensions = {
  sideOffset: new Dyn(START_OPEN_FRONT_SIDE_OFFSET),
  bottomOffset: new Dyn(START_OPEN_FRONT_BOTTOM_OFFSET),
  cutoutRadius: new Dyn(START_OPEN_FRONT_RADIUS),
};

// Dynamic max limits for open front controls
const maxSideOffset = Dyn.sequence([
  modelDimensions.width,
  modelDimensions.wall,
] as const).map(([width, wall]) => Math.floor((width - 2 * wall) / 2) - 1);

const maxBottomOffset = Dyn.sequence([
  modelDimensions.height,
  modelDimensions.bottom,
] as const).map(([height, bottom]) => Math.floor(height - bottom) - 1);

const maxCutoutRadius = Dyn.sequence([
  modelDimensions.width,
  modelDimensions.wall,
  modelDimensions.height,
  modelDimensions.bottom,
  openFrontDimensions.sideOffset,
  openFrontDimensions.bottomOffset,
] as const).map(([width, wall, height, bottom, sideOff, botOff]) =>
  Math.floor(Math.min(
    (width - 2 * wall - 2 * sideOff) / 2,
    (height - bottom - botOff) / 2,
  )) - 1,
);

// Clamp current values when max shrinks
maxSideOffset.addListener((max) => {
  if (openFrontDimensions.sideOffset.latest > max)
    openFrontDimensions.sideOffset.send(Math.max(MIN_OPEN_FRONT_OFFSET, max));
});
maxBottomOffset.addListener((max) => {
  if (openFrontDimensions.bottomOffset.latest > max)
    openFrontDimensions.bottomOffset.send(Math.max(MIN_OPEN_FRONT_OFFSET, max));
});
maxCutoutRadius.addListener((max) => {
  if (openFrontDimensions.cutoutRadius.latest > max)
    openFrontDimensions.cutoutRadius.send(Math.max(MIN_OPEN_FRONT_RADIUS, max));
});

// Derived: produces OpenFrontParams or undefined
const openFrontConfig: Dyn<OpenFrontParams | undefined> = Dyn.sequence([
  openFrontEnabled,
  openFrontDimensions.sideOffset,
  openFrontDimensions.bottomOffset,
  openFrontDimensions.cutoutRadius,
] as const).map(([enabled, sideOffset, bottomOffset, cutoutRadius]) =>
  enabled ? { sideOffset, bottomOffset, cutoutRadius } : undefined,
);

// Current state of part positioning
type PartPositionStatic = Extract<PartPosition, { tag: "static" }>;
type PartPosition =
  | {
      tag: "static";
      position: -1 | 0 | 1;
    } /* no current mouse interaction. -1 and +1 are different as they represent different ways of showing the back of the part (CW or CCW) */
  | {
      tag: "will-move";
      startRot: number;
      startPos: [number, number];
      clock: THREE.Clock;
      lastStatic: Extract<PartPosition, { tag: "static" }>;
    } /* mouse was down but hasn't moved yet */
  | {
      tag: "moving";
      startRot: number;
      startPos: [number, number];
      lastStatic: Extract<PartPosition, { tag: "static" }>;
      clock: THREE.Clock;
      x: number;
    } /* mouse is moving */;
const partPositioning = new Dyn<PartPosition>({ tag: "static", position: 0 });

/// MODEL

const tmfLoader = new TMFLoader();

// Reloads the model seen on page
async function reloadModel(
  height: number,
  width: number,
  depth: number,
  radius: number,
  wall: number,
  bottom: number,
  openFront?: OpenFrontParams,
) {
  const model = await box(height, width, depth, radius, wall, bottom, openFront);
  const geometry = mesh2geometry(model);
  geometry.computeVertexNormals(); // Make sure the geometry has normals
  mesh.geometry = geometry;
  mesh.clear(); // Remove all children
}

// when target dimensions are changed, update the model to download
Dyn.sequence([
  modelDimensions.height,
  modelDimensions.width,
  modelDimensions.depth,
  modelDimensions.radius,
  modelDimensions.wall,
  modelDimensions.bottom,
  openFrontConfig,
] as const).addListener(([h, w, d, r, wa, bo, of]) => {
  const suffix = of ? "-open" : "";
  const filename = `skapa-${w}-${d}-${h}${suffix}.3mf`;
  tmfLoader.load(box(h, w, d, r, wa, bo, of), filename);
});

/// RENDER

// Set to 'true' whenever the camera needs to be centered again
let centerCameraNeeded = true;

// The mesh, updated in place when the geometry needs to change
const mesh: THREE.Mesh = new THREE.Mesh(
  new THREE.BoxGeometry(
    modelDimensions.width.latest,
    modelDimensions.height.latest,
    modelDimensions.depth.latest,
  ),
  new THREE.Material(),
);

// Center the camera around the mesh
async function centerCamera() {
  // Create a "world" matrix which only includes the part rotation (we don't use the actual
  // world matrix to avoid rotation animation messing with the centering)
  const mat = new THREE.Matrix4();
  mat.makeRotationAxis(new THREE.Vector3(0, 0, 1), MESH_ROTATION_DELTA);
  renderer.centerCameraAround(mesh, mat);
}

const MESH_ROTATION_DELTA = 0.1;
mesh.rotation.z = MESH_ROTATION_DELTA;

const canvas = document.querySelector("canvas") as HTMLCanvasElement;
const renderer = new Renderer(canvas, mesh);

let reloadModelNeeded = true;

// The animated rotation, between -1 and 1
const rotation = new Animate(0);

/* Bound the number betweek lo & hi (modulo) */
const bound = (v: number, [lo, hi]: [number, number]): number =>
  ((v - lo) % (hi - lo)) + lo;

partPositioning.addListener((val) => {
  if (val.tag === "static") {
    rotation.startAnimationTo(val.position);
  } else if (val.tag === "moving") {
    /* the delta of width (between -1 and 1, so 2) per delta of (horizontal, CSS) pixel */
    const dwdx = 2 / renderer.canvasWidth;
    const v = (val.x - val.startPos[0]) * dwdx - val.startRot;
    rotation.startAnimationTo(bound(v, [-1, 1]), immediate);
  } else {
    val.tag satisfies "will-move";
    /* not movement yet, so not need to move */
  }
});

/// ANIMATIONS

// The animated dimensions
const animations = {
  height: new Animate(START_HEIGHT),
  width: new Animate(START_WIDTH),
  depth: new Animate(START_DEPTH),
  radius: new Animate(START_RADIUS),
  wall: new Animate(START_WALL),
  bottom: new Animate(START_BOTTOM),
};

DIMENSIONS.forEach((dim) =>
  modelDimensions[dim].addListener((val) => {
    animations[dim].startAnimationTo(val);
  }),
);

// Open front animations
const openFrontAnimations = {
  sideOffset: new Animate(START_OPEN_FRONT_SIDE_OFFSET),
  bottomOffset: new Animate(START_OPEN_FRONT_BOTTOM_OFFSET),
  cutoutRadius: new Animate(START_OPEN_FRONT_RADIUS),
};
let openFrontAnimEnabled = false;

openFrontEnabled.addListener((enabled) => {
  openFrontAnimEnabled = enabled;
  reloadModelNeeded = true;
});

openFrontDimensions.sideOffset.addListener((val) => {
  openFrontAnimations.sideOffset.startAnimationTo(val);
});
openFrontDimensions.bottomOffset.addListener((val) => {
  openFrontAnimations.bottomOffset.startAnimationTo(val);
});
openFrontDimensions.cutoutRadius.addListener((val) => {
  openFrontAnimations.cutoutRadius.startAnimationTo(val);
});

/// DOM

// Download button
const link = document.querySelector("a")!;

const controls = document.querySelector("#controls") as HTMLDivElement;

const levelsControl = stepper("levels", {
  label: "Levels",
  min: String(MIN_LEVELS),
  max: String(MAX_LEVELS),
});
controls.append(levelsControl);

const widthControl = rangeControl("width", {
  name: "Width",
  min: String(MIN_WIDTH - 2 * START_WALL /* convert from outer to inner */),
  max: String(MAX_WIDTH - 2 * START_WALL),
  sliderMin: String(MIN_WIDTH - 2 * START_WALL),
  sliderMax: "100",
});
controls.append(widthControl.wrapper);

const depthControl = rangeControl("depth", {
  name: "Depth",
  min: String(MIN_DEPTH - 2 * START_WALL /* convert from outer to inner */),
  max: String(MAX_DEPTH - 2 * START_WALL),
  sliderMin: String(MIN_DEPTH - 2 * START_WALL),
  sliderMax: "100",
});
controls.append(depthControl.wrapper);

// Advanced settings section
const advanced = advancedSettings("advanced");
controls.append(advanced.wrapper);

advanced.button.addEventListener("click", () => {
  const isHidden = advanced.content.style.display === "none";
  advanced.content.style.display = isHidden ? "" : "none";
  advanced.button.textContent = isHidden
    ? "Hide advanced settings"
    : "Show advanced settings";
});

// Corner radius slider (inside advanced settings)
const radiusControl = rangeControl("radius", {
  name: "Radius",
  min: String(MIN_RADIUS),
  max: String(MAX_RADIUS),
  sliderMin: String(MIN_RADIUS),
  sliderMax: String(MAX_RADIUS),
});
advanced.content.append(radiusControl.wrapper);

// Open front toggle (inside advanced settings)
const openFrontToggle = toggleControl("open-front", { label: "Front opening" });
advanced.content.append(openFrontToggle.wrapper);

// Open front sub-controls container
const openFrontSubControls = document.createElement("div");
openFrontSubControls.className = "open-front-sub-controls";
openFrontSubControls.style.display = "none";
advanced.content.append(openFrontSubControls);

const openFrontSideOffsetControl = rangeControl("open-front-side-offset", {
  name: "Side offset",
  min: String(MIN_OPEN_FRONT_OFFSET),
  max: "0",
  sliderMin: String(MIN_OPEN_FRONT_OFFSET),
  sliderMax: "0",
});
openFrontSubControls.append(openFrontSideOffsetControl.wrapper);

const openFrontBottomOffsetControl = rangeControl("open-front-bottom-offset", {
  name: "Bottom offset",
  min: String(MIN_OPEN_FRONT_OFFSET),
  max: "0",
  sliderMin: String(MIN_OPEN_FRONT_OFFSET),
  sliderMax: "0",
});
openFrontSubControls.append(openFrontBottomOffsetControl.wrapper);

const openFrontRadiusControl = rangeControl("open-front-radius", {
  name: "Radius",
  min: String(MIN_OPEN_FRONT_RADIUS),
  max: "0",
  sliderMin: String(MIN_OPEN_FRONT_RADIUS),
  sliderMax: "0",
});
openFrontSubControls.append(openFrontRadiusControl.wrapper);

// Wire open front toggle to show/hide sub-controls
openFrontToggle.input.addEventListener("change", () => {
  openFrontEnabled.send(openFrontToggle.input.checked);
  openFrontSubControls.style.display = openFrontToggle.input.checked
    ? ""
    : "none";
});

// The dimension inputs
const inputs = {
  levels: document.querySelector("#levels")! as HTMLInputElement,
  levelsPlus: document.querySelector("#levels-plus")! as HTMLButtonElement,
  levelsMinus: document.querySelector("#levels-minus")! as HTMLButtonElement,
  width: widthControl.input,
  widthRange: widthControl.range,
  depth: depthControl.input,
  depthRange: depthControl.range,
  radius: radiusControl.input,
  radiusRange: radiusControl.range,
  openFrontSideOffset: openFrontSideOffsetControl.input,
  openFrontSideOffsetRange: openFrontSideOffsetControl.range,
  openFrontBottomOffset: openFrontBottomOffsetControl.input,
  openFrontBottomOffsetRange: openFrontBottomOffsetControl.range,
  openFrontRadius: openFrontRadiusControl.input,
  openFrontRadiusRange: openFrontRadiusControl.range,
} as const;

// Add change events to all dimension inputs

// height/levels
([[inputs.levels, "change"]] as const).forEach(([input, evnt]) => {
  levels.addListener((levels) => {
    input.value = `${levels}`;
  });
  input.addEventListener(evnt, () => {
    const n = parseInt(input.value);
    if (!Number.isNaN(n))
      /* Clamp between min & max (currently synced manually with HTML) */
      levels.send(Math.max(MIN_LEVELS, Math.min(n, MAX_LEVELS)));
  });
});

inputs.levelsPlus.addEventListener("click", () => {
  const n = levels.latest + 1;
  levels.send(Math.max(MIN_LEVELS, Math.min(n, MAX_LEVELS)));
});
levels.addListener((n) => {
  inputs.levelsPlus.disabled = MAX_LEVELS <= n;
  inputs.levelsMinus.disabled = n <= MIN_LEVELS;
});

inputs.levelsMinus.addEventListener("click", () => {
  const n = levels.latest - 1;
  levels.send(Math.max(1, Math.min(n, 5)));
});

// width
(
  [
    [inputs.width, "change"],
    [inputs.widthRange, "input"],
  ] as const
).forEach(([input, evnt]) => {
  innerWidth.addListener((width) => {
    input.value = `${width}`;
  });
  input.addEventListener(evnt, () => {
    const outer = parseInt(input.value) + 2 * modelDimensions.wall.latest;
    if (!Number.isNaN(outer))
      modelDimensions.width.send(Math.max(outer, MIN_WIDTH));
  });
});

// depth
(
  [
    [inputs.depth, "change"],
    [inputs.depthRange, "input"],
  ] as const
).forEach(([input, evnt]) => {
  innerDepth.addListener((depth) => {
    input.value = `${depth}`;
  });
  input.addEventListener(evnt, () => {
    const outer = parseInt(input.value) + 2 * modelDimensions.wall.latest;
    if (!Number.isNaN(outer))
      modelDimensions.depth.send(Math.max(outer, MIN_DEPTH));
  });
});

// radius
(
  [
    [inputs.radius, "change"],
    [inputs.radiusRange, "input"],
  ] as const
).forEach(([input, evnt]) => {
  modelDimensions.radius.addListener((radius) => {
    input.value = `${radius}`;
  });
  input.addEventListener(evnt, () => {
    const val = parseInt(input.value);
    if (!Number.isNaN(val))
      modelDimensions.radius.send(
        Math.max(MIN_RADIUS, Math.min(val, MAX_RADIUS)),
      );
  });
});

// open front side offset
(
  [
    [inputs.openFrontSideOffset, "change"],
    [inputs.openFrontSideOffsetRange, "input"],
  ] as const
).forEach(([input, evnt]) => {
  openFrontDimensions.sideOffset.addListener((offset) => {
    input.value = `${offset}`;
  });
  input.addEventListener(evnt, () => {
    const val = parseInt(input.value);
    if (!Number.isNaN(val))
      openFrontDimensions.sideOffset.send(
        Math.max(MIN_OPEN_FRONT_OFFSET, Math.min(val, maxSideOffset.latest)),
      );
  });
});

// open front bottom offset
(
  [
    [inputs.openFrontBottomOffset, "change"],
    [inputs.openFrontBottomOffsetRange, "input"],
  ] as const
).forEach(([input, evnt]) => {
  openFrontDimensions.bottomOffset.addListener((offset) => {
    input.value = `${offset}`;
  });
  input.addEventListener(evnt, () => {
    const val = parseInt(input.value);
    if (!Number.isNaN(val))
      openFrontDimensions.bottomOffset.send(
        Math.max(MIN_OPEN_FRONT_OFFSET, Math.min(val, maxBottomOffset.latest)),
      );
  });
});

// open front cutout radius
(
  [
    [inputs.openFrontRadius, "change"],
    [inputs.openFrontRadiusRange, "input"],
  ] as const
).forEach(([input, evnt]) => {
  openFrontDimensions.cutoutRadius.addListener((r) => {
    input.value = `${r}`;
  });
  input.addEventListener(evnt, () => {
    const val = parseInt(input.value);
    if (!Number.isNaN(val))
      openFrontDimensions.cutoutRadius.send(
        Math.max(MIN_OPEN_FRONT_RADIUS, Math.min(val, maxCutoutRadius.latest)),
      );
  });
});

// Dynamic max listeners for slider/input elements
maxSideOffset.addListener((max) => {
  const s = String(max);
  inputs.openFrontSideOffset.max = s;
  inputs.openFrontSideOffsetRange.max = s;
  inputs.openFrontSideOffsetRange.value = String(openFrontDimensions.sideOffset.latest);
});
maxBottomOffset.addListener((max) => {
  const s = String(max);
  inputs.openFrontBottomOffset.max = s;
  inputs.openFrontBottomOffsetRange.max = s;
  inputs.openFrontBottomOffsetRange.value = String(openFrontDimensions.bottomOffset.latest);
});
maxCutoutRadius.addListener((max) => {
  const s = String(max);
  inputs.openFrontRadius.max = s;
  inputs.openFrontRadiusRange.max = s;
  inputs.openFrontRadiusRange.value = String(openFrontDimensions.cutoutRadius.latest);
});

// Add select-all on input click
(["levels", "width", "depth", "radius", "openFrontSideOffset", "openFrontBottomOffset", "openFrontRadius"] as const).forEach((dim) => {
  const input = inputs[dim];
  input.addEventListener("focus", () => {
    input.select();
  });
});

/* Extract X & Y from event (offsetX/Y) */
const eventCoords = (e: MouseEvent | TouchEvent): [number, number] => {
  // Simple case of a mouse event
  if (e instanceof MouseEvent) {
    return [e.offsetX, e.offsetY];
  }

  // Now, try to extract values similar to offsetXY from a TouchEvent, if possible
  const target = e.target;
  if (!target) {
    console.warn("Event doesn't have target", e);
    return [0, 0];
  }

  if (!(target instanceof HTMLElement)) {
    console.warn("Event target is not an element", e);
    return [0, 0];
  }

  const rect = target.getBoundingClientRect();
  const x = e.targetTouches[0].clientX - rect.x;
  const y = e.targetTouches[0].clientY - rect.y;
  return [x, y];
};

/* Get ready on first touchdown */

const readyMouseTarget = canvas;
const readyMouseEvents = ["mousedown", "touchstart"] as const;
const readyMouse = (e: MouseEvent | TouchEvent) => {
  renderer.render();

  const [x, y] = eventCoords(e);
  const [r, g, b, a] = renderer.getCanvasPixelColor([x, y]);

  // The outline rendering renders transparent pixels outside of the part
  // So if it's transparent, assume the user didn't want to touch/rotate the part
  if (r === 0 && g === 0 && b === 0 && a === 0) {
    return;
  }

  e.preventDefault(); // Prevent from scrolling the page while moving the part
  partPositioning.update((val) => {
    if (val.tag === "will-move" || val.tag === "moving") {
      return val;
    } else {
      const clock = new THREE.Clock();
      clock.start();
      return {
        tag: "will-move",
        startRot: rotation.current,
        startPos: [x, y],
        clock,
        lastStatic: val,
      };
    }
  });

  trackMouseEvents.forEach((evt) =>
    trackMouseTarget.addEventListener(evt, trackMouse, { passive: false }),
  );
  forgetMouseEvents.forEach((evt) =>
    forgetMouseTarget.addEventListener(evt, forgetMouse),
  );
};

readyMouseEvents.forEach((evt) =>
  readyMouseTarget.addEventListener(evt, readyMouse),
);

/* Start tracking mouse mouvement across the window */
const trackMouseTarget = window;
const trackMouseEvents = ["mousemove", "touchmove"] as const;
const trackMouse = (e: MouseEvent | TouchEvent) => {
  const [x] = eventCoords(e);

  partPositioning.update((val) => {
    if (val.tag === "will-move" || val.tag === "moving") {
      return {
        tag: "moving",
        x,

        startPos: val.startPos,
        startRot: val.startRot,
        lastStatic: val.lastStatic,
        clock: val.clock,
      };
    }

    // This is technically not possible, unless the browser sends events
    // in incorrect order
    val.tag satisfies "static";
    return val;
  });
};

const forgetMouseTarget = window;
const forgetMouseEvents = ["mouseup", "touchend"] as const;
const forgetMouse = () => {
  trackMouseEvents.forEach((evt) =>
    trackMouseTarget.removeEventListener(evt, trackMouse),
  );
  forgetMouseEvents.forEach((evt) =>
    forgetMouseTarget.removeEventListener(evt, forgetMouse),
  );

  /* toggle static positioning between front & back */
  const toggle = (p: PartPositionStatic): PartPositionStatic =>
    ({
      [-1]: { tag: "static", position: 0 } as const,
      [0]: { tag: "static", position: 1 } as const,
      [1]: { tag: "static", position: 0 } as const,
    })[p.position];

  partPositioning.update((was) => {
    if (was.tag === "will-move") {
      // Mouse was down but didn't move, assume toggle
      return toggle(was.lastStatic);
    } else if (was.tag === "static") {
      // Mouse was down and up, i.e. "clicked", toggle
      return toggle(was);
    } else {
      // Mouse has moved
      was.tag satisfies "moving";

      // If the move was too short, assume toggle (jerk)
      const elapsed = was.clock.getElapsedTime();
      const delta = Math.abs(was.x - was.startPos[0]);
      if (elapsed < 0.3 && delta < 15) {
        return toggle(was.lastStatic);
      }

      // Snap part to one of the static positions
      const rounded = Math.round(bound(rotation.current, [-1, 1]));
      if (rounded <= -1) {
        return { tag: "static", position: -1 };
      } else if (1 <= rounded) {
        return { tag: "static", position: 1 };
      } else {
        return { tag: "static", position: 0 };
      }
    }
  });
};

/// LOOP

// Set to current frame's timestamp when a model starts loading, and set
// to undefined when the model has finished loading
let modelLoadStarted: undefined | DOMHighResTimeStamp;

function loop(nowMillis: DOMHighResTimeStamp) {
  requestAnimationFrame(loop);

  // Reload 3mf if necessary
  const newTmf = tmfLoader.take();
  if (newTmf !== undefined) {
    // Update the download link
    link.href = URL.createObjectURL(newTmf.blob);
    link.download = newTmf.filename;
  }

  // Handle rotation animation
  const rotationUpdated = rotation.update();
  if (rotationUpdated) {
    mesh.rotation.z = rotation.current * Math.PI + MESH_ROTATION_DELTA;
  }

  // Handle dimensions animation
  const openFrontAnimUpdated =
    openFrontAnimations.sideOffset.update() ||
    openFrontAnimations.bottomOffset.update() ||
    openFrontAnimations.cutoutRadius.update();

  const dimensionsUpdated =
    DIMENSIONS.reduce(
      (acc, dim) => animations[dim].update() || acc,
      false,
    ) || openFrontAnimUpdated;

  if (dimensionsUpdated) {
    reloadModelNeeded = true;
  }

  // Whether we should start loading a new model on this frame
  // True if (1) model needs reloading and (2) no model is currently loading (or
  // if loading seems stuck)
  const reloadModelNow =
    reloadModelNeeded &&
    (modelLoadStarted === undefined || nowMillis - modelLoadStarted > 100);

  if (reloadModelNow) {
    modelLoadStarted = nowMillis;
    reloadModelNeeded = false;
    reloadModel(
      animations["height"].current,
      animations["width"].current,
      animations["depth"].current,
      animations["radius"].current,
      animations["wall"].current,
      animations["bottom"].current,
      openFrontAnimEnabled
        ? {
            sideOffset: openFrontAnimations.sideOffset.current,
            bottomOffset: openFrontAnimations.bottomOffset.current,
            cutoutRadius: openFrontAnimations.cutoutRadius.current,
          }
        : undefined,
    ).then(() => {
      modelLoadStarted = undefined;
      centerCameraNeeded = true;
    });
  }

  const canvasResized = renderer.resizeCanvas();

  if (canvasResized) {
    centerCameraNeeded = true;
  }

  if (centerCameraNeeded) {
    centerCamera();
    centerCameraNeeded = false;
  }

  renderer.render();
}

// performance.now() is equivalent to the timestamp supplied by
// requestAnimationFrame
//
// https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
loop(performance.now());
