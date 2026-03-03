# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SKÅPA is a browser-based tool that generates parametric 3D-printable containers for IKEA SKÅDIS pegboards. Users customize dimensions interactively, preview a live 3D render styled like an IKEA assembly manual, and download .3MF files for slicing. Runs entirely client-side at https://skapa.build.

## Commands

```bash
npm run dev        # Vite dev server with hot reload
npm run build      # Type-check (tsc) + Vite production build -> dist/
npm run tsc        # Type-check only (no emit)
npm run format     # Prettier on src/ and index.html
```

No test framework is installed.

## Architecture

**Reactive state (`Dyn<T>` from twrl):** All mutable state lives in `Dyn<T>` reactive cells. Update with `.send(value)`, subscribe with `.addListener(fn)`, derive with `.map()` and `Dyn.sequence([...]).map(...)`. No virtual DOM — listeners directly mutate geometry, animations, and DOM.

**Render loop (`src/main.ts`):** A single `requestAnimationFrame` loop that each frame: updates all `Animate` instances (tweened numeric values with easing), recomputes geometry if dimensions changed, handles canvas resize, recenters the orthographic camera, and calls `renderer.render()`.

**Geometry generation (`src/model/manifold.ts`):** Pure CSG using manifold-3d (WASM). A rounded-rectangle cross-section is extruded for the outer shell, an inner shell is subtracted to hollow it, a swept cutout is subtracted for open-front mode, and SKÅDIS clips are unioned to the back wall. The WASM module loads once via a lazy singleton.

**Rendering pipeline (`src/rendering/`):** Three.js with orthographic camera and a custom EffectComposer chain: RenderOutlinePass (normals+depth → Sobel edge detection → black outlines on white), ThickenPass (disc-kernel dilation), OutputPass (tone-mapping), FXAAPass (anti-aliasing).

**Export (`src/model/export.ts`):** Converts manifold meshes to .3MF blobs via @jscadui/3mf-export. `TMFLoader` queues conversion asynchronously so the render loop isn't blocked.

**Controls (`src/controls.tsx`):** JSX via twrl creates real DOM elements (not VDOM). Elements are created once and wired imperatively in main.ts.

**Animation (`src/animate.ts`):** `Animate` class wraps a numeric value with `startAnimationTo(target, easingFn)` and `update()`. Uses easeInOutCubic by default. All animated values are polled each frame.

## Key Conventions

- TypeScript strict mode with `noUnusedLocals` and `noUnusedParameters`
- Path alias `@src/*` → `src/*` available but currently unused
- GLSL shaders imported as raw strings via Vite's `?raw` suffix
- WASM loaded via Vite's `?url` suffix (`manifold.wasm?url`)
- CI deploys to GitHub Pages on push to main (`.github/workflows/deploy.yml`)

## Open Front Feature (src/model/manifold.ts)

The "front opening" cuts a U-shaped channel through the box walls, allowing items to be scooped out. It works in three stages:

### 1. 2D Cross-Section (`frontCutoutCrossSection`)
Creates a U-shaped polygon in **contour space** (X = distance along box perimeter from front-face center, Y = height). Parameters:
- `halfExtent_R/L` — how far the opening reaches along the perimeter on each side (asymmetric because corner radii can differ per-corner). Computed as `openness * effectiveMax` where effectiveMax accounts for clip clearance.
- `bottom + bottomOffset` — base of the U
- `cutoutRadius` — fillet radius on the two bottom corners of the U
- `topR` — concave fillet where the U meets the top edge (flares outward so the cut cleans up at the rim)
- A "chimney" rectangle extends past the box top by `BOOLEAN_OVERSHOOT` for clean CSG subtraction

### 2. Extrude and Position
The 2D cross-section is extruded along Z by `wall + 2 * BOOLEAN_OVERSHOOT`, then rotated 90° around X and translated to sit against the front face. At this point it's a flat slab.

### 3. Warp to Follow Box Contour
When the opening extends beyond the flat front face (i.e. wraps around corners), the mesh is refined (`refineToLength(2)`) and a `warp()` function remaps each vertex from flat contour-space into 3D positions along the box perimeter. Five regions per side, selected by |x|:

| Region | Range | Transform |
|--------|-------|-----------|
| 1. Front flat | `|x| <= flatBound` | Identity (no change) |
| 2. Front corner arc | `flatBound < |x| <= arcEnd` | Cylindrical bend: `theta = (|x| - flatBound) / frontR`, vertex orbits around corner center at `(flatBound, cornerCY)` |
| 3. Side flat | `arcEnd < |x| <= sideEnd` | Linear translation along side wall (direction flips when `sideFlat < 0`, i.e. when front+back radii overlap) |
| 4. Back corner arc | `sideEnd < |x| <= backArcEnd` | Cylindrical bend around back corner center |
| 5. Back flat | `|x| > backArcEnd` | Linear translation along back wall |

Each side (x >= 0, x < 0) uses independent parameters derived from per-corner radii. The `rLocal` variable represents the radial distance from the corner center, preventing degenerate triangles with a 0.01 clamp.

### Clip Safety (`box()` function)
`backFlatAllowance_R/L` limits how far the cutout can wrap toward the back wall so it doesn't intersect SKÅDIS clips. Calculated as: `warpFlatBound - outerClipX - 1mm clearance`, where `outerClipX` is the outer edge of the furthest clip column (using 2.45mm clip wall-surface footprint).
